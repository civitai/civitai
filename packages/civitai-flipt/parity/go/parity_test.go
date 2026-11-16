package parity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	flipt "go.flipt.io/flipt-client"
)

// Two modes, chosen by FLIPT_PARITY_EXPECT:
//
//   - unset: the pinned client (go.mod). Its version must be the one ../expected.json records
//     (`clients.go`, set by the Node test), and every case must evaluate to exactly the result the
//     Node client recorded. A different engine on either side turns this red.
//   - "latest": the newest client, swapped in by CI (`go get go.flipt.io/flipt-client@<v>`). The
//     cases that differ from ../expected.json must be exactly those ../latest-divergences.json
//     lists, with exactly those results; js-client-check.mjs asserts the same of the newest JS
//     client. With FLIPT_PARITY_WRITE_DIVERGENCES=<path> the computed list is also written there
//     (CI uploads it), which is how that file is regenerated.

const (
	snapshotPath = "/internal/v1/evaluation/snapshot/namespace/default"
	// A reserved TLD (RFC 2606): nothing resolves it. The transport below never dials anyway.
	fliptURL = "http://flipt.invalid"
)

type parityCase struct {
	ID       string            `json:"id"`
	Kind     string            `json:"kind"`
	FlagKey  string            `json:"flagKey"`
	EntityID string            `json:"entityId"`
	Context  map[string]string `json:"context"`
	Result   json.RawMessage   `json:"result"`
}

type clientVersions struct {
	JS string `json:"js"`
	Go string `json:"go"`
}

type expectedFile struct {
	Clients   clientVersions `json:"clients"`
	CaseCount int            `json:"caseCount"`
	Cases     []parityCase   `json:"cases"`
}

type divergence struct {
	ID       string          `json:"id"`
	Baseline json.RawMessage `json:"baseline"`
	Latest   json.RawMessage `json:"latest"`
}

type divergenceFile struct {
	Description     string         `json:"description"`
	Regenerate      string         `json:"regenerate"`
	Baseline        clientVersions `json:"baseline"`
	Latest          clientVersions `json:"latest"`
	DivergenceCount int            `json:"divergenceCount"`
	Divergences     []divergence   `json:"divergences"`
}

// snapshotTransport answers the snapshot request with the fixture and anything else with a 404,
// counting both. It never opens a connection.
type snapshotTransport struct {
	body       []byte
	served     atomic.Int64
	unexpected atomic.Int64
}

func (t *snapshotTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodGet && r.URL.Path == snapshotPath {
		t.served.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(t.body)),
			Request:    r,
		}, nil
	}
	t.unexpected.Add(1)
	return &http.Response{StatusCode: http.StatusNotFound, Body: http.NoBody, Request: r}, nil
}

