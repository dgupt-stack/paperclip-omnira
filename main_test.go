package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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
