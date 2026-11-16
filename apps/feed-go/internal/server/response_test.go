package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func postResponseSample(t *testing.T, s *Server, status int, headers map[string]string) {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{
		Input: `{"json":{}}`, Headers: map[string]string{"host": "civitai.example"},
		Node: json.RawMessage(servedPayload), Status: status, ResponseHeaders: headers,
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

// The status and compared headers are their own result (feed_go_shadow_response_total), beside the
// body's: a sample whose body matches but whose Cache-Control differs is body `match`, response
// `mismatch`, with the diff counted under header:cache-control.
func TestShadowComparesStatusAndHeaders(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, served(&trpc.SignedOutTTL))
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

	postResponseSample(t, s, 200, map[string]string{"cache-control": public})
	waitFor(t, "a matching response", response("match", 1))

	postResponseSample(t, s, 200, map[string]string{"cache-control": "max-age=0, private, no-cache", "cache-tag": "images"})
	waitFor(t, "a mismatching response", response("mismatch", 1))
	if diff("header:cache-control", "value") != 1 || diff("header:cache-tag", "missing-in-go") != 1 {
		t.Fatalf("header diffs: cache-control=%v cache-tag=%v, want 1 and 1", diff("header:cache-control", "value"), diff("header:cache-tag", "missing-in-go"))
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"}); v != 2 {
		t.Fatalf("body match count = %v, want 2 (a header difference is not a body difference)", v)
	}

	postResponseSample(t, s, 451, map[string]string{"cache-control": public})
	waitFor(t, "a status mismatch", response("mismatch", 2))
	if diff("status", "value") != 1 {
		t.Fatalf("status diff = %v, want 1", diff("status", "value"))
	}

	// A sampler that predates the fields: nothing to compare.
	postResponseSample(t, s, 0, nil)
	waitFor(t, "an uncompared response", response("uncompared", 1))
}

// The Go side of the comparison is what the public route writes: WriteResult's Cache-Control.
func TestResultHeadersAreWhatWriteResultSends(t *testing.T) {
	for _, ttl := range []*trpc.CacheTTL{nil, &trpc.SignedOutTTL} {
		w := httptest.NewRecorder()
		trpc.WriteResult(w, []byte(`{}`), ttl)
		if got, want := w.Header().Get("Cache-Control"), trpc.ResultHeaders(ttl)["cache-control"]; got != want {
			t.Errorf("ttl %v: WriteResult sent %q, ResultHeaders says %q", ttl, got, want)
		}
	}
}
