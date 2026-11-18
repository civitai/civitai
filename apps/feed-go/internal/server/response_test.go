package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func postResponseSample(t *testing.T, s *Server, headers map[string]string) {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{
		Input: `{"json":{}}`, Headers: map[string]string{"host": "civitai.example"},
		Node: json.RawMessage(servedPayload), ResponseHeaders: headers,
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+Procedure, strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
}

// syncBuffer is a log sink the shadow worker and the test read safely.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// The compared headers are their own result (feed_go_shadow_response_total), beside the body's: a
// sample whose body matches but whose Cache-Control differs is body `match`, response `mismatch`, with
// the diff counted under header:cache-control. An unexpected header difference is logged at Info, a
// known one (x-update-required only from Node) at Debug.
func TestShadowComparesHeaders(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, served(&trpc.SignedOutTTL))
	var logs syncBuffer
	s.Log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	response := func(r string, want float64) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": r})
			return v == want && len(s.ShadowQueue) == 0
		}
	}
	diff := func(category, kind string) float64 {
		v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointAsPosts, "category": category, "kind": kind})
		return v
	}
	public := "public, max-age=60, s-maxage=60, stale-while-revalidate=30"
	// The Vary tRPC's resolveResponse sets on every answer: Go's served answer carries it too, so it
	// compares equal (not ignored).
	const vary = "trpc-accept, accept"

	postResponseSample(t, s, map[string]string{"cache-control": public, "vary": vary})
	waitFor(t, "a matching response", response("match", 1))
	if got := logs.String(); strings.Contains(got, "shadow diff") {
		t.Fatalf("a full match logged a diff: %s", got)
	}

	// Vary is compared, not ignored: a Node Vary Go does not send is a counted value difference.
	postResponseSample(t, s, map[string]string{"cache-control": public, "vary": "accept-encoding"})
	waitFor(t, "a Vary mismatch", response("mismatch", 1))
	if diff("header:vary", "value") != 1 {
		t.Fatalf("header:vary value diff = %v, want 1", diff("header:vary", "value"))
	}

	postResponseSample(t, s, map[string]string{"cache-control": "max-age=0, private, no-cache", "vary": vary, "cache-tag": "images"})
	waitFor(t, "a mismatching response", response("mismatch", 2))
	if diff("header:cache-control", "value") != 1 || diff("header:cache-tag", "missing-in-go") != 1 {
		t.Fatalf("header diffs: cache-control=%v cache-tag=%v, want 1 and 1", diff("header:cache-control", "value"), diff("header:cache-tag", "missing-in-go"))
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"}); v != 3 {
		t.Fatalf("body match count = %v, want 3 (a header difference is not a body difference)", v)
	}
	if got := logs.String(); !strings.Contains(got, "level=INFO msg=\"shadow diff\"") {
		t.Fatalf("an unexpected header diff was not logged at Info: %s", got)
	}

	// A known difference is counted, and logged at Debug only.
	before := logs.String()
	postResponseSample(t, s, map[string]string{"cache-control": public, "vary": vary, "x-update-required": "true"})
	waitFor(t, "an expected mismatch", response("mismatch", 3))
	if diff("header:x-update-required", "missing-in-go") != 1 {
		t.Fatalf("x-update-required diff = %v, want 1", diff("header:x-update-required", "missing-in-go"))
	}
	added := strings.TrimPrefix(logs.String(), before)
	if !strings.Contains(added, "level=DEBUG msg=\"shadow diff\"") || strings.Contains(added, "level=INFO") {
		t.Fatalf("an expected diff: want one Debug line and no Info, got %q", added)
	}

	// A sampler that predates the field: nothing to compare.
	postResponseSample(t, s, nil)
	waitFor(t, "an uncompared response", response("uncompared", 1))
}

// A REST sample is uncompared whatever headers it carries: the REST ports write none of their own,
// so a comparison would only count Node's headers as missing here.
func TestShadowRESTResponseIsUncompared(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(v1Body)}, nil
	}
	b, err := json.Marshal(ShadowRequest{
		Input: "modelVersionId=9", Path: "/api/v1/images", Headers: map[string]string{"host": "civitai.example"},
		Node: json.RawMessage(v1Body), ResponseHeaders: map[string]string{"cache-control": "public, max-age=60", "vary": "accept"},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowV1Handler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/images", strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
	waitFor(t, "the REST sample", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": "uncompared"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	for _, r := range []string{"match", "mismatch"} {
		if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": r}); v != 0 {
			t.Errorf("v1-images response %s = %v, want 0", r, v)
		}
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointV1Images, "category": "header:cache-control", "kind": "missing-in-go"}); v != 0 {
		t.Errorf("a REST header diff was counted: %v", v)
	}
}

func TestExpectedResponseDiff(t *testing.T) {
	cc := shadow.Diff{Category: "header:cache-control", Kind: "value"}
	for _, c := range []struct {
		name string
		d    shadow.Diff
		want bool
	}{
		{"update required only from node", shadow.Diff{Category: "header:x-update-required", Kind: "missing-in-go"}, true},
		{"update required only from go", shadow.Diff{Category: "header:x-update-required", Kind: "missing-in-node"}, false},
		// Every tRPC compute (model.getAll's included) records the signed-out TTL when there is no
		// session: a cache-control difference is a real one on every endpoint.
		{"cache-control is never expected", cc, false},
		{"a cache-tag is never expected", shadow.Diff{Category: "header:cache-tag", Kind: "missing-in-go"}, false},
	} {
		if got := expectedResponseDiff(c.d); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestBodyDiffers(t *testing.T) {
	for result, want := range map[string]bool{
		"match": false, "match_empty": false, "match_cached": false,
		"fields": true, "membership": true, "order": true,
	} {
		if got := bodyDiffers(result); got != want {
			t.Errorf("bodyDiffers(%q) = %v, want %v", result, got, want)
		}
	}
}
