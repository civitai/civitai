package main

import (
	"bytes"
	"testing"
)

// TestPrintVersion pins the `--version` contract the release workflow's smoke step reads: the bare
// version on one line, for exactly one of the two flags, and nothing for any other arguments (the
// service itself takes none, so those fall through to the normal start).
func TestPrintVersion(t *testing.T) {
	old := version
	t.Cleanup(func() { version = old })
	version = "9.8.7"

	for _, flag := range []string{"--version", "-version"} {
		var out bytes.Buffer
		if !printVersion([]string{flag}, &out) {
			t.Fatalf("printVersion(%q) = false, want true", flag)
		}
		if got := out.String(); got != "9.8.7\n" {
			t.Fatalf("printVersion(%q) wrote %q, want %q", flag, got, "9.8.7\n")
		}
	}
	for _, args := range [][]string{nil, {}, {"version"}, {"--version", "x"}, {"--help"}} {
		var out bytes.Buffer
		if printVersion(args, &out) {
			t.Fatalf("printVersion(%q) = true, want false", args)
		}
		if out.Len() != 0 {
			t.Fatalf("printVersion(%q) wrote %q, want nothing", args, out.String())
		}
	}
}
