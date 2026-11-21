package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
)

const infiniteInput = `{"json":{"tags":[3],"limit":2}}`

func postInfinite(t *testing.T, h http.Handler, node string) int {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{
		Input: infiniteInput, Headers: map[string]string{"host": "civitai.example"}, Node: json.RawMessage(node),
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+ProcedureInfinite, strings.NewReader(string(b))))
	return w.Code
}

// An infinite sample is computed by its own compute (never the gallery's), compared as a superjson
// envelope, classified by image id, and every series it touches carries feed_endpoint="infinite".
func TestInfiniteShadowSampleIsLabelledAndClassifiedByImage(t *testing.T) {
	reg := prometheus.NewRegistry()
	var seen *http.Request
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the gallery compute must not run for an infinite sample")
		return nil, nil
	})
	s.computeInfiniteFn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = r
		return &computed{payload: []byte(`{"json":{"items":[{"id":1},{"id":2}],"source":"feed"}}`)}, nil
	}
	h := http.HandlerFunc(s.ShadowInfiniteHandler)
	result := func(r string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointInfinite, "result": r})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	// The same images in another order: `order` (Classify, which reads postId, would say fields).
	if code := postInfinite(t, h, `{"json":{"items":[{"id":2},{"id":1}],"source":"feed"}}`); code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", code)
	}
	waitFor(t, "the infinite order result", result("order"))
	if seen == nil || seen.URL.Path != "/api/trpc/image.getInfinite" || seen.URL.Query().Get("input") != infiniteInput || seen.Host != "civitai.example" {
		t.Fatalf("synthetic request = %+v", seen)
	}
	// A different image: membership.
	postInfinite(t, h, `{"json":{"items":[{"id":1},{"id":3}],"source":"feed"}}`)
	waitFor(t, "the infinite membership result", result("membership"))
	// Same images, same order, a field differs: fields, counted by its flat category.
	postInfinite(t, h, `{"json":{"items":[{"id":1},{"id":2}],"source":"db"}}`)
	waitFor(t, "the infinite fields result", result("fields"))
	if n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointInfinite, "category": "source", "kind": "value"}); n != 1 {
		t.Fatalf("source diff count = %v, want 1", n)
	}
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", map[string]string{"feed_endpoint": EndpointInfinite, "phase": "compute", "outcome": "served"}); n != 3 {
		t.Fatalf("infinite compute phases = %v, want 3", n)
	}
	for _, e := range []string{EndpointAsPosts, EndpointV1Images} {
		for _, r := range []string{"order", "membership", "fields"} {
			if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": r}); found {
				t.Fatalf("an infinite sample was counted under %s/%s", e, r)
			}
		}
	}
}

func TestInfiniteShadowWithoutDepsFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil) // no Infinite deps, no test compute: the real computeInfinite runs
	postInfinite(t, http.HandlerFunc(s.ShadowInfiniteHandler), `{"json":{"items":[]}}`)
	waitFor(t, "the unsupported result", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointInfinite, "result": "unsupported"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointInfinite, "mode": "shadow", "reason": "infinite-unconfigured"}); n != 1 {
		t.Fatalf("fallback infinite-unconfigured = %v, want 1", n)
	}
}

// The early refusals of computeInfinite, before any store is read.
func TestComputeInfiniteEarlyFallbacks(t *testing.T) {
	s := &Server{Infinite: &feed.InfiniteDeps{}}
	mk := func(method, input string, hdr map[string]string) *http.Request {
		u := "/api/trpc/" + ProcedureInfinite + "?input=" + url.QueryEscape(input)
		r := httptest.NewRequestWithContext(context.Background(), method, u, nil)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	cases := []struct {
		name string
		r    *http.Request
		want string
	}{
		{"a POST", mk(http.MethodPost, `{"json":{}}`, nil), "method"},
		{"an undecodable input", mk(http.MethodGet, `not json`, nil), "input-envelope"},
		{"a hat sort", mk(http.MethodGet, `{"json":{"hatSort":"most"}}`, nil), "infinite-hat-turf"},
		{"a hub", mk(http.MethodGet, `{"json":{"hubId":4}}`, nil), "input-hubId"},
		{"a verified crawler", mk(http.MethodGet, `{"json":{}}`, map[string]string{verifiedBotHeader: "1"}), "verified-bot"},
	}
	for _, c := range cases {
		_, err := s.computeInfinite(context.Background(), c.r)
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
	}
}

// The compare path is on the internal listener; the public listener's image.getInfinite route is the
// serving one (ServeInfiniteHTTP, TestPublicMuxRoutesInfinite), never the compare handler.
func TestInfiniteShadowRouteOnInternalMux(t *testing.T) {
	s := muxServer()
	s.computeInfiniteFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"json":{"items":[]}}`)}, nil
	}
	internal := InternalMux(s, okHandler(), false)
	if code := postInfinite(t, internal, `{"json":{"items":[]}}`); code != http.StatusAccepted {
		t.Fatalf("internal compare path: %d, want 202", code)
	}
	if code := statusOf(PublicMux(s), "/internal/shadow/"+ProcedureInfinite); code != http.StatusNotFound {
		t.Fatalf("public /internal/shadow/%s: %d, want 404", ProcedureInfinite, code)
	}
	waitFor(t, "the sample to finish", func() bool { return len(s.ShadowQueue) == 0 })
}

// Every endpoint's dropped counter and deadline result start at 0, the new one included.
func TestEveryEndpointIsSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, e := range Endpoints {
		if v, found := metricValue(t, reg, "feed_go_shadow_dropped_total", map[string]string{"feed_endpoint": e}); !found || v != 0 {
			t.Errorf("dropped{%s} = %v found=%v, want a 0 series", e, v, found)
		}
		if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": "deadline"}); !found || v != 0 {
			t.Errorf("compare{%s,deadline} = %v found=%v, want a 0 series", e, v, found)
		}
	}
}

func TestSyntheticInfiniteRequest(t *testing.T) {
	r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: infiniteInput, Headers: map[string]string{"host": "h.example", "cf-ipcountry": "GB"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.URL.Path != "/api/trpc/image.getInfinite" || r.URL.Query().Get("input") != infiniteInput || r.Host != "h.example" || r.Header.Get("cf-ipcountry") != "GB" {
		t.Fatalf("synthetic request: %s %q host=%q", r.URL.Path, r.URL.RawQuery, r.Host)
	}
	// The gallery's is unchanged.
	g, _ := SyntheticRequest(context.Background(), ShadowRequest{Input: infiniteInput})
	if g.URL.Path != "/api/trpc/"+Procedure {
		t.Fatalf("gallery synthetic path = %s", g.URL.Path)
	}
}
