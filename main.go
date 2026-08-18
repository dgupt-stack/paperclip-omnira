package main

import (
	"archive/zip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	bunVersion      = "1.2.21"
	maxRuntimeBytes = 200 << 20
	launcherDirName = ".paperclip-omnira-launcher"
	installMarker   = ".install-complete"
)

// appBundle is intentionally limited to the production wrapper. npm installs
// the platform-specific dependencies on the device before the first launch.
//
//go:embed app/server.mjs app/package.json app/package-lock.json app/lib/*.mjs
var appBundle embed.FS

type jsRuntime struct {
	executable string
	install    func(string) error
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[paperclip-launcher] %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cacheRoot, err := launcherCacheRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return fmt.Errorf("create launcher cache: %w", err)
	}

	runtimeJS, err := discoverRuntime(cacheRoot)
	if err != nil {
		return err
	}
	appDir, err := ensureApp(cacheRoot, runtimeJS)
	if err != nil {
		return err
	}

	serverPath := filepath.Join(appDir, "server.mjs")
	argv := []string{runtimeJS.executable, serverPath}
	env := append(os.Environ(), "PAPERCLIP_LAUNCHER_MANAGED=1")
	if err := os.Chdir(appDir); err != nil {
		return fmt.Errorf("enter app runtime: %w", err)
	}

	fmt.Printf("[paperclip-launcher] starting Paperclip with %s\n", filepath.Base(runtimeJS.executable))
	return syscall.Exec(runtimeJS.executable, argv, env)
}

func launcherCacheRoot() (string, error) {
	if override := strings.TrimSpace(os.Getenv("PAPERCLIP_LAUNCHER_CACHE_DIR")); override != "" {
		return filepath.Abs(override)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, launcherDirName), nil
}

func discoverRuntime(cacheRoot string) (jsRuntime, error) {
	if nodePath, err := exec.LookPath("node"); err == nil && nodeMajor(nodePath) >= 20 {
		if npmPath, npmErr := exec.LookPath("npm"); npmErr == nil {
			return jsRuntime{
				executable: nodePath,
				install: func(appDir string) error {
					return runInstall(appDir, npmPath, "ci", "--omit=dev", "--no-audit", "--no-fund")
				},
			}, nil
		}
	}

	bunPath, err := ensureBun(cacheRoot)
	if err != nil {
		return jsRuntime{}, fmt.Errorf("Node.js 20+ is unavailable and Bun fallback failed: %w", err)
	}
	return jsRuntime{
		executable: bunPath,
		install: func(appDir string) error {
			return runInstall(appDir, bunPath, "install", "--production", "--no-save")
		},
	}, nil
}

func nodeMajor(nodePath string) int {
	output, err := exec.Command(nodePath, "--version").Output()
	if err != nil {
		return 0
	}
	value := strings.TrimSpace(strings.TrimPrefix(string(output), "v"))
	major, _ := strconv.Atoi(strings.SplitN(value, ".", 2)[0])
	return major
}

func runInstall(appDir, executable string, args ...string) error {
	fmt.Printf("[paperclip-launcher] installing production dependencies with %s\n", filepath.Base(executable))
	cmd := exec.Command(executable, args...)
	cmd.Dir = appDir
	cmd.Env = installEnvironment()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("install production dependencies: %w", err)
	}
	return nil
}

func installEnvironment() []string {
	allowed := map[string]bool{
		"HOME": true, "PATH": true, "TMPDIR": true, "TMP": true, "TEMP": true,
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
		"http_proxy": true, "https_proxy": true, "no_proxy": true,
		"SSL_CERT_FILE": true, "SSL_CERT_DIR": true, "NPM_CONFIG_CACHE": true,
	}
	result := make([]string, 0, len(allowed))
	for _, entry := range os.Environ() {
		name, _, found := strings.Cut(entry, "=")
		if found && allowed[name] {
			result = append(result, entry)
		}
	}
	return result
}

func ensureApp(cacheRoot string, runtimeJS jsRuntime) (string, error) {
	bundleID, err := bundleDigest()
	if err != nil {
		return "", err
	}
	finalDir := filepath.Join(cacheRoot, "app-"+bundleID)
	if markerMatches(finalDir, bundleID) {
		return finalDir, nil
	}

	stagingDir := fmt.Sprintf("%s.installing-%d", finalDir, os.Getpid())
	_ = os.RemoveAll(stagingDir)
	defer os.RemoveAll(stagingDir)
	if err := extractApp(stagingDir); err != nil {
		return "", err
	}
	if err := runtimeJS.install(stagingDir); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, installMarker), []byte(bundleID+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write install marker: %w", err)
	}

	if err := os.Rename(stagingDir, finalDir); err != nil {
		if markerMatches(finalDir, bundleID) {
			return finalDir, nil
		}
		return "", fmt.Errorf("activate app runtime: %w", err)
	}
	return finalDir, nil
}

