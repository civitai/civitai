package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// captureRows are synthetic rows in feed-bench's capture format (plus two of another endpoint and
// one that is not JSON): rows 1 and 2 differ only in an id (one signature), row 3 is row 1 signed in,
// row 4 adds a sort.
const captureRows = `{"t":1718000000000,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6001}}","authed":false,"durMs":41.5}
{"t":1718000000001,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6002}}","authed":false,"durMs":38.0}
{"t":1718000000002,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6001}}","authed":true,"durMs":52.1}
{"t":1718000000003,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6003,\"sort\":\"Newest\"}}","authed":false,"durMs":40.0}
not json

{"endpoint":"v1-images","host":"green.example.test","query":"limit=1"}
{"endpoint":"v1-models-id","host":"green.example.test","path":"/api/v1/models/5001"}
`

func TestCollect(t *testing.T) {
	stats, bad, unsupported, err := collect(strings.NewReader(captureRows), "as-posts", parseHostsOrFail(t, "green=green.example.test"))
	if err != nil {
		t.Fatal(err)
	}
	if bad != 1 || unsupported != 1 {
		t.Errorf("bad %d unsupported %d, want 1 and 1", bad, unsupported)
	}
	if len(stats) != 2 {
		t.Fatalf("%d endpoints, want 2 (as-posts, v1-models-id)", len(stats))
	}
	ap := stats["as-posts"]
	if ap.rows != 4 || len(ap.counts) != 3 {
		t.Errorf("as-posts: %d rows %d signatures, want 4 and 3", ap.rows, len(ap.counts))
	}
	counts := make([]int, 0, len(ap.counts))
	for _, c := range ap.counts {
		counts = append(counts, c)
	}
	sort.Ints(counts)
	if fmt.Sprint(counts) != "[1 1 2]" {
		t.Errorf("as-posts signature counts %v, want one of 2 and two of 1", counts)
	}
	for sig, b := range ap.bytes {
		if b < 100 {
			t.Errorf("signature %s: stored case of %d bytes, implausibly small", sig, b)
		}
	}
	if v := stats["v1-models-id"]; v.rows != 1 || len(v.counts) != 1 {
		t.Errorf("v1-models-id: %d rows %d signatures, want 1 and 1", v.rows, len(v.counts))
	}
}

func TestReport(t *testing.T) {
	stats := map[string]*endpointStats{
		"infinite": {rows: 10, counts: map[string]int{"a": 6, "b": 3, "c": 1}, bytes: map[string]int{"a": 100, "b": 200, "c": 300}},
		"as-posts": {rows: 4, counts: map[string]int{"x": 4}, bytes: map[string]int{"x": 50}},
	}
	var out bytes.Buffer
	// top 2; 2 cases per signature; 10 bytes of answer each:
	// infinite: 2*(100+10) + 2*(200+10) + 1*(300+10) = 950, top-2 share 9/10.
	// as-posts: 2*(50+10) = 120, top-2 share 4/4.
	if err := report(&out, stats, 3, 5, 2, 2, 10); err != nil {
		t.Fatal(err)
	}
	want := "endpoint  rows  signatures  top2 share  estimated corpus bytes\n" +
		"as-posts  4     1           100.0%      120\n" +
		"infinite  10    3           90.0%       950\n" +
		"skipped: 3 not JSON, 5 of an unsupported endpoint\n"
	if out.String() != want {
		t.Errorf("report:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestSignaturesCommand(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "rows.jsonl")
	if err := os.WriteFile(in, []byte(captureRows), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := run([]string{"signatures", "--in", in, "--top", "1", "--hosts", "green=green.example.test"}, strings.NewReader(""), &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("output:\n%s", stdout.String())
	}
	for i, want := range [][]string{
		{"endpoint", "rows", "signatures", "top1", "share", "estimated", "corpus", "bytes"},
		{"as-posts", "4", "3", "50.0%"},
		{"v1-models-id", "1", "1", "100.0%"},
	} {
		f := strings.Fields(lines[i])
		if i > 0 {
			f = f[:4] // the size column is TestReport's
		}
		if strings.Join(f, " ") != strings.Join(want, " ") {
			t.Errorf("line %d: %q, want fields %v", i, lines[i], want)
		}
	}
	if lines[3] != "skipped: 1 not JSON, 1 of an unsupported endpoint" {
		t.Errorf("last line %q", lines[3])
	}

	// Stdin, and the failures.
	stdout.Reset()
	if code := run([]string{"signatures"}, strings.NewReader(captureRows), &stdout, &stderr); code != 0 || !strings.HasPrefix(stdout.String(), "endpoint") {
		t.Errorf("stdin: exit %d, output %q", code, stdout.String())
	}
	for _, args := range [][]string{
		{"signatures", "--in", filepath.Join(dir, "missing.jsonl")},
		{"signatures", "--top", "0"},
		{"signatures", "--hosts", "purple=x"},
		{"signatures", "extra"},
		{"signatures", "--nope"},
	} {
		stderr.Reset()
		if code := run(args, strings.NewReader(captureRows), &stdout, &stderr); code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
	}
	stderr.Reset()
	if code := run([]string{"signatures"}, strings.NewReader("not json\n"), &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "no usable row (1 not JSON, 0 of an unsupported endpoint)") {
		t.Errorf("no usable row: exit %d, stderr %q", code, stderr.String())
	}
	if code := run(nil, nil, &stdout, &stderr); code != 2 {
		t.Errorf("no subcommand: exit %d, want 2", code)
	}
	if code := run([]string{"bogus"}, nil, &stdout, &stderr); code != 2 {
		t.Errorf("unknown subcommand: exit %d, want 2", code)
	}
	if code := run([]string{"help"}, nil, &stdout, &stderr); code != 0 {
		t.Errorf("help: exit %d, want 0", code)
	}
}

func parseHostsOrFail(t *testing.T, s string) evalcorpus.Env {
	t.Helper()
	hc, err := parseHosts(s)
	if err != nil {
		t.Fatal(err)
	}
	return evalcorpus.Env{HostColors: hc}
}

func TestParseHosts(t *testing.T) {
	hc, err := parseHosts("green=a.example.test, b.example.test ;blue=c.example.test;")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(hc["green"], ",") != "a.example.test,b.example.test" || strings.Join(hc["blue"], ",") != "c.example.test" || len(hc) != 2 {
		t.Errorf("hosts %v", hc)
	}
	for _, bad := range []string{"green", "purple=a", "=a"} {
		if _, err := parseHosts(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}
