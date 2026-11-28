package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

// Off at rate 0 (FEED_GO_SERVE_PARITY_SAMPLE_RATE unset) or without any upstream; on, its replays
// reach each route's own fallback target with the request's own path, query and Host: the tRPC
// routes' (FEED_GO_FALLBACK_URL) through Upstream, the model routes' (FEED_GO_V1_FALLBACK_URL)
// through V1Upstream, site search's (FEED_GO_SEARCH_FALLBACK_URL) through SearchUpstream; a target
// left unset leaves that upstream nil. 4 slots and a 10 s deadline
// (literals: the constants are the only setting).
func TestNewServeParity(t *testing.T) {
	target, _ := url.Parse("http://node.test")
	if p := newServeParity(0, target, target, target, nil); p != nil {
		t.Fatalf("rate 0: %+v, want nil (off)", p)
	}
	if p := newServeParity(0.5, nil, nil, nil, nil); p != nil {
		t.Fatalf("no target: %+v, want nil (off)", p)
	}
	type hit struct{ app, url, host string }
	var (
		mu   sync.Mutex
		hits []hit
	)
	app := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			hits = append(hits, hit{name, r.URL.String(), r.Host})
			mu.Unlock()
			w.WriteHeader(http.StatusTeapot)
		}))
	}
	trpcApp, v1App, searchApp := app("trpc"), app("v1"), app("search")
	defer trpcApp.Close()
	defer v1App.Close()
	defer searchApp.Close()
	trpcTarget, _ := url.Parse(trpcApp.URL)
	v1Target, _ := url.Parse(v1App.URL)
	searchTarget, _ := url.Parse(searchApp.URL)
	p := newServeParity(0.005, trpcTarget, v1Target, searchTarget, nil)
	if p == nil || p.Rate != 0.005 || cap(p.Queue) != 4 || p.Timeout != 10*time.Second || p.Upstream == nil || p.V1Upstream == nil || p.SearchUpstream == nil {
		t.Fatalf("on: %+v, want rate 0.005, 4 slots, 10s, all three upstreams", p)
	}
	send := func(h http.Handler, method, target string) int {
		r := httptest.NewRequestWithContext(context.Background(), method, target, nil)
		r.Host = "civitai.example"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	c1 := send(p.Upstream, http.MethodGet, "/api/trpc/model.getAll?input=%7B%7D")
	c2 := send(p.V1Upstream, http.MethodGet, "/api/v1/models?limit=2")
	c3 := send(p.SearchUpstream, http.MethodPost, "/api/search/multi-search")
	if c1 != http.StatusTeapot || c2 != http.StatusTeapot || c3 != http.StatusTeapot {
		t.Fatalf("codes %d, %d, %d, want 418, 418, 418", c1, c2, c3)
	}
	mu.Lock()
	got := append([]hit(nil), hits...)
	mu.Unlock()
	want := []hit{{"trpc", "/api/trpc/model.getAll?input=%7B%7D", "civitai.example"}, {"v1", "/api/v1/models?limit=2", "civitai.example"},
		{"search", "/api/search/multi-search", "civitai.example"}}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("replays reached %+v, want %+v", got, want)
	}
	// Any target alone: only its upstream is set.
	if p := newServeParity(0.005, trpcTarget, nil, nil, nil); p == nil || p.Upstream == nil || p.V1Upstream != nil || p.SearchUpstream != nil {
		t.Fatalf("tRPC target only: %+v, want Upstream set, V1Upstream and SearchUpstream nil", p)
	}
	if p := newServeParity(0.005, nil, v1Target, nil, nil); p == nil || p.Upstream != nil || p.V1Upstream == nil || p.SearchUpstream != nil {
		t.Fatalf("v1 target only: %+v, want V1Upstream set, Upstream and SearchUpstream nil", p)
	}
	if p := newServeParity(0.005, nil, nil, searchTarget, nil); p == nil || p.Upstream != nil || p.V1Upstream != nil || p.SearchUpstream == nil {
		t.Fatalf("search target only: %+v, want SearchUpstream set, Upstream and V1Upstream nil", p)
	}
}