func markerMatches(appDir, bundleID string) bool {
	marker, err := os.ReadFile(filepath.Join(appDir, installMarker))
	return err == nil && strings.TrimSpace(string(marker)) == bundleID
}

func bundleDigest() (string, error) {
	var paths []string
	err := fs.WalkDir(appBundle, "app", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("inspect embedded app: %w", err)
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, path := range paths {
		body, readErr := appBundle.ReadFile(path)
		if readErr != nil {
			return "", fmt.Errorf("read embedded %s: %w", path, readErr)
		}
		_, _ = io.WriteString(hash, path+"\x00")
		_, _ = hash.Write(body)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16], nil
}

func extractApp(destination string) error {
	return fs.WalkDir(appBundle, "app", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel("app", path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		body, err := appBundle.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o600)
	})
}

func ensureBun(cacheRoot string) (string, error) {
	asset, checksum, err := bunAsset()
	if err != nil {
		return "", err
	}
	toolDir := filepath.Join(cacheRoot, "bun-"+bunVersion, runtime.GOOS+"-"+runtime.GOARCH)
	bunPath := filepath.Join(toolDir, "bun")
	if info, statErr := os.Stat(bunPath); statErr == nil && info.Mode().IsRegular() {
		return bunPath, nil
	}

	if err := os.MkdirAll(filepath.Dir(toolDir), 0o700); err != nil {
		return "", err
	}
	zipPath := fmt.Sprintf("%s.download-%d.zip", toolDir, os.Getpid())
	stagingDir := fmt.Sprintf("%s.installing-%d", toolDir, os.Getpid())
	defer os.Remove(zipPath)
	defer os.RemoveAll(stagingDir)

	url := fmt.Sprintf("https://github.com/oven-sh/bun/releases/download/bun-v%s/%s", bunVersion, asset)
	if err := downloadVerified(url, zipPath, checksum); err != nil {
		return "", err
	}
	extracted, err := unzipBun(zipPath, stagingDir)
	if err != nil {
		return "", err
	}
	if err := os.Chmod(extracted, 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(extracted, filepath.Join(stagingDir, "bun")); err != nil && !os.IsExist(err) {
		return "", err
	}
	if err := os.Rename(stagingDir, toolDir); err != nil {
		if info, statErr := os.Stat(bunPath); statErr == nil && info.Mode().IsRegular() {
			return bunPath, nil
		}
		return "", err
	}
	return bunPath, nil
}

func bunAsset() (string, string, error) {
	key := runtime.GOOS + "/" + runtime.GOARCH
	assets := map[string][2]string{
		"darwin/arm64": {"bun-darwin-aarch64.zip", "fd886630ba15c484236ad5f3f22b255d287c3eef8d3bc26fc809851035c04cec"},
		"darwin/amd64": {"bun-darwin-x64.zip", "d84602f55bf72c45d5733e59c511c88598509fb44213ef0713a96a020d2b5f85"},
		"linux/arm64":  {"bun-linux-aarch64.zip", "0e4c9e54876a160e91812ae3c62d36cfbd68f20e158cb732f63a0d6b7594287b"},
		"linux/amd64":  {"bun-linux-x64.zip", "594f454d51ce57199d4320c85cbd495be9c054ef17aaebca5e6c908abfda6179"},
	}
	asset, ok := assets[key]
	if !ok {
		return "", "", fmt.Errorf("unsupported runtime platform %s", key)
	}
	return asset[0], asset[1], nil
}

func downloadVerified(url, destination, expectedChecksum string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	response, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download Bun: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download Bun: unexpected HTTP %s", response.Status)
	}
	if response.ContentLength > maxRuntimeBytes {
		return errors.New("download Bun: archive is unexpectedly large")
	}

	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maxRuntimeBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written > maxRuntimeBytes {
		return errors.New("download Bun: archive exceeded size limit")
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expectedChecksum {
		return fmt.Errorf("download Bun: checksum mismatch (got %s)", actual)
	}
	return nil
}

func unzipBun(archivePath, destination string) (string, error) {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return "", err
	}
	var bunPath string
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() || filepath.Base(entry.Name) != "bun" {
			continue
		}
		target := filepath.Join(destination, "downloaded-bun")
		input, openErr := entry.Open()
		if openErr != nil {
			return "", openErr
		}
		output, createErr := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
		if createErr != nil {
			input.Close()
			return "", createErr
		}
		_, copyErr := io.Copy(output, io.LimitReader(input, maxRuntimeBytes+1))
		input.Close()
		output.Close()
		if copyErr != nil {
			return "", copyErr
		}
		bunPath = target
		break
	}
	if bunPath == "" {
		return "", errors.New("download Bun: archive did not contain the executable")
	}
	return bunPath, nil
}
