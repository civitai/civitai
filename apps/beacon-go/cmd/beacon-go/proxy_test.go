package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestFallbackProxyForwarding pins what the Node app receives from the fallback proxy. Expected
// values are written out by hand, not from the proxy's output: the original Host, the target's base path
// joined with the request path, the query forwarded byte for byte (a raw `;` and a bad `%` escape
// included: Rewrite mode alone would re-encode it), the inbound X-Forwarded-Host/-Proto and Forwarded
// passed through untouched, the client address appended to the inbound X-Forwarded-For chain,
// hop-by-hop headers dropped, and no Go default User-Agent added.
func TestFallbackProxyForwarding(t *testing.T) {
	seen := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL + "/base")
	if err != nil {
		t.Fatal(err)
	}

	const rawQuery = `input=%7B%22q%22%3A%22100%%22%7D&a=1;b=2`
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://green.example.test/api/trpc/image.getImagesAsPostsInfinite?"+rawQuery, nil)
	req.RemoteAddr = "192.0.2.1:5555"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "green.example.test")
	req.Header.Set("Forwarded", "for=203.0.113.7;proto=https")
	req.Header.Set("Cookie", "__Secure-civ-token=abc")
	req.Header.Set("Connection", "X-Hop")
	req.Header.Set("X-Hop", "dropped")
	w := httptest.NewRecorder()
	fallbackProxy(target).ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", w.Code)
	}
	got := <-seen

	if got.Host != "green.example.test" {
		t.Errorf("Host = %q, want the original green.example.test", got.Host)
	}
	if got.URL.Path != "/base/api/trpc/image.getImagesAsPostsInfinite" {
		t.Errorf("path = %q, want /base/api/trpc/image.getImagesAsPostsInfinite", got.URL.Path)
	}
	if req.URL.RawQuery != rawQuery {
		t.Fatalf("test setup: the inbound query was parsed to %q", req.URL.RawQuery)
	}
	if got.URL.RawQuery != rawQuery {
		t.Errorf("RawQuery = %q, want it verbatim: %q", got.URL.RawQuery, rawQuery)
	}
	for h, want := range map[string]string{
		"X-Forwarded-For":   "203.0.113.7, 192.0.2.1",
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "green.example.test",
		"Forwarded":         "for=203.0.113.7;proto=https",
		"Cookie":            "__Secure-civ-token=abc",
		"X-Hop":             "",
		"User-Agent":        "",
	} {
		if v := got.Header.Get(h); v != want {
			t.Errorf("%s = %q, want %q", h, v, want)
		}
	}
}

// Without an inbound X-Forwarded-For the chain starts at the client address.
func TestFallbackProxyStartsTheForwardedChain(t *testing.T) {
	seen := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(r.Context())
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://blue.example.test/x", nil)
	req.RemoteAddr = "198.51.100.9:1234"
	fallbackProxy(target).ServeHTTP(httptest.NewRecorder(), req)
	got := <-seen
	if v := got.Header.Get("X-Forwarded-For"); v != "198.51.100.9" {
		t.Errorf("X-Forwarded-For = %q, want 198.51.100.9", v)
	}
	if v := got.Header.Get("X-Forwarded-Proto"); v != "" {
		t.Errorf("X-Forwarded-Proto = %q, want none (nothing inbound to pass through)", v)
	}
	if got.Host != "blue.example.test" {
		t.Errorf("Host = %q", got.Host)
	}
}

// A forwarding header the inbound Connection header names is hop-by-hop: it is not passed through,
// and a hop-by-hop X-Forwarded-For contributes no prior chain.
func TestFallbackProxyDropsForwardingHeadersNamedInConnection(t *testing.T) {
	seen := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(r.Context())
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://green.example.test/x", nil)
	req.RemoteAddr = "192.0.2.1:5555"
	req.Header.Set("Connection", "x-forwarded-proto, X-Forwarded-For,forwarded")
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "green.example.test")
	req.Header.Set("Forwarded", "for=203.0.113.7")
	fallbackProxy(target).ServeHTTP(httptest.NewRecorder(), req)
	got := <-seen
	for h, want := range map[string]string{
		"X-Forwarded-For":   "192.0.2.1",
		"X-Forwarded-Proto": "",
		"Forwarded":         "",
		"X-Forwarded-Host":  "green.example.test", // not named: passed through
	} {
		if v := got.Header.Get(h); v != want {
			t.Errorf("%s = %q, want %q", h, v, want)
		}
	}
}
