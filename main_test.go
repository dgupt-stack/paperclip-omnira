package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"runtime"
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
