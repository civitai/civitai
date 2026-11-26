package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/evalharness"
)

// importCounts is what an import did with its rows, per endpoint.
type importCounts struct {
	Rows int `json:"rows"`
	// Imported: a case row built. KLimited: its signature already had K cases from this import.
	// Duplicate: the same case (same day, same stored request) already built. ViewerRef: a signed-in
	// row whose input holds a key that may name the viewer (evalcorpus.MayNameViewer), refused.
	Imported, KLimited, Duplicate, ViewerRef int
}

// importResult is an import's rows and counts.
type importResult struct {
	cases       []evalcapture.CaseRow
	perEndpoint map[string]*importCounts
	bad         int // not JSON, or no case could be built
	unsupported int
}

// buildTempoCases reads feed-bench Tempo capture rows (scripts/feed-bench/README.md: {t, host, input,
// authed, durMs}, plus the optional endpoint, path and query of signatures' record) and builds a
// `cases` row of origin tempo for each, at most k per (endpoint, signature).
//
// Only what the record type names is read: a line's other fields (a cookie, an authorization, an
// address, whatever a future capture adds) are never decoded, so never stored. What is read goes
// through evalcorpus.Capture, the capture's own strip (credential-named input keys, credential query
// pairs; only the host header), and evalcapture.Stored (search text replaced). A row says only
// whether it was signed in, never who: a signed-in row whose input holds a key Capture would test
// against the viewer's own identity is refused (MayNameViewer), since nothing could keep the
// viewer's id out of it. Each case's id is CaseID over its record's day in the tempo namespace
// (evalcapture.TempoCaseDay), so an imported case never shares an id with a captured one; its
// first_seen and last_seen are now (TTL from the import; no feed-go row can share its id, so the
// §19.6 ordering does not arise), pinned 0, no Node answer.
func buildTempoCases(r io.Reader, defEndpoint string, env evalcorpus.Env, k int, now time.Time) (importResult, error) {
	res := importResult{perEndpoint: map[string]*importCounts{}}
	perSig := map[string]int{}
	seen := map[uint64]bool{}
	stamp := now.UTC().Format(evalcapture.TimeFormat)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var rec record
		if json.Unmarshal([]byte(line), &rec) != nil {
			res.bad++
			continue
		}
		endpoint := rec.Endpoint
		if endpoint == "" {
			endpoint = defEndpoint
		}
		if !evalcapture.Supported(endpoint) {
			res.unsupported++
			continue
		}
		cnt := res.perEndpoint[endpoint]
		if cnt == nil {
			cnt = &importCounts{}
			res.perEndpoint[endpoint] = cnt
		}
		cnt.Rows++
		req := evalcorpus.Request{Endpoint: endpoint, Input: rec.Input, Path: rec.Path, Query: rec.Query,
			Headers: map[string]string{"host": rec.Host}}
		viewer := evalcorpus.Viewer{Class: evalcorpus.ViewerAnon}
		if rec.Authed {
			viewer.Class = evalcorpus.ViewerUser
			if evalcorpus.MayNameViewer(req) {
				cnt.ViewerRef++
				continue
			}
		}
		at := now.UTC()
		if rec.T > 0 {
			at = time.UnixMilli(rec.T).UTC()
		}
		e := env
		e.Now = at
		c, err := evalcorpus.Capture(req, viewer, e, evalcorpus.Extra{})
		if err != nil {
			res.bad++
			cnt.Rows--
			continue
		}
		sig, err := strconv.ParseUint(c.Signature, 16, 64)
		if err != nil {
			return res, err
		}
		stored, err := evalcapture.Stored(c)
		if err != nil {
			return res, err
		}
		id := evalcapture.CaseID(evalcapture.TempoCaseDay(at.Format(time.DateOnly)), c.Endpoint, c.Signature, stored)
		if seen[id] {
			cnt.Duplicate++
			continue
		}
		key := c.Endpoint + "\x00" + c.Signature
		if perSig[key] >= k {
			cnt.KLimited++
			continue
		}
		seen[id] = true
		perSig[key]++
		cnt.Imported++
		res.cases = append(res.cases, evalcapture.CaseRow{CaseID: id, Endpoint: c.Endpoint, Sig: sig, SigText: c.Shape,
			Origin: evalcapture.OriginTempo, Request: string(stored), NodeHeaders: map[string]string{}, FirstSeen: stamp, LastSeen: stamp})
	}
	return res, sc.Err()
}

// importTempo is `feed-eval import-tempo`: build the cases of a Tempo capture and write them to
// `cases` (the harness login), or with --dry-run print the counts only.
func importTempo(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("import-tempo", flag.ContinueOnError)
	var flagOut strings.Builder
	fs.SetOutput(&flagOut)
	in := fs.String("in", "-", "JSONL input file (- for stdin)")
	defEndpoint := fs.String("endpoint", evalcorpus.EndpointAsPosts, "endpoint of a row that names none")
	k := fs.Int("per-signature", evalcapture.DefaultExemplars, "cases imported per signature, at most (K)")
	hosts := fs.String("hosts", "", "domain colors: 'green=h1,h2;blue=h3;red=h4'")
	dryRun := fs.Bool("dry-run", false, "print the counts; write nothing")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, flagOut.String())
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *k < 1 {
		return errors.New("--per-signature must be at least 1")
	}
	env := evalcorpus.Env{}
	if *hosts != "" {
		hc, err := parseHosts(*hosts)
		if err != nil {
			return err
		}
		env.HostColors = hc
	}
	r := stdin
	if *in != "-" {
		f, err := os.Open(*in)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		r = f
	}
	var exec *evalharness.CHExec
	if !*dryRun {
		var err error
		if exec, err = evalharness.NewCHExec(chConfig()); err != nil {
			return err
		}
	}
	res, err := buildTempoCases(r, *defEndpoint, env, *k, time.Now())
	if err != nil {
		return err
	}
	if len(res.perEndpoint) == 0 {
		return fmt.Errorf("no usable row (%d not usable, %d of an unsupported endpoint)", res.bad, res.unsupported)
	}
	written := uint64(0)
	if !*dryRun {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if written, err = evalharness.InsertCases(ctx, exec, res.cases); err != nil {
			return fmt.Errorf("%w (%d rows written before it)", err, written)
		}
	}
	return printImport(stdout, res, *dryRun, written)
}

func printImport(w io.Writer, res importResult, dryRun bool, written uint64) error {
	names := make([]string, 0, len(res.perEndpoint))
	for n := range res.perEndpoint {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		c := res.perEndpoint[n]
		_, _ = fmt.Fprintf(w, "%s: %d rows, %d cases, %d over K, %d duplicate, %d refused (signed in, may name the viewer)\n",
			n, c.Rows, c.Imported, c.KLimited, c.Duplicate, c.ViewerRef)
	}
	if dryRun {
		_, err := fmt.Fprintf(w, "dry run: nothing written; skipped %d not usable, %d of an unsupported endpoint\n", res.bad, res.unsupported)
		return err
	}
	_, err := fmt.Fprintf(w, "written: %d cases (ClickHouse reported %d rows); skipped %d not usable, %d of an unsupported endpoint\n",
		len(res.cases), written, res.bad, res.unsupported)
	return err
}
