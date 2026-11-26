// Command feed-eval is the offline tooling of feed-go's production-derived evals (DESIGN.md §19). It
// makes no network call.
//
//	feed-eval signatures [--in <file.jsonl>] [--endpoint <name>] [--top N] [--per-signature K]
//	                     [--response-bytes B] [--hosts 'green=h1,h2;blue=h3;red=h4']
//
// signatures reads request records as JSON lines — the rows feed-bench's Tempo capture writes
// (scripts/feed-bench/README.md: `{t, host, input, authed, durMs}`, image.getImagesAsPostsInfinite
// only), optionally with `endpoint`, `path` and `query` for another endpoint — computes each one's
// shape signature (internal/evalcorpus) and prints, per endpoint: the rows read, the distinct
// signatures, the share of rows the top N signatures hold, and the size a corpus keeping K cases per
// signature would take (each case's stored bytes, plus B per case for its recorded answer).
//
// A row's viewer is all a capture row says of it: `authed` (the web client's signed-in marker) is
// `user`, otherwise `anon`. Hosts map to their domain color with --hosts; without it every host
// is `unmapped`. A row that is not JSON, or names an endpoint the signature rules do not cover, is
// counted and skipped; no usable row at all is an error.
package main

import (
	"fmt"
	"io"
	"os"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

const usage = `usage: feed-eval signatures [--in <file.jsonl>] [--endpoint <name>] [--top N] [--per-signature K] [--response-bytes B] [--hosts 'green=h1,h2;blue=h3']`

// run is main's body: the exit code of the subcommand args name.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "signatures":
		if err := signatures(args[1:], stdin, stdout); err != nil {
			_, _ = fmt.Fprintln(stderr, "feed-eval signatures:", err)
			return 1
		}
		return 0
	case "-h", "--help", "help":
		_, _ = fmt.Fprintln(stdout, usage)
		return 0
	}
	_, _ = fmt.Fprintf(stderr, "feed-eval: unknown subcommand %q\n%s\n", args[0], usage)
	return 2
}
