package server

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

const bearerTestSecret = "test-secret"

// bearerResolver is a Resolver with API keys on over an in-memory cache holding one full-scope personal
// key, `k-full-user`, for user 42, and a session entry for that user. principalReads counts the
// principal-cache reads.
func bearerResolver(t *testing.T) (r *auth.Resolver, principalReads *atomic.Int32) {
	t.Helper()
	cache := testkit.NewRedis()
	principalReads = &atomic.Int32{}
	cache.KeyErr = func(key string) error {
		if strings.Contains(key, auth.APIKeyPrincipalKey) {
			principalReads.Add(1)
		}
		return nil
	}
	now := time.Now()
	put := func(key string, v any) {
		b, err := msgpack.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		cache.SetString(key, b)
	}
	sum := sha512.Sum512([]byte("k-full-user" + bearerTestSecret))
	put("packed:caches:api-key-principal:"+hex.EncodeToString(sum[:]), map[string]any{"apiKey": map[string]any{
		"id": 7, "userId": 42, "tokenScope": 33554431, "tokenScopeWide": 33554431, "lastUsedAt": now.Add(-time.Minute),
		"buzzLimit": nil, "clientId": nil, "type": "User", "expiresAt": nil,
	}})
	put("session:data2:42", map[string]any{"id": 42, "username": "viewer-a"})
	packed := &hydrate.PackedReader{Redis: cache}
	return &auth.Resolver{
		Sessions:    packed,
		CookieNames: auth.FixedCookieNames("__Secure-civ-token"),
		APIKeys:     &auth.APIKeys{Cache: packed, Secret: bearerTestSecret, Now: func() time.Time { return now }},
	}, principalReads
}

// createContext accepts a request whose API key resolved to a session whatever its Origin
// (isBearerAuth); a key that resolves to no session, or no key, is held to the origin.
func TestServeHTTPAcceptsAnyOriginForAResolvedAPIKey(t *testing.T) {
	cases := []struct {
		name     string
		auth     string // Authorization header; "" = none
		origin   string // Origin header; "" = none
		keysOff  bool   // Resolver.APIKeys nil (FEED_GO_BEARER_AUTH off)
		served   bool
		reason   string // the fallback reason when not served
		resolves int32  // principal-cache reads for the request
	}{
		{"resolved key, no origin: served", "Bearer k-full-user", "", false, true, "", 1},
		{"resolved key, foreign origin: served", "Bearer k-full-user", "https://elsewhere.example", false, true, "", 1},
		{"resolved key, allowed origin: served", "Bearer k-full-user", "https://site.example", false, true, "", 1},
		{"download token (signed out), no origin: refused origin", "Bearer github:secret", "", false, false, "origin", 0},
		{"unknown key, no origin: the key's fallback", "Bearer k-unknown", "", false, false, "bearer-key-cache-miss", 1},
		{"scheme without a key, no origin: origin", "Bearer", "", false, false, "origin", 0},
		{"no credential, no origin: origin", "", "", false, false, "origin", 0},
		{"API keys off, resolved key, no origin: origin", "Bearer k-full-user", "", true, false, "origin", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			fb := &proxyRecorder{}
			resolver, reads := bearerResolver(t)
			if tc.keysOff {
				resolver.APIKeys = nil
			}
			var computedFor []int
			s := serveServer(reg, func(ctx context.Context, r *http.Request) (*computed, error) {
				// The compute's own Resolve: the recorded answer, not a second read.
				u, err := resolver.Resolve(ctx, r)
				if err != nil {
					return nil, err
				}
				if u != nil {
					computedFor = append(computedFor, u.ID)
				}
				return &computed{payload: []byte(servedPayload)}, nil
			}, fb)
			s.Resolver = resolver
			s.RequestBudget = time.Second
			r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure+"?input=%7B%7D", nil)
			if tc.auth != "" {
				r.Header.Set("Authorization", tc.auth)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if tc.served {
				if w.Code != 200 || fb.calls != 0 || len(computedFor) != 1 || computedFor[0] != 42 {
					t.Fatalf("code=%d proxied=%d computedFor=%v, want 200, 0, [42]", w.Code, fb.calls, computedFor)
				}
			} else {
				if fb.calls != 1 || len(computedFor) != 0 || fallbackCount(t, reg, tc.reason) != 1 {
					t.Fatalf("proxied=%d computedFor=%v %s=%v, want 1, [], 1", fb.calls, computedFor, tc.reason, fallbackCount(t, reg, tc.reason))
				}
			}
			if got := reads.Load(); got != tc.resolves {
				t.Fatalf("principal-cache reads = %d, want %d", got, tc.resolves)
			}
		})
	}
}

