package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

const v1Body = `{"items":[{"id":11,"createdAt":"2024-03-01T10:00:00.000Z"}],"metadata":{"nextCursor":"feed:1:2"}}`

func postV1(t *testing.T, s *Server, node string) {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{
		Input: "modelVersionId=9&cursor=feed%3A1%3A1", Path: "/api/v1/images",
		Headers: map[string]string{"host": "civitai.example"}, Node: json.RawMessage(node),
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowV1Handler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/images", strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
}

// A v1-images sample is computed by the REST compute (not the tRPC one), compared as plain JSON, and
// every series it touches carries feed_endpoint="v1-images".
func TestV1ShadowSampleIsLabelledAndComparedAsJSON(t *testing.T) {
	reg := prometheus.NewRegistry()
	var seen *http.Request
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the tRPC compute must not run for a v1-images sample")
		return nil, nil
	})
	s.computeV1Fn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = r
		return &computed{payload: []byte(v1Body)}, nil
	}
	// Same body, keys reordered: a match.
	postV1(t, s, `{"metadata":{"nextCursor":"feed:1:2"},"items":[{"createdAt":"2024-03-01T10:00:00.000Z","id":11}]}`)
	v1 := func(result string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": result})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	waitFor(t, "the v1 match", v1("match"))
	if seen == nil || seen.URL.Path != "/api/v1/images" || seen.URL.Query().Get("cursor") != "feed:1:1" || seen.Host != "civitai.example" {
		t.Fatalf("synthetic request = %+v", seen)
	}
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", map[string]string{"feed_endpoint": EndpointV1Images, "phase": "compute", "outcome": "served"}); n != 1 {
		t.Fatalf("v1 compute phase count = %v, want 1", n)
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"}); v != 0 {
		t.Fatal("a v1 sample must not be counted under the as-posts endpoint")
	}
	// A value diff is counted by category under the endpoint.
	postV1(t, s, `{"items":[{"id":11,"createdAt":"2024-03-01T10:00:01.000Z"}],"metadata":{"nextCursor":"feed:1:2"}}`)
	waitFor(t, "the v1 fields diff", v1("fields"))
	if n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointV1Images, "category": "items.*.createdAt", "kind": "value"}); n != 1 {
		t.Fatalf("createdAt diff count = %v, want 1", n)
	}
}

func TestV1ShadowWithoutDepsFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil) // no V1 deps, no test compute: the real computeV1 runs
	postV1(t, s, v1Body)
	waitFor(t, "the unsupported result", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": "unsupported"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointV1Images, "mode": "shadow", "reason": "v1-unconfigured"}); n != 1 {
		t.Fatalf("fallback v1-unconfigured = %v, want 1", n)
	}
}

func TestSyntheticV1RequestKeepsTheRawQuery(t *testing.T) {
	r, err := SyntheticV1Request(context.Background(), ShadowRequest{
		Input:   "username=a_b&q=a+b%20c&cursor=500%7C1724677401898",
		Headers: map[string]string{"host": "civitai.example", "cf-ipcountry": "GB"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.URL.Path != "/api/v1/images" || r.URL.RawQuery != "username=a_b&q=a+b%20c&cursor=500%7C1724677401898" ||
		r.Host != "civitai.example" || r.Header.Get("cf-ipcountry") != "GB" || r.Method != http.MethodGet {
		t.Fatalf("synthetic request: path=%q query=%q host=%q", r.URL.Path, r.URL.RawQuery, r.Host)
	}
}

// A trivial answer (no image loaded) is served_empty / match_empty, never served / match: the
// per-served-call CPU and the match rate cover only answers that did the work.
func TestV1TrivialAnswerIsKeptOutOfServedAndMatch(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"items":[],"metadata":{}}`), trivial: true}, nil
	}
	postV1(t, s, `{"items":[],"metadata":{}}`)
	waitFor(t, "the trivial match", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": "match_empty"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": "match"}); v != 0 {
		t.Fatal("a trivial answer must not count as a match")
	}
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", map[string]string{"feed_endpoint": EndpointV1Images, "phase": "compute", "outcome": "served_empty"}); n != 1 {
		t.Fatalf("served_empty compute phases = %v, want 1", n)
	}
	if _, found := metricValue(t, reg, "feed_go_shadow_phase_seconds", map[string]string{"feed_endpoint": EndpointV1Images, "phase": "compute", "outcome": "served"}); found {
		t.Fatal("a trivial answer must not be a served compute")
	}
	// The dropped counter starts at 0 for every endpoint.
	for _, e := range []string{"as-posts", "v1-images", "infinite", "model-getall"} {
		if v, found := metricValue(t, reg, "feed_go_shadow_dropped_total", map[string]string{"feed_endpoint": e}); !found || v != 0 {
			t.Fatalf("dropped{%s} = %v found=%v, want a 0 series", e, v, found)
		}
	}
}

// The v1-images sample is compared with shadow.CompareV1Images: an image's `modelVersionIds` holding
// the same ids in another order is a match (the image-resources cache's order, which the endpoint never
// promised, differed between the two sides' lookups), while a differing id is still a fields diff under
// its category.
func TestV1ShadowComparesModelVersionIDsAsAMultiset(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 2, nil)
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"items":[{"id":79140094,"modelVersionIds":[331598,454217,1768080],"baseModel":"Pony"}],"metadata":{}}`)}, nil
	}
	v1 := func(result string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointV1Images, "result": result})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	postV1(t, s, `{"items":[{"id":79140094,"modelVersionIds":[1768080,454217,331598],"baseModel":"Pony"}],"metadata":{}}`)
	waitFor(t, "the permuted ids' match", v1("match"))
	postV1(t, s, `{"items":[{"id":79140094,"modelVersionIds":[1768080,454218,331598],"baseModel":"Pony"}],"metadata":{}}`)
	waitFor(t, "the differing id's fields diff", v1("fields"))
	if n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointV1Images, "category": "items.*.modelVersionIds.*", "kind": "value"}); n != 1 {
		t.Fatalf("modelVersionIds diff count = %v, want 1", n)
	}
}
