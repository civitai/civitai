// Command feed-eval is the tooling of feed-go's production-derived evals (DESIGN.md §19).
//
//	feed-eval signatures [--in <file.jsonl>] [--endpoint <name>] [--top N] [--per-signature K]
//	                     [--response-bytes B] [--hosts 'green=h1,h2;blue=h3;red=h4']
//	feed-eval run        [--node-url U] [--go-url U] [--endpoints a,b] [--window HH:MM-HH:MM] [--force-window]
//	                     [--prom-url U] [--health 'name=<promql>;max=<float>']... [--health-file F] ...
//	feed-eval publish    [--hq-url U] [--prefix P] [--viewers a,b] [--dry-run <dir>] [--runs N]
//	feed-eval reconcile  [--window D] [--min-mismatches N] [--min-mismatch-share F] [--promote-per-signature K]
//	                     [--max-promotions N] [--dry-run]
//	feed-eval import-tempo [--in <file.jsonl>] [--endpoint <name>] [--per-signature K] [--hosts '…'] [--dry-run]
//
// signatures makes no network call. It reads request records as JSON lines — the rows feed-bench's
// Tempo capture writes (scripts/feed-bench/README.md: `{t, host, input, authed, durMs}`,
// image.getImagesAsPostsInfinite only), optionally with `endpoint`, `path` and `query` for another
// endpoint — computes each one's shape signature (internal/evalcorpus) and prints, per endpoint: the
// rows read, the distinct signatures, the share of rows the top N signatures hold, and the size a
// corpus keeping K cases per signature would take (each case's stored bytes, plus B per case for its
// recorded answer). A row's viewer is all a capture row says of it: `authed` (the web client's
// signed-in marker) is `user`, otherwise `anon`. Hosts map to their domain color with --hosts;
// without it every host is `unmapped`. A row that is not JSON, or names an endpoint the signature
// rules do not cover, is counted and skipped; no usable row at all is an error.
//
// run and publish make network calls (DESIGN.md §19.8; internal/evalharness). run replays the corpus
// (ClickHouse: FEED_EVAL_CLICKHOUSE_URL, whose path names the database, _USER, _PASSWORD) against the
// Node app (NODE_URL) and feed-go in eval mode (GO_URL), as the eval accounts of
// FEED_EVAL_ACCOUNTS_FILE, paced and guarded (window, Prometheus health, budget), and writes a results
// row per case and a runs row. publish renders the newest runs as static pages and PUTs them to HQ
// (HQ_URL; HQ_TOKEN or HQ_TOKEN_FILE), or writes them to a directory with --dry-run. Neither does
// anything unless invoked.
//
// reconcile (DESIGN.md §19.9) reads the last day's production samples and the newest live run's
// results (the same ClickHouse login as run) and reports where they disagree: a blind spot (production
// mismatched on a signature the eval passed; its mismatching cases are promoted, pinned, so the next
// run replays one), a promoted case that still passes (cannot reproduce), and a bug the eval found
// where production matched (reverse). Its summary is a `runs` row of phase reconcile, which publish
// shows as the prod/eval disagreement section. import-tempo writes the cases of a feed-bench Tempo
// capture (origin tempo), stripped and signed as the capture's, at most K per signature, so a corpus
// can start before the capture has run for days.
package main

import (
	"fmt"
	"io"
	"os"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

const usage = `usage: feed-eval signatures [--in <file.jsonl>] [--endpoint <name>] [--top N] [--per-signature K] [--response-bytes B] [--hosts 'green=h1,h2;blue=h3']
       feed-eval run [--help for flags]      (env: NODE_URL, GO_URL, FEED_EVAL_CLICKHOUSE_URL/_USER/_PASSWORD, FEED_EVAL_ACCOUNTS_FILE)
       feed-eval publish [--help for flags]  (env: FEED_EVAL_CLICKHOUSE_URL/_USER/_PASSWORD, HQ_URL, HQ_TOKEN or HQ_TOKEN_FILE)
       feed-eval reconcile [--help for flags]    (env: FEED_EVAL_CLICKHOUSE_URL/_USER/_PASSWORD)
       feed-eval import-tempo [--help for flags] (env: FEED_EVAL_CLICKHOUSE_URL/_USER/_PASSWORD, unless --dry-run)`

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
	case "run":
		if err := runCmd(args[1:], stderr); err != nil {
			_, _ = fmt.Fprintln(stderr, "feed-eval run:", err)
			return 1
		}
		return 0
	case "publish":
		if err := publishCmd(args[1:], stdout); err != nil {
			_, _ = fmt.Fprintln(stderr, "feed-eval publish:", err)
			return 1
		}
		return 0
	case "reconcile":
		if err := reconcileCmd(args[1:], stdout, stderr); err != nil {
			_, _ = fmt.Fprintln(stderr, "feed-eval reconcile:", err)
			return 1
		}
		return 0
	case "import-tempo":
		if err := importTempo(args[1:], stdin, stdout); err != nil {
			_, _ = fmt.Fprintln(stderr, "feed-eval import-tempo:", err)
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
