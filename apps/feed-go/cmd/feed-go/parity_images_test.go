package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

// FEED_GO_SERVE_PARITY_V1_IMAGES adds the images route's own upstream to a sampler that is on, and its
// replays reach that Node app with the request's own path and query; with the sampler off (nil) it
// turns nothing on, and with no target it sets nothing.
func TestWithImagesParity(t *testing.T) {
	var (
		mu   sync.Mutex
		hits []string
	)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.URL.String())
		mu.Unlock()
		w.WriteHeader(http.StatusTeapot)
	}))
	defer app.Close()
	target, _ := url.Parse(app.URL)
	if p := withImagesParity(nil, target, nil); p != nil {
		t.Fatalf("sampler off: %+v, want nil", p)
	}
	trpcTarget, _ := url.Parse("http://node.test")
	p := withImagesParity(newServeParity(0.005, trpcTarget, nil, nil), target, nil)
	if p == nil || p.V1ImagesUpstream == nil || p.Upstream == nil || p.V1Upstream != nil {
		t.Fatalf("on: %+v, want the images upstream beside the tRPC one", p)
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/images?limit=2", nil)
	w := httptest.NewRecorder()
	p.V1ImagesUpstream.ServeHTTP(w, r)
	mu.Lock()
	got := append([]string(nil), hits...)
	mu.Unlock()
	if w.Code != http.StatusTeapot || len(got) != 1 || got[0] != "/api/v1/images?limit=2" {
		t.Fatalf("code %d hits %v, want 418 and one /api/v1/images?limit=2", w.Code, got)
	}
	if q := withImagesParity(newServeParity(0.005, trpcTarget, nil, nil), nil, nil); q.V1ImagesUpstream != nil {
		t.Fatal("no images target set an upstream")
	}
}
