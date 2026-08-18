package main

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestServiceBindingUsesOmniraFlags(t *testing.T) {
	t.Setenv("PORT", "")
	binding := parseServiceBinding([]string{"--port=54321", "--host", "127.0.0.1", "--open=false"})
	if binding.port != "54321" || binding.host != "127.0.0.1" {
		t.Fatalf("unexpected binding: %#v", binding)
	}
}

func TestEmbeddedStandaloneArchive(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		if len(standaloneArchive) != 0 {
			t.Fatal("unsupported platform unexpectedly embeds the standalone runtime")
		}
		return
	}
	if len(standaloneArchive) < 1<<20 {
		t.Fatalf("standalone archive is unexpectedly small: %d bytes", len(standaloneArchive))
	}
	reader, err := zip.NewReader(bytes.NewReader(standaloneArchive), int64(len(standaloneArchive)))
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.File) != 1 || reader.File[0].Name != "paperclip-entity-darwin-arm64" {
		t.Fatalf("unexpected archive contents: %#v", reader.File)
	}
}

func TestExtractStandaloneCreatesExecutable(t *testing.T) {
	if len(standaloneArchive) == 0 {
		t.Skip("standalone runtime is not packaged for this platform")
	}
	destination := filepath.Join(t.TempDir(), "paperclip")
	if err := extractStandalone(destination); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < 1<<20 || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("bad extracted executable: size=%d mode=%o", info.Size(), info.Mode().Perm())
	}
}

func TestConfigureEntityEnvironmentLoadsProtectedKeyFile(t *testing.T) {
	for _, key := range []string{
		"OMNIRA_ENTITY_URL",
		"OMNIRA_ENTITY_OWNER_ID",
		"OMNIRA_ENTITY_NAMESPACE",
		"OMNIRA_ENTITY_API_KEY",
		"PAPERCLIP_STORAGE_BACKEND",
		"PAPERCLIP_DEPLOYMENT_EXPOSURE",
	} {
		t.Setenv(key, "")
	}
	keyPath := filepath.Join(t.TempDir(), "entity-key")
	if err := os.WriteFile(keyPath, []byte("test-paperclip-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := configureEntityEnvironment(keyPath); err != nil {
		t.Fatal(err)
	}
	checks := map[string]string{
		"OMNIRA_ENTITY_URL":             defaultEntityURL,
		"OMNIRA_ENTITY_OWNER_ID":        defaultEntityOwnerID,
		"OMNIRA_ENTITY_NAMESPACE":       defaultEntityNamespace,
		"OMNIRA_ENTITY_API_KEY":         "test-paperclip-key",
		"PAPERCLIP_STORAGE_BACKEND":     "omnira-entity",
		"PAPERCLIP_DEPLOYMENT_EXPOSURE": "public",
	}
	for key, want := range checks {
		if got := os.Getenv(key); got != want {
			t.Fatalf("%s=%q want %q", key, got, want)
		}
	}
}

func TestConfigureEntityEnvironmentPrefersInjectedKey(t *testing.T) {
	t.Setenv("OMNIRA_ENTITY_API_KEY", "injected-key")
	if err := configureEntityEnvironment(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OMNIRA_ENTITY_API_KEY"); got != "injected-key" {
		t.Fatalf("injected key was replaced: %q", got)
	}
}

func TestGatewayServesBootstrapThenProxies(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(response, "strict runtime "+request.URL.Path)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	ready := &atomic.Bool{}
	handler := newGatewayHandler(target, ready)

	bootstrap := httptest.NewRecorder()
	handler.ServeHTTP(bootstrap, httptest.NewRequest(http.MethodGet, "/_omnira/storage", nil))
	if bootstrap.Code != http.StatusServiceUnavailable || !strings.Contains(bootstrap.Body.String(), "strict-entity-only") {
		t.Fatalf("unexpected bootstrap response: %d %s", bootstrap.Code, bootstrap.Body.String())
	}

	ready.Store(true)
	proxied := httptest.NewRecorder()
	handler.ServeHTTP(proxied, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if proxied.Code != http.StatusOK || proxied.Body.String() != "strict runtime /api/health" {
		t.Fatalf("unexpected proxied response: %d %s", proxied.Code, proxied.Body.String())
	}
}
