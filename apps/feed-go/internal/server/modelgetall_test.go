package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

const modelsEnvelope = `{"json":{"items":[{"id":5001,"name":"a"},{"id":5002,"name":"b"}],"nextCursor":"1|2|3"}}`

func postModels(t *testing.T, s *Server, input, node string) {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{Input: input, Headers: map[string]string{"host": "civitai.example"}, Node: json.RawMessage(node)})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowModelGetAllHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/model.getAll", strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
}

// A model-getall sample is computed by the model.getAll compute, compared as a superjson envelope,
// classified by model id, and every series it touches carries feed_endpoint="model-getall".
func TestModelGetAllShadowSample(t *testing.T) {
	reg := prometheus.NewRegistry()
	var seen *http.Request
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the gallery compute must not run for a model-getall sample")
		return nil, nil
	})
	s.computeModelsFn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = r
		return &computed{payload: []byte(modelsEnvelope)}, nil
	}
	result := func(r string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "result": r})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	input := `{"json":{"sort":"Newest","limit":2}}`
	postModels(t, s, input, `{"json":{"nextCursor":"1|2|3","items":[{"name":"a","id":5001},{"id":5002,"name":"b"}]}}`)
	waitFor(t, "the match", result("match"))
	if seen == nil || seen.URL.Path != "/api/trpc/model.getAll" || seen.URL.Query().Get("input") != input || seen.Host != "civitai.example" {
		t.Fatalf("synthetic request = %+v", seen)
	}
	// The same models in another order is `order`, a different model `membership` (by model id).
	postModels(t, s, input, `{"json":{"items":[{"id":5002,"name":"b"},{"id":5001,"name":"a"}],"nextCursor":"1|2|3"}}`)
	waitFor(t, "the order diff", result("order"))
	postModels(t, s, input, `{"json":{"items":[{"id":5001,"name":"a"},{"id":5009,"name":"b"}],"nextCursor":"1|2|3"}}`)
	waitFor(t, "the membership diff", result("membership"))
	nameDiffs := func() float64 {
		n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "category": "items.*.name", "kind": "value"})
		return n
	}
	before := nameDiffs() // the swapped order differs at both names
	postModels(t, s, input, `{"json":{"items":[{"id":5001,"name":"a"},{"id":5002,"name":"c"}],"nextCursor":"1|2|3"}}`)
	waitFor(t, "the fields diff", result("fields"))
	if got := nameDiffs() - before; got != 1 {
		t.Fatalf("name diffs of the fields sample = %v, want 1", got)
	}
	if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"}); found {
		t.Fatal("a model-getall sample must not be counted under as-posts")
	}
}

// Without model deps every sample is the `model-getall-unconfigured` fallback (the real compute ran).
func TestModelGetAllShadowWithoutDepsFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	postModels(t, s, `{"json":{}}`, modelsEnvelope)
	waitFor(t, "the unsupported result", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "result": "unsupported"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "mode": "shadow", "reason": "model-getall-unconfigured"}); n != 1 {
		t.Fatalf("fallback = %v, want 1", n)
	}
}

// computeModelGetAll's own refusals, before any store is read: the method, the envelope, the
// parser, a verified crawler.
func TestComputeModelGetAllRefusals(t *testing.T) {
	s := &Server{Models: &modelfeed.Deps{}}
	req := func(method, input string, headers map[string]string) *http.Request {
		r, err := SyntheticModelGetAllRequest(context.Background(), ShadowRequest{Input: input, Headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		r.Method = method
		return r
	}
	for _, c := range []struct {
		r      *http.Request
		reason string
	}{
		{req(http.MethodPost, `{"json":{}}`, nil), "method"},
		{req(http.MethodGet, `nope`, nil), "input-envelope"},
		{req(http.MethodGet, `{"json":{"query":"x"}}`, nil), "input-query"},
		{req(http.MethodGet, `{"json":{}}`, map[string]string{verifiedBotHeader: "googlebot"}), "verified-bot"},
	} {
		_, err := s.computeModelGetAll(context.Background(), c.r)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s %s: %q (%v), want %q", c.r.Method, c.r.URL.RawQuery, got, err, c.reason)
		}
	}
}
