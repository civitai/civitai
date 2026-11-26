package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalharness"
)

// stringList is a repeatable string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

func chConfig() evalharness.CHConfig {
	return evalharness.CHConfig{
		URL:      os.Getenv("FEED_EVAL_CLICKHOUSE_URL"),
		Username: os.Getenv("FEED_EVAL_CLICKHOUSE_USER"),
		Password: os.Getenv("FEED_EVAL_CLICKHOUSE_PASSWORD"),
	}
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// runCmd is `feed-eval run`: one live run (evalharness.Run).
func runCmd(args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var flagOut strings.Builder
	fs.SetOutput(&flagOut)
	nodeURL := fs.String("node-url", os.Getenv("NODE_URL"), "the Node app's base URL (env NODE_URL)")
	goURL := fs.String("go-url", os.Getenv("GO_URL"), "feed-go's base URL, in eval mode (env GO_URL)")
	endpoints := fs.String("endpoints", "", "comma-separated endpoints (default: every corpus endpoint)")
	lookback := fs.Duration("lookback", evalharness.DefaultLookback, "how far back samples weigh signatures")
	perEndpoint := fs.Int("cap", evalharness.DefaultPerEndpointCap, "signatures run per endpoint")
	timeout := fs.Duration("timeout", evalharness.DefaultCallTimeout, "per-call timeout")
	rps := fs.Float64("rps", evalharness.DefaultRPS, "outbound calls per second, Node and Go together")
	burst := fs.Int("burst", evalharness.DefaultBurst, "token bucket burst (at least 3: one case's calls)")
	concurrency := fs.Int("concurrency", evalharness.DefaultConcurrency, "cases in flight")
	window := fs.String("window", evalharness.DefaultWindow.String(), "UTC run window HH:MM-HH:MM")
	forceWindow := fs.Bool("force-window", false, "run outside the window, and ignore it closing")
	promURL := fs.String("prom-url", os.Getenv("FEED_EVAL_PROM_URL"), "Prometheus base URL for the health guard (env FEED_EVAL_PROM_URL)")
	var health stringList
	fs.Var(&health, "health", "health check 'name=<promql>;max=<float>' (repeatable)")
	healthFile := fs.String("health-file", "", "JSON file of health checks [{name, query, max}]")
	allowNoHealth := fs.Bool("allow-no-health", false, "run with no health check")
	healthEvery := fs.Duration("health-interval", evalharness.DefaultHealthInterval, "health check interval")
	maxPause := fs.Duration("max-pause", evalharness.DefaultMaxPause, "end the run after a pause this long")
	maxCases := fs.Int("max-cases", evalharness.DefaultMaxCases, "cases per run at most")
	maxDuration := fs.Duration("max-duration", evalharness.DefaultMaxDuration, "run length at most")
	nodeImage := fs.String("node-image", os.Getenv("FEED_EVAL_NODE_IMAGE"), "recorded on the run row (env FEED_EVAL_NODE_IMAGE)")
	goImage := fs.String("go-image", os.Getenv("FEED_EVAL_GO_IMAGE"), "recorded on the run row (env FEED_EVAL_GO_IMAGE)")
	snapshot := fs.String("snapshot-id", os.Getenv("FEED_EVAL_SNAPSHOT_ID"), "recorded on the run row (env FEED_EVAL_SNAPSHOT_ID)")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, flagOut.String())
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	win, err := evalharness.ParseWindow(*window)
	if err != nil {
		return err
	}
	var checks []evalharness.HealthCheck
	for _, h := range health {
		c, err := evalharness.ParseHealthCheck(h)
		if err != nil {
			return err
		}
		checks = append(checks, c)
	}
	if *healthFile != "" {
		more, err := evalharness.LoadHealthChecks(*healthFile)
		if err != nil {
			return err
		}
		checks = append(checks, more...)
	}
	cfg := evalharness.RunConfig{
		NodeURL: *nodeURL, GoURL: *goURL, Endpoints: splitList(*endpoints), Lookback: *lookback, PerEndpointCap: *perEndpoint,
		CallTimeout: *timeout, RPS: *rps, Burst: *burst, Concurrency: *concurrency, Window: win, ForceWindow: *forceWindow,
		AllowNoHealth: *allowNoHealth, HealthInterval: *healthEvery, MaxPause: *maxPause, MaxCases: *maxCases,
		MaxDuration: *maxDuration, NodeImage: *nodeImage, GoImage: *goImage, SnapshotID: *snapshot, Log: stderr,
	}
	if len(cfg.Endpoints) == 0 {
		cfg.Endpoints = nil
	}
	if len(checks) > 0 {
		cfg.Health = &evalharness.Health{PromURL: *promURL, Checks: checks}
	}
	accountsPath := os.Getenv("FEED_EVAL_ACCOUNTS_FILE")
	if accountsPath == "" {
		return errors.New("FEED_EVAL_ACCOUNTS_FILE is required")
	}
	accounts, err := evalharness.LoadAccounts(accountsPath, time.Now(), stderr)
	if err != nil {
		return err
	}
	store, err := evalharness.NewCHStore(chConfig())
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	_, runErr := evalharness.Run(ctx, cfg, accounts, store)
	closeCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return errors.Join(runErr, store.Close(closeCtx))
}

