package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const computeIssuer = "https://auth.example.test"

// computeFeed is the feed service: it records each query and answers an empty page.
type computeFeed struct {
	mu      sync.Mutex
	queries []string
}

func (f *computeFeed) Fetch(_ context.Context, q string) (feedsvc.Answer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, q)
	return feedsvc.Answer{Status: 200}, nil
}

type computeFixture struct {
	s    *Server
	feed *computeFeed
	key  *ecdsa.PrivateKey
	now  time.Time
}

func jwkOf(k *ecdsa.PrivateKey) map[string]string {
	pad := func(b []byte) string {
		out := make([]byte, 32)
		copy(out[32-len(b):], b)
		return base64.RawURLEncoding.EncodeToString(out)
	}
	return map[string]string{"kty": "EC", "crv": "P-256", "kid": "k1", "use": "sig", "alg": "ES256",
		"x": pad(k.X.Bytes()), "y": pad(k.Y.Bytes())}
}

// newComputeFixture is a Server over the real resolver and feed handler: a JWKS served locally, the
// session cache and system redis as testkit fakes, and the feed service answering empty pages (no
// ids: nothing is hydrated, so no Postgres is needed). Hosts: green (SFW) and red (NSFW); GB is
// region restricted.
func newComputeFixture(t *testing.T) *computeFixture {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{jwkOf(k)}})
	}))
	t.Cleanup(jwks.Close)
	f := &computeFixture{feed: &computeFeed{}, key: k, now: time.Now()}
	cache, sys := testkit.NewRedis(), testkit.NewRedis()
	sys.SetString("system:browsing-setting-addons", []byte("[]")) // no addon exclusions: literal queries
	for id, v := range map[int]map[string]any{
		42: {"id": 42, "username": "viewer-a"},
		7:  {"id": 7, "username": "mod-a", "isModerator": true},
		43: {"id": 43, "username": "viewer-b", "bannedAt": time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)},
	} {
		b, err := msgpack.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		cache.SetString("session:data2:"+itoa(id), b)
	}
	f.s = &Server{
		Resolver: &auth.Resolver{
			Verifier:    &auth.Verifier{Issuer: computeIssuer, JWKSURL: jwks.URL, HTTP: jwks.Client()},
			Revocation:  &auth.Revocation{Redis: sys},
			Sessions:    &hydrate.PackedReader{Redis: cache},
			CookieNames: auth.FixedCookieNames("civ-token"),
		},
		Deps: &feed.Deps{
			DB:      &testkit.DB{},
			Gallery: &feed.GalleryStore{Cache: cache, DB: &testkit.DB{}},
			Addons:  &feed.AddonSource{Sys: sys},
			Feed:    f.feed,
			Config:  feed.Config{ImageIndexFeed: true, LazyPostImages: true},
		},
		Hosts:       browsing.HostColors{"green": {"green.example"}, "red": {"red.example"}},
		RegionRules: []browsing.RegionRule{{Region: "GB", Effective: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}},
		Metrics:     NewMetrics(prometheus.NewRegistry()),
		Log:         quietLog(),
	}
	return f
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (f *computeFixture) token(t *testing.T, sub int) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": "k1", "typ": "JWT"})
	p, _ := json.Marshal(map[string]any{
		"sub": itoa(sub), "jti": "tok-" + itoa(sub), "iss": computeIssuer,
		"exp": f.now.Add(time.Hour).Unix(), "signedAt": f.now.UnixMilli(), "iat0": f.now.UnixMilli(),
	})
	input := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, f.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

const computeInput = `{"json":{"browsingLevel":31,"sort":"Newest","limit":10,"disablePoi":true}}`

