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

// Off at rate 0 (FEED_GO_SERVE_PARITY_SAMPLE_RATE unset) or without an upstream; on, its replays
// reach the fallback target with the request's own path, query and Host, and its queue holds the
// configured slots (at least one).
func TestNewServeParity(t *testing.T) {
	target, _ := url.Parse("http://node.test")
	if p := newServeParity(0, 4, time.Second, target, nil); p != nil {
		t.Fatalf("rate 0: %+v, want nil (off)", p)
	}
	if p := newServeParity(0.5, 4, time.Second, nil, nil); p != nil {
		t.Fatalf("no target: %+v, want nil (off)", p)
	}
	var (
		mu              sync.Mutex
		gotURL, gotHost string
	)
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotURL, gotHost = r.URL.String(), r.Host
		mu.Unlock()
		w.WriteHeader(http.StatusTeapot)
	}))
	defer node.Close()
	target, _ = url.Parse(node.URL)
	p := newServeParity(0.005, 0, 3*time.Second, target, nil)
	if p == nil || p.Rate != 0.005 || cap(p.Queue) != 1 || p.Timeout != 3*time.Second {
		t.Fatalf("on: %+v, want rate 0.005, 1 slot (workers 0 -> 1), 3s", p)
	}
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/model.getAll?input=%7B%7D", nil)
	r.Host = "civitai.example"
	w := httptest.NewRecorder()
	p.Upstream.ServeHTTP(w, r)
	mu.Lock()
	defer mu.Unlock()
	if w.Code != http.StatusTeapot || gotURL != "/api/trpc/model.getAll?input=%7B%7D" || gotHost != "civitai.example" {
		t.Fatalf("replay reached code=%d url=%q host=%q", w.Code, gotURL, gotHost)
	}
}