// publishCmd is `feed-eval publish`: render the newest runs and PUT them to HQ (evalharness.Publish).
func publishCmd(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	var flagOut strings.Builder
	fs.SetOutput(&flagOut)
	hqURL := fs.String("hq-url", os.Getenv("HQ_URL"), "HQ base URL (env HQ_URL)")
	prefix := fs.String("prefix", "feed-eval", "index page id; endpoint pages are <prefix>-<endpoint>")
	viewers := fs.String("viewers", "", "comma-separated page viewers (default: none sent)")
	dryRun := fs.String("dry-run", "", "write <id>.html into this directory instead of PUTting")
	runs := fs.Int("runs", 31, "runs shown: the newest and up to N-1 before it")
	endpoints := fs.String("endpoints", "", "comma-separated endpoints (default: every corpus endpoint)")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, flagOut.String())
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	cfg := evalharness.PublishConfig{Phase: evalharness.PhaseLive, Runs: *runs, Prefix: *prefix, Viewers: splitList(*viewers),
		DryRunDir: *dryRun, Endpoints: splitList(*endpoints)}
	if len(cfg.Endpoints) == 0 {
		cfg.Endpoints = nil
	}
	if *dryRun == "" {
		token, err := hqToken()
		if err != nil {
			return err
		}
		if *hqURL == "" {
			return errors.New("HQ_URL (or --hq-url) is required without --dry-run")
		}
		cfg.HQ = &evalharness.HQClient{BaseURL: *hqURL, Token: token}
	}
	read, err := evalharness.NewCHReader(chConfig())
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ids, err := evalharness.Publish(ctx, cfg, read)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(stdout, "published:", strings.Join(ids, " "))
	return nil
}

// hqToken is HQ_TOKEN, else the content of the file HQ_TOKEN_FILE names.
func hqToken() (string, error) {
	if t := os.Getenv("HQ_TOKEN"); t != "" {
		return t, nil
	}
	path := os.Getenv("HQ_TOKEN_FILE")
	if path == "" {
		return "", errors.New("HQ_TOKEN or HQ_TOKEN_FILE is required without --dry-run")
	}
	b, err := os.ReadFile(path) //nolint:gosec // G304: the operator's mounted token path
	if err != nil {
		return "", fmt.Errorf("HQ_TOKEN_FILE: %w", err)
	}
	t := strings.TrimSpace(string(b))
	if t == "" {
		return "", errors.New("HQ_TOKEN_FILE is empty")
	}
	return t, nil
}

// reconcileCmd is `feed-eval reconcile`: hold the newest live run against the last day's production
// samples, promote the blind spots' cases and write the summary row (evalharness.Reconcile).
func reconcileCmd(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("reconcile", flag.ContinueOnError)
	var flagOut strings.Builder
	fs.SetOutput(&flagOut)
	window := fs.Duration("window", evalharness.DefaultReconcileWindow, "how far back production samples are read")
	minMismatches := fs.Int("min-mismatches", evalharness.DefaultMinMismatches, "a blind spot's production mismatches, at least")
	minShare := fs.Float64("min-mismatch-share", evalharness.DefaultMinMismatchShare,
		"a blind spot's share of mismatches among its compared samples, at least (both thresholds must hold)")
	perSig := fs.Int("promote-per-signature", evalharness.DefaultPromotePerSignature, "promoted cases per blind spot, at most")
	maxPromotions := fs.Int("max-promotions", evalharness.DefaultMaxPromotions, "new promotions per reconcile, at most")
	dryRun := fs.Bool("dry-run", false, "print the summary; promote nothing, write nothing")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, flagOut.String())
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *minShare > 1 {
		return errors.New("--min-mismatch-share is a fraction: at most 1")
	}
	store, err := evalharness.NewCHReconcileStore(chConfig())
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	sum, err := evalharness.Reconcile(ctx, evalharness.ReconcileConfig{Window: *window, MinMismatches: *minMismatches,
		MinMismatchShare: *minShare, PromotePerSignature: *perSig, MaxPromotions: *maxPromotions, DryRun: *dryRun, Log: stderr}, store)
	if err != nil {
		return err
	}
	if *dryRun {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(sum)
	}
	return nil
}