func computeRequest(host, input string, headers map[string]string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure+"?input="+url.QueryEscape(input), nil)
	r.Host = host
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// compute itself: who the viewer is decides the browsing-level cap (visible in the feed query's
// levels), whether the viewer id is sent, and whether the answer is edge-cacheable. Every expected
// query is literal: levels from the cap (signed out: PG only; signed in on an SFW host: PG+PG13;
// signed in where NSFW is viewable: all five), `excludePoi` from the input, `viewerId` only for a
// signed-in, unbanned viewer, limit = 2 × 10 (the handler's overscan).
func TestComputeCapAuthAndTTL(t *testing.T) {
	f := newComputeFixture(t)
	cookie := func(id int) map[string]string { return map[string]string{"Cookie": "civ-token=" + f.token(t, id)} }
	cases := []struct {
		name      string
		host      string
		headers   map[string]string
		input     string
		wantQuery string
		cacheable bool
	}{
		{"signed out on an NSFW host", "red.example", nil, computeInput,
			"levels=1&excludePoi=1&sort=newest&limit=20", true},
		{"signed out, no level asked", "red.example", nil, `{"json":{"sort":"Newest","limit":10}}`,
			"levels=1&sort=newest&limit=20", true},
		{"signed in on an NSFW host", "red.example", cookie(42), computeInput,
			"levels=1%2C2%2C4%2C8%2C16&excludePoi=1&viewerId=42&sort=newest&limit=20", false},
		{"signed in on an SFW host", "green.example", cookie(42), computeInput,
			"levels=1%2C2&excludePoi=1&viewerId=42&sort=newest&limit=20", false},
		{"signed in on an unknown host", "other.example", cookie(42), computeInput,
			"levels=1%2C2&excludePoi=1&viewerId=42&sort=newest&limit=20", false},
		{"signed in, region restricted", "red.example", map[string]string{"Cookie": "civ-token=" + f.token(t, 42), "cf-ipcountry": "GB"}, computeInput,
			"levels=1%2C2&excludePoi=1&viewerId=42&sort=newest&limit=20", false},
		{"signed in, region restricted by x-isuk", "red.example", map[string]string{"Cookie": "civ-token=" + f.token(t, 42), "x-isuk": "true"}, computeInput,
			"levels=1%2C2&excludePoi=1&viewerId=42&sort=newest&limit=20", false},
		{"moderator, region restricted", "red.example", map[string]string{"Cookie": "civ-token=" + f.token(t, 7), "cf-ipcountry": "GB"}, computeInput,
			"levels=1%2C2%2C4%2C8%2C16&excludePoi=1&viewerId=7&sort=newest&limit=20", false},
		// A banned session is no viewer (signed-out cap, no viewerId) but still a session: not cacheable.
		{"banned", "red.example", cookie(43), computeInput,
			"levels=1&excludePoi=1&sort=newest&limit=20", false},
	}
	// The viewer class each answer is counted under in the per-class shadow series (viewer_class.go).
	wantClass := map[string]string{
		"signed out on an NSFW host":             "anon",
		"signed out, no level asked":             "anon",
		"signed in on an NSFW host":              "user",
		"signed in on an SFW host":               "user",
		"signed in on an unknown host":           "user",
		"signed in, region restricted":           "user",
		"signed in, region restricted by x-isuk": "user",
		"moderator, region restricted":           "moderator",
		"banned":                                 "banned",
	}
	for _, c := range cases {
		f.feed.queries = nil
		out, err := f.s.compute(context.Background(), computeRequest(c.host, c.input, c.headers))
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if want, ok := wantClass[c.name]; !ok || out.viewerClass != want {
			t.Errorf("%s: viewer class %q, want %q (listed: %v)", c.name, out.viewerClass, want, ok)
		}
		if len(f.feed.queries) != 1 || f.feed.queries[0] != c.wantQuery {
			t.Errorf("%s: feed queries %q, want [%q]", c.name, f.feed.queries, c.wantQuery)
		}
		if c.cacheable {
			if out.ttl == nil || *out.ttl != trpc.SignedOutTTL {
				t.Errorf("%s: ttl %v, want the signed-out policy", c.name, out.ttl)
			}
		} else if out.ttl != nil {
			t.Errorf("%s: ttl %+v, want none (a session is never edge-cached)", c.name, *out.ttl)
		}
		var env struct {
			JSON struct {
				Items []any `json:"items"`
			} `json:"json"`
		}
		if err := json.Unmarshal(out.payload, &env); err != nil || env.JSON.Items == nil || len(env.JSON.Items) != 0 {
			t.Errorf("%s: payload %s, want an empty items list", c.name, out.payload)
		}
	}
}

func TestComputeFallbacks(t *testing.T) {
	f := newComputeFixture(t)
	cases := []struct {
		name   string
		req    *http.Request
		reason string
	}{
		{"verified bot", computeRequest("red.example", computeInput, map[string]string{"x-civitai-verified-bot": "1"}), "verified-bot"},
		{"bearer", computeRequest("red.example", computeInput, map[string]string{"Authorization": "Bearer k"}), "bearer-token"},
		{"session miss", computeRequest("red.example", computeInput, map[string]string{"Cookie": "civ-token=" + f.token(t, 99)}), "session-cache-miss"},
		{"unported input key", computeRequest("red.example", `{"json":{"userId":5}}`, nil), "input-userId"},
		{"not a superjson envelope", computeRequest("red.example", `[1]`, nil), "input-envelope"},
		{"POST", func() *http.Request {
			r := computeRequest("red.example", computeInput, nil)
			r.Method = http.MethodPost
			return r
		}(), "method"},
	}
	for _, c := range cases {
		f.feed.queries = nil
		_, err := f.s.compute(context.Background(), c.req)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: fallback %q (%v), want %q", c.name, got, err, c.reason)
		}
		if len(f.feed.queries) != 0 {
			t.Errorf("%s: the feed was queried for a fallback", c.name)
		}
	}
}
