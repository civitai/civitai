package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// X-Feed-Go-Served names who produced a public route's answer. A client comparing this route with the
// Node route reads it: a proxied answer is Node's own bytes, and must never be counted as Go matching
// Node. The header name and both values are a wire contract with that client, so they are literals.

func servedBy(w *httptest.ResponseRecorder) []string { return w.Header().Values("X-Feed-Go-Served") }

func TestServedByGoOnAComputedAnswer(t *testing.T) {
	fb := &proxyRecorder{}
	s := serveServer(prometheus.NewRegistry(), served(&trpc.SignedOutTTL), fb)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusOK || fb.calls != 0 {
		t.Fatalf("code=%d proxied=%d, want 200 and 0", w.Code, fb.calls)
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "go" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"go\"]", got)
	}
}

// Every reason serve hands a request to the Node app ends at the same proxy call, so each must carry
// `node`: a compute error, a fallback the compute returns, a refused origin, and a serve switch off.
func TestServedByNodeOnEveryFallback(t *testing.T) {
	cases := []struct {
		name  string
		fn    func(context.Context, *http.Request) (*computed, error)
		setup func(*Server, *http.Request)
	}{
		{name: "compute error", fn: func(context.Context, *http.Request) (*computed, error) {
			return nil, errors.New("replica on fire")
		}},
		{name: "fallback from compute", fn: func(context.Context, *http.Request) (*computed, error) {
			return nil, fallback.New("unported-filter")
		}},
		{name: "origin refused", fn: served(nil), setup: func(_ *Server, r *http.Request) {
			r.Header.Set("Origin", "https://elsewhere.example")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := &proxyRecorder{}
			s := serveServer(prometheus.NewRegistry(), tc.fn, fb)
			r := publicRequest()
			if tc.setup != nil {
				tc.setup(s, r)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != http.StatusTeapot || fb.calls != 1 {
				t.Fatalf("code=%d proxied=%d, want the proxy's 418 and 1", w.Code, fb.calls)
			}
			if got := servedBy(w); len(got) != 1 || got[0] != "node" {
				t.Fatalf("X-Feed-Go-Served = %q, want [\"node\"]", got)
			}
		})
	}
}

func TestServedByNodeWhenAServeSwitchIsOff(t *testing.T) {
	s := muxServer()
	fb := &proxyRecorder{}
	s.Fallback = fb
	public := PublicMux(s)
	for _, path := range []string{"/api/trpc/model.getAll", "/api/trpc/image.getInfinite"} {
		w := httptest.NewRecorder()
		public.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path+"?input=%7B%7D", nil))
		if w.Code != http.StatusTeapot {
			t.Fatalf("%s: code=%d, want the proxy's 418", path, w.Code)
		}
		if got := servedBy(w); len(got) != 1 || got[0] != "node" {
			t.Fatalf("%s: X-Feed-Go-Served = %q, want [\"node\"]", path, got)
		}
	}
	if fb.calls != 2 {
		t.Fatalf("proxied=%d, want 2", fb.calls)
	}
}

// With no Node app to hand to, this service answers the error itself: that answer is Go's.
func TestServedByGoOnTheUnavailableAnswer(t *testing.T) {
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, errors.New("replica on fire")
	}, nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d, want 503", w.Code)
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "go" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"go\"]", got)
	}
}

// Through a real reverse proxy: the header set before the hop survives the Node app's own headers
// being copied in, and is on the proxy's 502 when the Node app cannot be reached.
func TestServedByNodeThroughARealReverseProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(`{"result":{"data":{"json":{"from":"node"}}}}`))
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	fail := func(context.Context, *http.Request) (*computed, error) { return nil, fallback.New("unported-filter") }

	s := serveServer(prometheus.NewRegistry(), fail, httputil.NewSingleHostReverseProxy(target))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusOK || w.Body.String() != `{"result":{"data":{"json":{"from":"node"}}}}` {
		t.Fatalf("code=%d body=%s, want the Node app's 200 answer", w.Code, w.Body.String())
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"node\"]", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q: the Node app's headers were not passed through", got)
	}

	upstream.Close()
	s = serveServer(prometheus.NewRegistry(), fail, httputil.NewSingleHostReverseProxy(target))
	w = httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusBadGateway {
		t.Fatalf("code=%d, want the proxy's 502", w.Code)
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served on the 502 = %q, want [\"node\"]", got)
	}
}
