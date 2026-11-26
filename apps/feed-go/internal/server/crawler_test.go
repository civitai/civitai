package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const (
	browserUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	crawlerUA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
)

// verifiedCrawler: on a Node sample the header is the app's own decision, read as
// parseVerifiedBotHeader reads it (`googlebot` / `bingbot`, nothing else); on a public request (a
// crawler's user agent was handed back by apiRequestPolicy before this) no header makes a crawler: the
// app's policy strips it.
func TestVerifiedCrawler(t *testing.T) {
	sampled := func(hdr map[string]string) *http.Request {
		r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: `{"json":{}}`, Headers: hdr})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	public := func(hdr map[string]string) *http.Request {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+ProcedureInfinite, nil)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	for _, c := range []struct {
		name    string
		r       *http.Request
		crawler bool
	}{
		{"sample: googlebot", sampled(map[string]string{verifiedBotHeader: "googlebot"}), true},
		{"sample: bingbot", sampled(map[string]string{verifiedBotHeader: "bingbot"}), true},
		{"sample: a value the app does not name", sampled(map[string]string{verifiedBotHeader: "1"}), false},
		{"sample: another case", sampled(map[string]string{verifiedBotHeader: "Googlebot"}), false},
		{"sample: no header", sampled(nil), false},
		{"sample: a crawler's user agent the app did not verify", sampled(map[string]string{"user-agent": crawlerUA}), false},
		{"public: a spoofed header, a browser", public(map[string]string{verifiedBotHeader: "googlebot", "User-Agent": browserUA}), false},
		{"public: a spoofed header, no user agent", public(map[string]string{verifiedBotHeader: "googlebot"}), false},
	} {
		if got := verifiedCrawler(c.r); got != c.crawler {
			t.Errorf("%s: crawler %v, want %v", c.name, got, c.crawler)
		}
	}
}

// computeInfinite for a verified crawler (a Node sample carrying the app's header): signed in for the
// cap where NSFW is viewable (requestDomainBrowsingLevelCap), signed out elsewhere, never a viewer, and
// never edge-cached (createContext); the response headers are then the app's private ones, as for a
// session. A header the app does not name, or a public request's spoofed header, is a signed-out
// visitor: the public cap and the public cache.
func TestComputeInfiniteVerifiedCrawler(t *testing.T) {
	f := newComputeFixture(t)
	f.s.Infinite = &feed.InfiniteDeps{Deps: f.s.Deps}
	const input = `{"json":{"browsingLevel":31,"sort":"Newest","limit":10,"disablePoi":true}}`
	sampled := func(hdr map[string]string) *http.Request {
		r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: input, Headers: hdr})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	public := func(host string, hdr map[string]string) *http.Request {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+ProcedureInfinite+"?input="+url.QueryEscape(input), nil)
		r.Host = host
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	const (
		all    = "levels=1%2C2%2C4%2C8%2C16&excludePoi=1&sort=newest&limit=10"
		pg     = "levels=1&excludePoi=1&sort=newest&limit=10"
		viewer = "levels=1%2C2%2C4%2C8%2C16&excludePoi=1&viewerId=42&sort=newest&limit=10"
	)
	private := map[string]string{"cache-control": apipolicy.PrivateCacheControl(), "vary": trpc.Vary}
	for _, c := range []struct {
		name      string
		r         *http.Request
		query     string
		cacheable bool
	}{
		{"a crawler on an NSFW host", sampled(map[string]string{"host": "red.example", verifiedBotHeader: "googlebot"}), all, false},
		{"bingbot on an NSFW host", sampled(map[string]string{"host": "red.example", verifiedBotHeader: "bingbot"}), all, false},
		{"a crawler on the SFW host", sampled(map[string]string{"host": "green.example", verifiedBotHeader: "googlebot"}), pg, false},
		{"a crawler from a restricted region", sampled(map[string]string{"host": "red.example", verifiedBotHeader: "googlebot", "cf-ipcountry": "GB"}), pg, false},
		{"a crawler with a session", sampled(map[string]string{"host": "red.example", verifiedBotHeader: "googlebot", "cookie": "civ-token=" + f.token(t, 42)}), viewer, false},
		{"a header the app does not name", sampled(map[string]string{"host": "red.example", verifiedBotHeader: "1"}), pg, true},
		{"no header (control)", sampled(map[string]string{"host": "red.example"}), pg, true},
		{"a public request's spoofed header", public("red.example", map[string]string{verifiedBotHeader: "googlebot", "User-Agent": browserUA}), pg, true},
	} {
		f.feed.queries = nil
		out, err := f.s.computeInfinite(context.Background(), c.r)
		if err != nil {
			t.Errorf("%s: %v (reason %q)", c.name, err, fallback.Reason(err))
			continue
		}
		if !reflect.DeepEqual(f.feed.queries, []string{c.query}) {
			t.Errorf("%s: feed queries %q, want [%q]", c.name, f.feed.queries, c.query)
		}
		// The per-class shadow series: a crawler with no session is `crawler`, with one `user`; the rest
		// (no verified crawler) are signed-out visitors.
		wantClass := "anon"
		switch {
		case c.name == "a crawler with a session":
			wantClass = "user"
		case !c.cacheable:
			wantClass = "crawler"
		}
		if out.viewerClass != wantClass {
			t.Errorf("%s: viewer class %q, want %q", c.name, out.viewerClass, wantClass)
		}
		headers := trpc.ResultHeaders(out.ttl)
		if c.cacheable {
			if out.ttl == nil || *out.ttl != trpc.SignedOutTTL || reflect.DeepEqual(headers, private) {
				t.Errorf("%s: ttl %v headers %v, want the public policy", c.name, out.ttl, headers)
			}
		} else if out.ttl != nil || !reflect.DeepEqual(headers, private) {
			t.Errorf("%s: ttl %v headers %v, want none and %v", c.name, out.ttl, headers, private)
		}
	}
}
