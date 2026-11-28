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
// through V1Upstream; a target left unset leaves that upstream nil. 4 slots and a 10 s deadline
// (literals: the constants are the only setting).
func TestNewServeParity(t *testing.T) {
	target, _ := url.Parse("http://node.test")
	if p := newServeParity(0, target, target, nil); p != nil {
		t.Fatalf("rate 0: %+v, want nil (off)", p)
	}
	if p := newServeParity(0.5, nil, nil, nil); p != nil {
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
	trpcApp, v1App := app("trpc"), app("v1")
	defer trpcApp.Close()
	defer v1App.Close()
	trpcTarget, _ := url.Parse(trpcApp.URL)
	v1Target, _ := url.Parse(v1App.URL)
	p := newServeParity(0.005, trpcTarget, v1Target, nil)
	if p == nil || p.Rate != 0.005 || cap(p.Queue) != 4 || p.Timeout != 10*time.Second || p.Upstream == nil || p.V1Upstream == nil {
		t.Fatalf("on: %+v, want rate 0.005, 4 slots, 10s, both upstreams", p)
	}
	send := func(h http.Handler, target string) int {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
		r.Host = "civitai.example"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c1, c2 := send(p.Upstream, "/api/trpc/model.getAll?input=%7B%7D"), send(p.V1Upstream, "/api/v1/models?limit=2"); c1 != http.StatusTeapot || c2 != http.StatusTeapot {
		t.Fatalf("codes %d, %d, want 418, 418", c1, c2)
	}
	mu.Lock()
	got := append([]hit(nil), hits...)
	mu.Unlock()
	want := []hit{{"trpc", "/api/trpc/model.getAll?input=%7B%7D", "civitai.example"}, {"v1", "/api/v1/models?limit=2", "civitai.example"}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("replays reached %+v, want %+v", got, want)
	}
	// Either target alone: only its upstream is set.
	if p := newServeParity(0.005, trpcTarget, nil, nil); p == nil || p.Upstream == nil || p.V1Upstream != nil {
		t.Fatalf("tRPC target only: %+v, want Upstream set, V1Upstream nil", p)
	}
	if p := newServeParity(0.005, nil, v1Target, nil); p == nil || p.Upstream != nil || p.V1Upstream == nil {
		t.Fatalf("v1 target only: %+v, want Upstream nil, V1Upstream set", p)
	}
}
