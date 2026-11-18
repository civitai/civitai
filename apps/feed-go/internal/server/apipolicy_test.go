package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Fixed rules, so the cases do not depend on today's date: GB and the US state CA are blocked (dates
// long past), FR is only blocked from a date far in the future.
func blockRules(t *testing.T) []browsing.RegionRule {
	t.Helper()
	rules, err := config.ParseRegionRules("GB:2020-01-01,US:CA:2020-01-01,FR:2999-01-01")
	if err != nil {
		t.Fatal(err)
	}
	return rules
}

// applyApiRequestPolicy runs first on the tRPC route: a request from a blocked region (getRegion's
// headers) is handed to the app, which answers its 451, and never computed here. Each header
// combination getRegion reads.
func TestServeHTTPHandsABlockedRegionToTheApp(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		blocked bool
	}{
		{"cf-ipcountry blocked", map[string]string{"cf-ipcountry": "GB"}, true},
		{"x-isuk true overrides the country", map[string]string{"cf-ipcountry": "US", "x-isuk": "true"}, true},
		{"x-isuk 1", map[string]string{"x-isuk": "1"}, true},
		{"x-isuk other value ignored", map[string]string{"cf-ipcountry": "US", "x-isuk": "yes"}, false},
		{"US state on the list", map[string]string{"cf-ipcountry": "US", "cf-region-code": "CA"}, true},
		{"US state not on the list", map[string]string{"cf-ipcountry": "US", "cf-region-code": "NY"}, false},
		{"US without a state", map[string]string{"cf-ipcountry": "US"}, false},
		{"region code outside the US ignored", map[string]string{"cf-ipcountry": "DE", "cf-region-code": "CA"}, false},
		{"block date not reached", map[string]string{"cf-ipcountry": "FR"}, false},
		{"no region headers", nil, false},
	}
	for _, c := range cases {
		reg := prometheus.NewRegistry()
		fb := &proxyRecorder{}
		calls := 0
		s := serveServer(reg, func(ctx context.Context, r *http.Request) (*computed, error) {
			calls++
			return served(nil)(ctx, r)
		}, fb)
		s.RegionBlockRules = blockRules(t)
		r := publicRequest()
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if c.blocked {
			if fb.calls != 1 || calls != 0 || fallbackCount(t, reg, "region-blocked") != 1 {
				t.Errorf("%s: proxied=%d computed=%d region-blocked=%v, want 1, 0, 1", c.name, fb.calls, calls,
					fallbackCount(t, reg, "region-blocked"))
			}
			// The app answers its 451 before tRPC runs, so without tRPC's Vary: none is added here.
			if got := w.Header().Values("Vary"); len(got) != 0 {
				t.Errorf("%s: a region-blocked (proxied) answer got Vary %q from this service", c.name, got)
			}
			continue
		}
		if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "trpc-accept, accept" {
			t.Errorf("%s: served answer Vary = %q, want [\"trpc-accept, accept\"]", c.name, got)
		}
		if fb.calls != 0 || calls != 1 {
			t.Errorf("%s: proxied=%d computed=%d, want served here", c.name, fb.calls, calls)
		}
	}
}

// The block is checked before the origin, as on the app (applyApiRequestPolicy is the route's first
// step): an off-list origin from a blocked region is still `region-blocked`.
func TestServeHTTPRegionBlockComesBeforeTheOriginCheck(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	s := serveServer(reg, served(nil), fb)
	s.RegionBlockRules = blockRules(t)
	r := publicRequest()
	r.Header.Del("Origin")
	r.Header.Set("cf-ipcountry", "GB")
	s.ServeHTTP(httptest.NewRecorder(), r)
	if fallbackCount(t, reg, "region-blocked") != 1 || fallbackCount(t, reg, "origin") != 0 {
		t.Fatalf("region-blocked=%v origin=%v, want 1 and 0", fallbackCount(t, reg, "region-blocked"), fallbackCount(t, reg, "origin"))
	}
}

// The deployed default: with REGION_BLOCK_CONFIG unset the list is the app's DEFAULT_REGION_BLOCK_CONFIG
// (apipolicy.json), which blocks GB from 2025-07-24.
func TestServeHTTPDefaultBlockListBlocksGB(t *testing.T) {
	rules, err := config.RegionBlockRules("")
	if err != nil {
		t.Fatal(err)
	}
	if !browsing.IsRegionRestricted(rules, "GB", "", time.Date(2025, 7, 25, 0, 0, 0, 0, time.UTC)) {
		t.Fatal("the default list does not block GB after its effective date")
	}
	if browsing.IsRegionRestricted(rules, "GB", "", time.Date(2025, 7, 24, 12, 0, 0, 0, time.UTC)) {
		t.Fatal("the default list blocks GB before the end of its effective day")
	}
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	s := serveServer(reg, served(nil), fb)
	s.RegionBlockRules = rules
	r := publicRequest()
	r.Header.Set("x-isuk", "true")
	s.ServeHTTP(httptest.NewRecorder(), r)
	if fb.calls != 1 || fallbackCount(t, reg, "region-blocked") != 1 {
		t.Fatalf("x-isuk under the default list: proxied=%d, want handed to the app", fb.calls)
	}
}

// A user agent verifyBot could verify goes to the app, which decides the verified-crawler header from
// the IP ranges only it holds; any other user agent is served here.
func TestServeHTTPHandsACrawlerUserAgentToTheApp(t *testing.T) {
	cases := []struct {
		ua      string
		crawler bool
	}{
		{"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", true},
		{"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", true},
		{"AdsBot-Google (+http://www.google.com/adsbot.html)", true},
		{"mozilla/5.0 (compatible; GOOGLEBOT/2.1)", true}, // the patterns are case-insensitive
		{"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", false},
		{"", false},
	}
	for _, c := range cases {
		reg := prometheus.NewRegistry()
		fb := &proxyRecorder{}
		s := serveServer(reg, served(nil), fb)
		r := publicRequest()
		if c.ua != "" {
			r.Header.Set("User-Agent", c.ua)
		}
		s.ServeHTTP(httptest.NewRecorder(), r)
		if got := fb.calls == 1 && fallbackCount(t, reg, "crawler-user-agent") == 1; got != c.crawler {
			t.Errorf("UA %q: handed to the app = %v, want %v", c.ua, got, c.crawler)
		}
	}
}

// The response headers applyApiRequestPolicy and responseMeta leave on a served answer: Cache-Control
// is the app's private default unless the answer is edge-cacheable (signed out), for each viewer kind.
func TestServeHTTPCacheControlByAnswer(t *testing.T) {
	for _, c := range []struct {
		name string
		ttl  *trpc.CacheTTL
		want string
	}{
		{"signed out (edge-cacheable)", &trpc.SignedOutTTL, "public, max-age=60, s-maxage=60, stale-while-revalidate=30"},
		{"session user (not cacheable)", nil, "max-age=0, private, no-cache"},
		{"zero edge TTL", &trpc.CacheTTL{Browser: 60}, "max-age=0, private, no-cache"},
	} {
		s := serveServer(prometheus.NewRegistry(), served(c.ttl), &proxyRecorder{})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, publicRequest())
		if got := w.Header().Get("Cache-Control"); got != c.want {
			t.Errorf("%s: Cache-Control = %q, want %q", c.name, got, c.want)
		}
	}
}
