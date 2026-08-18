package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

type serviceBinding struct {
	host string
	port string
}

const (
	defaultEntityURL        = "https://entityservice-k4u67azzg5.app.omnira.dev"
	defaultEntityOwnerID    = "5695892345266999354"
	defaultEntityNamespace  = "paperclip"
	defaultEntityAPIKeyPath = "/Users/djgupt/api-keys/paperclip-omnira-entity-key.txt"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[paperclip-entity-launcher] %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	binding := parseServiceBinding(os.Args[1:])
	if len(standaloneArchive) == 0 {
		return fmt.Errorf("strict Entity-only Paperclip is not packaged for this platform")
	}
	if err := os.Setenv("PORT", binding.port); err != nil {
		return fmt.Errorf("set service port: %w", err)
	}
	if err := configureEntityEnvironment(defaultEntityAPIKeyPath); err != nil {
		return err
	}

	// Replace the Omnira service process before opening the public port. Once a
	// service starts listening, the runner removes its writable launch sandbox;
	// exec first so the strict runtime is already mapped into the root process.
	temporaryDir, err := os.MkdirTemp("", ".paperclip-entity-runtime-")
	if err != nil {
		return fmt.Errorf("create transient runtime directory: %w", err)
	}
	defer os.RemoveAll(temporaryDir)
	executablePath := filepath.Join(temporaryDir, "paperclip-entity")
	if err := extractStandalone(executablePath); err != nil {
		return err
	}

	if err := os.Setenv("PAPERCLIP_LAUNCHER_MANAGED", "1"); err != nil {
		return fmt.Errorf("mark managed launcher: %w", err)
	}
	if err := os.Unsetenv("PAPERCLIP_LISTEN_FD"); err != nil {
		return fmt.Errorf("clear inherited listener: %w", err)
	}
	return syscall.Exec(executablePath, []string{executablePath}, os.Environ())
}

func configureEntityEnvironment(apiKeyPath string) error {
	defaults := map[string]string{
		"OMNIRA_ENTITY_URL":             defaultEntityURL,
		"OMNIRA_ENTITY_OWNER_ID":        defaultEntityOwnerID,
		"OMNIRA_ENTITY_NAMESPACE":       defaultEntityNamespace,
		"PAPERCLIP_STORAGE_BACKEND":     "omnira-entity",
		"PAPERCLIP_DEPLOYMENT_EXPOSURE": "public",
	}
	for key, value := range defaults {
		if strings.TrimSpace(os.Getenv(key)) == "" {
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}
	if strings.TrimSpace(os.Getenv("OMNIRA_ENTITY_API_KEY")) != "" {
		return nil
	}
	rawKey, err := os.ReadFile(apiKeyPath)
	if err != nil {
		return fmt.Errorf("strict Entity-only credential is unavailable: %w", err)
	}
	apiKey := strings.TrimSpace(string(rawKey))
	if apiKey == "" {
		return fmt.Errorf("strict Entity-only credential file is empty")
	}
	if err := os.Setenv("OMNIRA_ENTITY_API_KEY", apiKey); err != nil {
		return fmt.Errorf("set strict Entity-only credential: %w", err)
	}
	return nil
}

func availableLoopbackPort() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("reserve child service port: %w", err)
	}
	defer listener.Close()
	return fmt.Sprint(listener.Addr().(*net.TCPAddr).Port), nil
}

func startGateway(binding serviceBinding, childPort string, childReady *atomic.Bool) (*http.Server, error) {
	target, err := url.Parse("http://" + net.JoinHostPort("127.0.0.1", childPort))
	if err != nil {
		return nil, fmt.Errorf("configure child service proxy: %w", err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(binding.host, binding.port))
	if err != nil {
		return nil, fmt.Errorf("listen for Omnira traffic: %w", err)
	}
	server := &http.Server{
		Handler:           newGatewayHandler(target, childReady),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "[paperclip-entity-launcher] gateway: %v\n", serveErr)
		}
	}()
	return server, nil
}

func newGatewayHandler(target *url.URL, childReady *atomic.Bool) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if childReady.Load() {
			proxy.ServeHTTP(response, request)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		if request.URL.Path == "/_omnira/storage" {
			response.Header().Set("Content-Type", "application/json; charset=utf-8")
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(response, `{"ok":false,"mode":"strict-entity-only","phase":"initializing","detail":"Restoring Entity snapshot and migrating in-memory PostgreSQL"}`)
			return
		}
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(response, `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Paperclip is starting</title><style>body{font:16px/1.5 system-ui;margin:0;background:#f6f3ec;color:#29261f}main{max-width:680px;margin:10vh auto;padding:40px;border:1px solid #d8d3c8;border-radius:18px;background:white}p{color:#625d52}</style><main><h1>Paperclip is starting</h1><p>Restoring the Omnira Entity snapshot and migrating in-memory PostgreSQL. This page refreshes automatically.</p></main></html>`)
	})
}

func waitForChildReady(port string, waitResult <-chan error, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	address := net.JoinHostPort("127.0.0.1", port)
	for {
		select {
		case err := <-waitResult:
			if err == nil {
				return fmt.Errorf("Paperclip exited before reporting readiness")
			}
			return fmt.Errorf("Paperclip exited before reporting readiness: %w", err)
		case <-ticker.C:
			connection, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
			if err == nil {
				_ = connection.Close()
				return nil
			}
		case <-deadline.C:
			return fmt.Errorf("Paperclip did not report readiness within %s", timeout)
		}
	}
}

func extractStandalone(destination string) error {
	reader, err := zip.NewReader(bytes.NewReader(standaloneArchive), int64(len(standaloneArchive)))
	if err != nil {
		return fmt.Errorf("open embedded Paperclip executable: %w", err)
	}
	if len(reader.File) != 1 || reader.File[0].FileInfo().IsDir() {
		return fmt.Errorf("embedded Paperclip archive must contain exactly one executable")
	}
	input, err := reader.File[0].Open()
	if err != nil {
		return fmt.Errorf("open Paperclip executable in archive: %w", err)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return fmt.Errorf("create Paperclip executable: %w", err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return fmt.Errorf("extract Paperclip executable: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close Paperclip executable: %w", closeErr)
	}
	return nil
}

func parseServiceBinding(args []string) serviceBinding {
	binding := serviceBinding{host: "0.0.0.0", port: strings.TrimSpace(os.Getenv("PORT"))}
	if binding.port == "" {
		binding.port = "3100"
	}
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case strings.HasPrefix(argument, "--port="):
			binding.port = strings.TrimPrefix(argument, "--port=")
		case argument == "--port" && index+1 < len(args):
			index++
			binding.port = args[index]
		case strings.HasPrefix(argument, "--host="):
			binding.host = strings.TrimPrefix(argument, "--host=")
		case argument == "--host" && index+1 < len(args):
			index++
			binding.host = args[index]
		}
	}
	return binding
}
