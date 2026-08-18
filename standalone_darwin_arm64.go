//go:build darwin && arm64

package main

import _ "embed"

//go:embed assets/paperclip-entity-darwin-arm64.zip
var standaloneArchive []byte
