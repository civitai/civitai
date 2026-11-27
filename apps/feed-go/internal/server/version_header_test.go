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
)

// X-Feed-Go-Version names the feed-go release that handled a public request. The web client's shadow
// compare records it, so an answer an edge or browser cache kept names the binary that produced it.
// The header name is a wire contract with that client, so it is a literal here, never VersionHeader.

// testVersion is distinct from main's "dev" default and from any real release.
const testVersion = "9.8.7-header"

func versionOf(w *httptest.ResponseRecorder) []string { return w.Header().Values("X-Feed-Go-Version") }

func TestVersionHeaderOnAComputedAnswer(t *testing.T) {
	fb := &proxyRecorder{}
	s := serveServer(prometheus.NewRegistry(), served(nil), fb)
	s.Version = testVersion
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, publicRequest())
	if w.Code != http.StatusOK || fb.calls != 0 {
		t.Fatalf("code=%d proxied=%d, want 200 and 0", w.Code, fb.calls)
	}
	if got := versionOf(w); len(got) != 1 || got[0] != "9.8.7-header" {
		t.Fatalf("X-Feed-Go-Version = %q, want [\"9.8.7-header\"]", got)
	}
}

// A request handed back to the Node app carries the version too, through a real reverse proxy that
// copies in the Node app's own headers; and so does the answer this service writes when it cannot
// compute and has no Node app to hand to.
func TestVersionHeaderOnAHandedBackAnswer(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=0, s-maxage=60")
		_, _ = w.Write([]byte(`{"result":{"data":{"json":{"from":"node"}}}}`))
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	fail := func(context.Context, *http.Request) (*computed, error) { return nil, fallback.New("unported-filter") }
	s := serveServer(prometheus.NewRegistry(), fail, httputil.NewSingleHostReverseProxy(target))
	s.Version = testVersion
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, publicRequest())
	if w.Code != http.StatusOK || w.Body.String() != `{"result":{"data":{"json":{"from":"node"}}}}` {
		t.Fatalf("code=%d body=%s, want the Node app's 200 answer", w.Code, w.Body.String())
	}
	if got := w.Header().Values("X-Feed-Go-Served"); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"node\"]", got)
	}
	if got := versionOf(w); len(got) != 1 || got[0] != "9.8.7-header" {
		t.Fatalf("X-Feed-Go-Version = %q, want [\"9.8.7-header\"]", got)
	}

	s = serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, errors.New("replica on fire")
	}, nil)
	s.Version = testVersion
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, publicRequest())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d, want 503", w.Code)
	}
	if got := versionOf(w); len(got) != 1 || got[0] != "9.8.7-header" {
		t.Fatalf("X-Feed-Go-Version on the 503 = %q, want [\"9.8.7-header\"]", got)
	}
}

// Every public route, and a path none of them matches (the mux's 404), carries it: the header is set
// around the whole mux, not per route.
func TestVersionHeaderOnEveryPublicPath(t *testing.T) {
	s := muxServer()
	s.Fallback = &proxyRecorder{}
	s.Version = testVersion
	public := PublicMux(s)
	for _, path := range []string{"/api/trpc/model.getAll", "/api/trpc/image.getInfinite", "/api/trpc/not.aRoute", "/elsewhere"} {
		w := httptest.NewRecorder()
		public.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path+"?input=%7B%7D", nil))
		if got := versionOf(w); len(got) != 1 || got[0] != "9.8.7-header" {
			t.Fatalf("%s (code %d): X-Feed-Go-Version = %q, want [\"9.8.7-header\"]", path, w.Code, got)
		}
	}
}

// With no version set, nothing is sent: never an empty header value.
func TestVersionHeaderAbsentWithoutAVersion(t *testing.T) {
	s := serveServer(prometheus.NewRegistry(), served(nil), &proxyRecorder{})
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, publicRequest())
	if w.Code != http.StatusOK {
		t.Fatalf("code=%d, want 200", w.Code)
	}
	if got := versionOf(w); len(got) != 0 {
		t.Fatalf("X-Feed-Go-Version = %q, want none", got)
	}
}
