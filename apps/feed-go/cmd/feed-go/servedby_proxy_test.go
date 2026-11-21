package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// X-Feed-Go-Served through the production fallback proxy (fallbackProxy, with its own Rewrite and
// ErrorHandler), not a stand-in: `node` on the Node app's answer and on the proxy's own 502. The
// browser's shadow compare treats anything but `go` as a fallback, so a proxy change that dropped the
// header would make a Node answer unreadable as one. Literals: the header is a wire contract.
func TestServedByNodeThroughTheProductionFallbackProxy(t *testing.T) {
	const nodeBody = `{"result":{"data":{"json":{"from":"node"}}}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(nodeBody))
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var reasons []string
	srv := &server.Server{
		Metrics: server.NewMetrics(prometheus.NewRegistry()),
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Fallback: fallbackProxy(target, fallbackIdleTimeout, func(_ *http.Request, reason string, _ error) {
			mu.Lock()
			reasons = append(reasons, reason)
			mu.Unlock()
		}, nil),
	}
	// model.getAll with its serve switch off (the zero value): every request is proxied.
	get := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		srv.ServeModelGetAllHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
			"http://site.example/api/trpc/model.getAll?input=%7B%7D", nil))
		return w
	}

	w := get()
	if w.Code != http.StatusOK || w.Body.String() != nodeBody {
		t.Fatalf("code=%d body=%s, want the Node app's 200 answer", w.Code, w.Body.String())
	}
	if got := w.Header().Values("X-Feed-Go-Served"); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"node\"]", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q: the Node app's headers were not passed through", got)
	}

	upstream.Close()
	w = get()
	if w.Code != http.StatusBadGateway {
		t.Fatalf("code=%d, want the proxy's 502", w.Code)
	}
	if got := w.Header().Values("X-Feed-Go-Served"); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served on the proxy's 502 = %q, want [\"node\"]", got)
	}
	mu.Lock()
	defer mu.Unlock()
	// Positive control: the 502 is the production ErrorHandler's, not some other path's.
	if len(reasons) != 1 || reasons[0] != proxyErrorUpstream {
		t.Fatalf("onError reasons = %q, want [%q]", reasons, proxyErrorUpstream)
	}
}