func readFile(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("../" + name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return b
}

func readJSON(t *testing.T, name string, v any) {
	t.Helper()
	if err := json.Unmarshal(readFile(t, name), v); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

// newClient builds a client over the snapshot and closes it (engine memory, wazero runtime,
// background goroutines) when the test ends.
func newClient(t *testing.T, snapshot []byte) (*flipt.Client, *snapshotTransport) {
	t.Helper()
	ctx := context.Background()
	tr := &snapshotTransport{body: snapshot}
	c, err := flipt.NewClient(ctx,
		flipt.WithURL(fliptURL),
		flipt.WithHTTPClient(&http.Client{Transport: tr}),
		// One fetch at init; the first poll would be an hour away.
		flipt.WithUpdateInterval(time.Hour),
		// Fail, not Fallback: newer clients fall back to an EMPTY state when the first fetch fails,
		// which would evaluate every case to an error instead of failing here.
		flipt.WithErrorStrategy(flipt.ErrorStrategyFail),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() {
		if err := c.Close(ctx); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return c, tr
}

// evaluate reduces a response to the fields ../evaluate.mjs keeps, as canonical JSON.
func evaluate(ctx context.Context, c *flipt.Client, pc parityCase) string {
	req := &flipt.EvaluationRequest{FlagKey: pc.FlagKey, EntityID: pc.EntityID, Context: pc.Context}
	if req.Context == nil {
		req.Context = map[string]string{}
	}
	var out map[string]any
	switch pc.Kind {
	case "boolean":
		r, err := c.EvaluateBoolean(ctx, req)
		if err != nil {
			out = map[string]any{"error": true}
		} else {
			out = map[string]any{"enabled": r.Enabled, "reason": r.Reason}
		}
	case "variant":
		r, err := c.EvaluateVariant(ctx, req)
		if err != nil {
			out = map[string]any{"error": true}
		} else {
			keys := append([]string{}, r.SegmentKeys...)
			sort.Strings(keys)
			out = map[string]any{
				"match":             r.Match,
				"variantKey":        r.VariantKey,
				"variantAttachment": r.VariantAttachment,
				"segmentKeys":       keys,
				"reason":            r.Reason,
			}
		}
	default:
		panic(fmt.Sprintf("case %s: unknown kind %q", pc.ID, pc.Kind))
	}
	b, err := json.Marshal(out) // map keys marshal sorted
	if err != nil {
		panic(err)
	}
	return string(b)
}

// canonicalJSON re-encodes JSON with its object keys sorted.
func canonicalJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse %s: %v", raw, err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(b)
}

func TestParityWithNode(t *testing.T) {
	mode := os.Getenv("FLIPT_PARITY_EXPECT")
	if mode != "" && mode != "latest" {
		t.Fatalf("FLIPT_PARITY_EXPECT=%q: want unset or \"latest\"", mode)
	}
	var exp expectedFile
	readJSON(t, "expected.json", &exp)
	if len(exp.Cases) < 200 || len(exp.Cases) != exp.CaseCount {
		t.Fatalf("expected.json holds %d cases (caseCount %d); want the full corpus of >= 200", len(exp.Cases), exp.CaseCount)
	}
	running := "v" + flipt.Version
	if mode == "" && running != exp.Clients.Go {
		t.Fatalf("go.flipt.io/flipt-client %s, but expected.json was recorded for Go %s (Node %s): "+
			"pin the release whose engine matches, or regenerate expected.json for the new pair (../README.md)",
			running, exp.Clients.Go, exp.Clients.JS)
	}

	ctx := context.Background()
	c, tr := newClient(t, readFile(t, "snapshot.json"))

	actual := make(map[string]string, len(exp.Cases))
	var enabled, disabled, errored int
	for _, pc := range exp.Cases {
		got := evaluate(ctx, c, pc)
		actual[pc.ID] = got
		switch {
		case strings.Contains(got, `"enabled":true`):
			enabled++
		case strings.Contains(got, `"enabled":false`):
			disabled++
		case got == `{"error":true}`:
			errored++
		}
	}
	// Positive controls: the engine really loaded the fixture (a client over an empty or unparsed
	// state answers every case with an error), and through the transport alone.
	t.Logf("go.flipt.io/flipt-client %s: %d cases (%d boolean true, %d boolean false, %d errors), snapshot served %d times",
		running, len(exp.Cases), enabled, disabled, errored, tr.served.Load())
	if enabled == 0 || disabled == 0 || errored == 0 || errored > 10 {
		t.Fatalf("degenerate results: %d true, %d false, %d errors", enabled, disabled, errored)
	}
	if tr.served.Load() < 1 || tr.unexpected.Load() != 0 {
		t.Fatalf("snapshot served %d times, %d unexpected requests", tr.served.Load(), tr.unexpected.Load())
	}

	var got []divergence
	for _, pc := range exp.Cases {
		if want := canonicalJSON(t, pc.Result); want != actual[pc.ID] {
			got = append(got, divergence{ID: pc.ID, Baseline: json.RawMessage(want), Latest: json.RawMessage(actual[pc.ID])})
		}
	}

	if mode == "" {
		for i, d := range got {
			if i == 50 {
				t.Errorf("... and %d more", len(got)-50)
				break
			}
			t.Errorf("%s: Node %s %s, Go %s %s", d.ID, exp.Clients.JS, d.Baseline, running, d.Latest)
		}
		return
	}

	if out := os.Getenv("FLIPT_PARITY_WRITE_DIVERGENCES"); out != "" {
		writeDivergences(t, out, exp.Clients, clientVersions{JS: os.Getenv("FLIPT_PARITY_LATEST_JS"), Go: running}, got)
	}
	var rec divergenceFile
	readJSON(t, "latest-divergences.json", &rec)
	if rec.Latest.Go != running || rec.Baseline != exp.Clients {
		t.Fatalf("latest-divergences.json records Go %s against %+v; running %s against %+v",
			rec.Latest.Go, rec.Baseline, running, exp.Clients)
	}
	t.Logf("%d of %d cases differ from Node %s (recorded: %d)", len(got), len(exp.Cases), exp.Clients.JS, len(rec.Divergences))
	recorded := make(map[string]string, len(rec.Divergences))
	for _, d := range rec.Divergences {
		recorded[d.ID] = canonicalJSON(t, d.Latest)
	}
	seen := make(map[string]bool, len(got))
	for _, d := range got {
		seen[d.ID] = true
		want, ok := recorded[d.ID]
		switch {
		case !ok:
			t.Errorf("unrecorded divergence %s: Node %s, Go %s", d.ID, d.Baseline, d.Latest)
		case want != string(d.Latest):
			t.Errorf("%s: recorded %s, got %s", d.ID, want, d.Latest)
		}
	}
	for _, d := range rec.Divergences {
		if !seen[d.ID] {
			t.Errorf("recorded divergence %s did not happen", d.ID)
		}
	}
}

func writeDivergences(t *testing.T, path string, baseline, latest clientVersions, ds []divergence) {
	t.Helper()
	if ds == nil {
		ds = []divergence{}
	}
	f := divergenceFile{
		Description: "Cases where the newest Flipt clients evaluate differently from the pinned pair in expected.json. " +
			"Asserted by parity/go (FLIPT_PARITY_EXPECT=latest) and parity/js-client-check.mjs.",
		Regenerate:      "CI artifact flipt-parity-latest-divergences (job flipt-parity in .github/workflows/feed-go.yml)",
		Baseline:        baseline,
		Latest:          latest,
		DivergenceCount: len(ds),
		Divergences:     ds,
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		t.Fatalf("encode divergences: %v", err)
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	t.Logf("wrote %d divergences to %s", len(ds), path)
}

// The comparison can go red: a one-flag change to the snapshot moves exactly that flag's cases.
func TestParityDetectsASnapshotChange(t *testing.T) {
	var exp expectedFile
	readJSON(t, "expected.json", &exp)
	raw := readFile(t, "snapshot.json")

	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range doc["flags"].([]any) {
		flag := f.(map[string]any)
		if flag["key"] == "bool-enabled-no-rules" {
			flag["enabled"] = false
			found = true
		}
	}
	if !found {
		t.Fatal("snapshot.json has no bool-enabled-no-rules flag")
	}
	mutated, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	orig, _ := newClient(t, raw)
	changed, _ := newClient(t, mutated)
	moved := map[string]int{}
	for _, pc := range exp.Cases {
		if evaluate(ctx, orig, pc) != evaluate(ctx, changed, pc) {
			moved[pc.FlagKey]++
		}
	}
	if len(moved) != 1 || moved["bool-enabled-no-rules"] == 0 {
		t.Fatalf("cases moved by flipping bool-enabled-no-rules, per flag: %v", moved)
	}
}