// A shadow or probe sample carries the sampler's placeholder, never a key: its API credential stays the
// `bearer-token` fallback, even one that would resolve on the public route.
func TestSyntheticRequestsNeverResolveAPIKeys(t *testing.T) {
	resolver, reads := bearerResolver(t)
	headers := map[string]string{"authorization": "Bearer k-full-user", "host": "site.example"}
	// Positive control: the same header on a public request resolves.
	pub := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure, nil)
	pub.Header.Set("Authorization", headers["authorization"])
	if u, err := resolver.Resolve(pub.Context(), pub); err != nil || u == nil || u.ID != 42 {
		t.Fatalf("public request: user %+v err %v, want 42", u, err)
	}
	builds := map[string]func(context.Context, ShadowRequest) (*http.Request, error){
		"as-posts": SyntheticRequest, "infinite": SyntheticInfiniteRequest, "model-getall": SyntheticModelGetAllRequest,
		"v1-images": SyntheticV1Request, "v1-models": SyntheticV1ModelsRequest,
	}
	for name, build := range builds {
		r, err := build(context.Background(), ShadowRequest{Headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		u, err := resolver.Resolve(r.Context(), r)
		if fallback.Reason(err) != "bearer-token" || u != nil {
			t.Errorf("%s: user %+v reason %q, want bearer-token", name, u, fallback.Reason(err))
		}
	}
	if got := reads.Load(); got != 1 {
		t.Fatalf("principal-cache reads = %d, want 1 (the control only)", got)
	}
}

// The REST routes keep every API credential a fallback (DESIGN.md §4.2), with API keys on.
func TestRESTRoutesKeepAPICredentialsAFallback(t *testing.T) {
	resolver, reads := bearerResolver(t)
	s := &Server{Resolver: resolver, V1: &feed.V1Deps{}}
	for _, target := range []string{V1ImagesPath, V1ImagesPath + "?token=k-full-user"} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
		if !strings.Contains(target, "token=") {
			r.Header.Set("Authorization", "Bearer k-full-user")
		}
		if _, err := s.computeV1(context.Background(), r); fallback.Reason(err) != "bearer-token" {
			t.Errorf("v1 images %s: reason %q, want bearer-token", target, fallback.Reason(err))
		}
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("principal-cache reads = %d, want 0", got)
	}
}

// The shadow comparison and the Go-first probe run the real compute path (prepare → Resolve) under the
// context they mark (auth.WithRedactedCredentials). A sample carrying `Bearer <a key that resolves>`
// must stay the bearer-token fallback with no principal-cache read: without the mark it would resolve
// (read 1) and go on to compute.
func TestShadowAndProbeSamplesNeverResolveAPIKeys(t *testing.T) {
	headers := map[string]string{"authorization": "Bearer k-full-user", "host": "site.example"}

	t.Run("control: the same request off the sample paths resolves", func(t *testing.T) {
		resolver, reads := bearerResolver(t)
		s := serveServer(prometheus.NewRegistry(), nil, nil)
		s.Resolver = resolver
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure+"?input="+url.QueryEscape(computeInput), nil)
		r.Header.Set("Authorization", headers["authorization"])
		req, signedOut, err := s.prepare(context.Background(), r)
		if err != nil || signedOut || req.Viewer == nil || req.Viewer.ID != 42 || reads.Load() != 1 {
			t.Fatalf("viewer %+v signedOut %v err %v reads %d, want 42, false, nil, 1", req.Viewer, signedOut, err, reads.Load())
		}
	})

	t.Run("shadow compare", func(t *testing.T) {
		resolver, reads := bearerResolver(t)
		reg := prometheus.NewRegistry()
		s := serveServer(reg, nil, nil) // computeFn nil: the real s.compute
		s.Resolver = resolver
		s.RequestBudget = time.Second
		s.compare(context.Background(), EndpointAsPosts, ShadowRequest{Input: computeInput, Headers: headers})
		v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{EndpointLabel: EndpointAsPosts, "mode": "shadow", "reason": "bearer-token"})
		if v != 1 || reads.Load() != 0 {
			t.Fatalf("shadow bearer-token fallbacks = %v, principal-cache reads = %d; want 1, 0", v, reads.Load())
		}
	})

	t.Run("go-first probe", func(t *testing.T) {
		resolver, reads := bearerResolver(t)
		reg := prometheus.NewRegistry()
		s := serveServer(reg, nil, nil)
		s.Resolver = resolver
		s.RequestBudget = time.Second
		s.Deps = &feed.Deps{Hydrator: &hydrate.Sources{}} // a presence checker; never reached
		s.probe(context.Background(), probes[Procedure], ProbeRequest{Input: computeInput, Headers: headers})
		v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{EndpointLabel: EndpointAsPosts, "mode": "probe", "reason": "bearer-token"})
		if v != 1 || reads.Load() != 0 {
			t.Fatalf("probe bearer-token fallbacks = %v, principal-cache reads = %d; want 1, 0", v, reads.Load())
		}
	})
}
