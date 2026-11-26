package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// record is one input line: a feed-bench capture row, plus the optional REST fields.
type record struct {
	Host     string `json:"host"`
	Input    string `json:"input"`
	Authed   bool   `json:"authed"`
	Endpoint string `json:"endpoint"`
	Path     string `json:"path"`
	Query    string `json:"query"`
}

// endpointStats accumulates one endpoint's signatures.
type endpointStats struct {
	rows   int
	counts map[string]int
	// bytes is each signature's first case's stored size (json.Marshal of the Case).
	bytes map[string]int
}

// maxLine bounds one input line (a tRPC input is a URL query value, well under this).
const maxLine = 1 << 20

func signatures(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("signatures", flag.ContinueOnError)
	var flagOut strings.Builder
	fs.SetOutput(&flagOut)
	in := fs.String("in", "-", "JSONL input file (- for stdin)")
	defEndpoint := fs.String("endpoint", evalcorpus.EndpointAsPosts, "endpoint of a row that names none")
	top := fs.Int("top", 10, "N of the top-N traffic share")
	perSig := fs.Int("per-signature", 3, "cases a corpus keeps per signature (size estimate)")
	respBytes := fs.Int("response-bytes", 0, "bytes per case for its recorded answer (size estimate)")
	hosts := fs.String("hosts", "", "domain colors: 'green=h1,h2;blue=h3;red=h4'")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, flagOut.String())
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *top < 1 || *perSig < 1 || *respBytes < 0 {
		return errors.New("--top and --per-signature must be at least 1, --response-bytes at least 0")
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
	stats, bad, unsupported, err := collect(r, *defEndpoint, env)
	if err != nil {
		return err
	}
	if len(stats) == 0 {
		return fmt.Errorf("no usable row (%d not JSON, %d of an unsupported endpoint)", bad, unsupported)
	}
	return report(stdout, stats, bad, unsupported, *top, *perSig, *respBytes)
}

// parseHosts reads --hosts.
func parseHosts(s string) (browsing.HostColors, error) {
	hc := browsing.HostColors{}
	for _, part := range strings.Split(s, ";") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		color, list, ok := strings.Cut(part, "=")
		color = strings.TrimSpace(color)
		if !ok || (color != "green" && color != "blue" && color != "red") {
			return nil, fmt.Errorf("--hosts: %q is not <green|blue|red>=<host,...>", part)
		}
		for _, h := range strings.Split(list, ",") {
			if h = strings.TrimSpace(h); h != "" {
				hc[color] = append(hc[color], h)
			}
		}
	}
	return hc, nil
}

// collect reads every row and counts its signature under its endpoint.
func collect(r io.Reader, defEndpoint string, env evalcorpus.Env) (stats map[string]*endpointStats, bad, unsupported int, err error) {
	stats = map[string]*endpointStats{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var rec record
		if json.Unmarshal([]byte(line), &rec) != nil {
			bad++
			continue
		}
		endpoint := rec.Endpoint
		if endpoint == "" {
			endpoint = defEndpoint
		}
		viewer := evalcorpus.Viewer{Class: evalcorpus.ViewerAnon}
		if rec.Authed {
			viewer.Class = evalcorpus.ViewerUser
		}
		c, cerr := evalcorpus.Capture(evalcorpus.Request{
			Endpoint: endpoint, Input: rec.Input, Path: rec.Path, Query: rec.Query,
			Headers: map[string]string{"host": rec.Host},
		}, viewer, env, evalcorpus.Extra{})
		if errors.Is(cerr, evalcorpus.ErrUnsupportedEndpoint) {
			unsupported++
			continue
		}
		if cerr != nil {
			return nil, 0, 0, cerr
		}
		s := stats[endpoint]
		if s == nil {
			s = &endpointStats{counts: map[string]int{}, bytes: map[string]int{}}
			stats[endpoint] = s
		}
		s.rows++
		s.counts[c.Signature]++
		if _, seen := s.bytes[c.Signature]; !seen {
			b, merr := json.Marshal(c)
			if merr != nil {
				return nil, 0, 0, merr
			}
			s.bytes[c.Signature] = len(b)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, 0, 0, err
	}
	return stats, bad, unsupported, nil
}

// report prints one line per endpoint, sorted by name.
func report(w io.Writer, stats map[string]*endpointStats, bad, unsupported, top, perSig, respBytes int) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintf(tw, "endpoint\trows\tsignatures\ttop%d share\testimated corpus bytes\n", top)
	names := make([]string, 0, len(stats))
	for n := range stats {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		s := stats[n]
		counts := make([]int, 0, len(s.counts))
		for _, c := range s.counts {
			counts = append(counts, c)
		}
		sort.Sort(sort.Reverse(sort.IntSlice(counts)))
		topRows := 0
		for i := 0; i < len(counts) && i < top; i++ {
			topRows += counts[i]
		}
		size := 0
		for sig, c := range s.counts {
			size += min(c, perSig) * (s.bytes[sig] + respBytes)
		}
		_, _ = fmt.Fprintf(tw, "%s\t%d\t%d\t%.1f%%\t%d\n", n, s.rows, len(s.counts), 100*float64(topRows)/float64(s.rows), size)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	_, err := fmt.Fprintf(w, "skipped: %d not JSON, %d of an unsupported endpoint\n", bad, unsupported)
	return err
}
