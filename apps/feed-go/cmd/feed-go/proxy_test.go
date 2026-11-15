package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestFallbackProxyForwarding pins what the Node app receives from the fallback proxy. Expected
// values are written out from net/http/httputil's documented Director-mode behaviour (the form this
// proxy was first written in), not from the proxy's output: the original Host, the target's base path
// joined with the request path, the query kept, the inbound X-Forwarded-Host/-Proto and Forwarded
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

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://green.example.test/api/trpc/image.getImagesAsPostsInfinite?input=%7B%7D", nil)
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
	if got.URL.Path != "/base/api/trpc/image.getImagesAsPostsInfinite" || got.URL.RawQuery != "input=%7B%7D" {
		t.Errorf("URL = %s, want /base/api/trpc/image.getImagesAsPostsInfinite?input=%%7B%%7D", got.URL)
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
