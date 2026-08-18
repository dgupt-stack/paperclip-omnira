package main

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestServiceBindingUsesOmniraFlags(t *testing.T) {
	t.Setenv("PORT", "")
	binding := parseServiceBinding([]string{"--port=54321", "--host", "127.0.0.1", "--open=false"})
	if binding.port != "54321" || binding.host != "127.0.0.1" {
		t.Fatalf("unexpected binding: %#v", binding)
	}
}

func TestBootstrapServerAnswersImmediately(t *testing.T) {
	bootstrapMessage.Store("Preparing test runtime")
	server, err := startBootstrapServer(serviceBinding{host: "127.0.0.1", port: "0"})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	address := serverAddr(t, server)
	response, err := http.Get("http://" + address + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %s", response.Status)
	}
}

func serverAddr(t *testing.T, server *http.Server) string {
	// The listener address is intentionally surfaced through the server's test
	// hook so the production API can stay minimal.
	address, ok := bootstrapAddresses.Load(server)
	if !ok {
		t.Fatal("bootstrap listener address missing")
	}
	return address.(string)
}

func TestEmbeddedAppExtracts(t *testing.T) {
	destination := t.TempDir()
	if err := extractApp(destination); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"server.mjs", "package.json", "package-lock.json", filepath.Join("lib", "entity-store.mjs")} {
		if _, err := os.Stat(filepath.Join(destination, path)); err != nil {
			t.Fatalf("expected embedded %s: %v", path, err)
		}
	}
}

func TestBundleDigestIsStable(t *testing.T) {
	first, err := bundleDigest()
	if err != nil {
		t.Fatal(err)
	}
	second, err := bundleDigest()
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) != 16 {
		t.Fatalf("unexpected digest: %q / %q", first, second)
	}
}

func TestInstallEnvironmentExcludesServiceSecrets(t *testing.T) {
	t.Setenv("OMNIRA_ENTITY_API_KEY", "must-not-leak")
	for _, entry := range installEnvironment() {
		if strings.HasPrefix(entry, "OMNIRA_ENTITY_API_KEY=") {
			t.Fatal("service key leaked into dependency installer environment")
		}
	}
}

func TestBunAssetSupportsOmniraPlatforms(t *testing.T) {
	asset, checksum, err := bunAsset()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if err == nil {
			t.Fatal("expected unsupported-platform error")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(asset, ".zip") || len(checksum) != 64 {
		t.Fatalf("invalid fallback metadata: %q %q", asset, checksum)
	}
}
