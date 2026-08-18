package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
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

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[paperclip-entity-launcher] %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	binding := parseServiceBinding(os.Args[1:])
	if err := os.Setenv("PORT", binding.port); err != nil {
		return fmt.Errorf("set service port: %w", err)
	}
	if len(standaloneArchive) == 0 {
		return fmt.Errorf("strict Entity-only Paperclip is not packaged for this platform")
	}

	temporaryDir, err := os.MkdirTemp("", "paperclip-entity-launcher-")
	if err != nil {
		return fmt.Errorf("create temporary runtime directory: %w", err)
	}
	defer os.RemoveAll(temporaryDir)
	executablePath := filepath.Join(temporaryDir, "paperclip-entity")
	if err := extractStandalone(executablePath); err != nil {
		return err
	}

	cmd := exec.Command(executablePath)
	cmd.Env = append(os.Environ(), "PAPERCLIP_LAUNCHER_MANAGED=1")
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start strict Entity-only Paperclip: %w", err)
	}
	waitResult := make(chan error, 1)
	go func() { waitResult <- cmd.Wait() }()
	if err := waitForChildReady(binding.port, waitResult, 90*time.Second); err != nil {
		_ = cmd.Process.Kill()
		return err
	}

	// Paperclip reports readiness only after PGlite, migrations, auth, and every
	// embedded UI asset are in memory. Unlink the executable immediately then:
	// the edge runner has no runtime directory to delete out from under it.
	if err := os.Remove(executablePath); err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("unlink temporary Paperclip executable: %w", err)
	}
	if err := os.Remove(temporaryDir); err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("remove temporary runtime directory: %w", err)
	}

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan struct{})
	var forwardedSignal atomic.Bool
	go func() {
		select {
		case incoming := <-signals:
			forwardedSignal.Store(true)
			_ = cmd.Process.Signal(incoming)
		case <-done:
		}
	}()
	err = <-waitResult
	close(done)
	if err != nil {
		if forwardedSignal.Load() {
			return nil
		}
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return fmt.Errorf("Paperclip exited with status %d", exitError.ExitCode())
		}
		return fmt.Errorf("wait for Paperclip: %w", err)
	}
	return nil
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
