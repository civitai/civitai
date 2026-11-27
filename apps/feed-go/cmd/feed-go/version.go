package main

import (
	"fmt"
	"io"
)

// version is the release this binary was built from, set at build time by
// `-ldflags "-X main.version=<x.y.z>"`: the image's build (Dockerfile, from package.json through
// ci/version.sh), .github/workflows/feed-go-release.yml, and the dev launcher's source build, which
// sets `<x.y.z>-dev`. A plain `go build` / `go run` leaves it "dev". It is also the
// X-Feed-Go-Version header on every public answer (server.PublicMux).
var version = "dev"

// printVersion answers `feed-go --version` (or `-version`): it writes the version and reports true,
// so main exits before reading any configuration. Any other arguments report false.
func printVersion(args []string, w io.Writer) bool {
	if len(args) != 1 || (args[0] != "--version" && args[0] != "-version") {
		return false
	}
	_, _ = fmt.Fprintln(w, version)
	return true
}
