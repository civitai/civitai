package server

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// v1BearerResolver is a Resolver with API keys on over an in-memory cache holding the key shapes the
// model routes tell apart (each its own user), and a counter of principal-cache reads:
//
//	k-full      full-scope personal key, user 61
//	k-read      ReadOnly personal key, user 62
//	k-images    MediaRead-only personal key, user 63
//	k-mod       ReadOnly personal key of a moderator, user 64
//	k-banned    full-scope personal key of a banned user, user 65
//	k-due       full-scope personal key whose lastUsedAt write is due, user 61
func v1BearerResolver(t *testing.T) (*auth.Resolver, *atomic.Int32) {
	t.Helper()
	cache := testkit.NewRedis()
	reads := &atomic.Int32{}
	cache.KeyErr = func(key string) error {
		if strings.Contains(key, auth.APIKeyPrincipalKey) {
			reads.Add(1)
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
	key := func(name string, userID int, scope int64, lastUsed time.Time) {
		sum := sha512.Sum512([]byte(name + bearerTestSecret))
		put("packed:caches:api-key-principal:"+hex.EncodeToString(sum[:]), map[string]any{"apiKey": map[string]any{
			"id": userID, "userId": userID, "tokenScope": scope, "tokenScopeWide": scope, "lastUsedAt": lastUsed,
			"buzzLimit": nil, "clientId": nil, "type": "User", "expiresAt": nil,
		}})
	}
	fresh := now.Add(-time.Minute)
	key("k-full", 61, auth.ScopeFull, fresh)
	key("k-read", 62, auth.ScopeReadOnly, fresh)
	key("k-images", 63, 1<<5, fresh)
	key("k-mod", 64, auth.ScopeReadOnly, fresh)
	key("k-banned", 65, auth.ScopeFull, fresh)
	key("k-due", 61, auth.ScopeFull, now.Add(-2*time.Hour))
	put("session:data2:61", map[string]any{"id": 61, "username": "full-a"})
	put("session:data2:62", map[string]any{"id": 62, "username": "read-b"})
	put("session:data2:63", map[string]any{"id": 63, "username": "images-c"})
	put("session:data2:64", map[string]any{"id": 64, "username": "mod-d", "isModerator": true})
	put("session:data2:65", map[string]any{"id": 65, "username": "banned-e", "bannedAt": now.Add(-time.Hour)})
	packed := &hydrate.PackedReader{Redis: cache}
	return &auth.Resolver{
		Sessions:    packed,
		CookieNames: auth.FixedCookieNames("__Secure-civ-token"),
		APIKeys:     &auth.APIKeys{Cache: packed, Secret: bearerTestSecret, Now: func() time.Time { return now }},
	}, reads
}

// The credential forms both routes are held to, with today's answer: every one is the `bearer-token`
// fallback with V1BearerAuth off.
var v1CredentialForms = []struct {
	name    string
	target  string
	headers map[string]string
}{
	{"list, Bearer key", "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer k-read"}},
	{"list, full key", "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer k-full"}},
	{"list, scheme only", "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer"}},
	{"list, other scheme", "/api/v1/models?limit=2", map[string]string{"Authorization": "Token k-read"}},
	{"list, ?token=", "/api/v1/models?limit=2&token=k-read", nil},
	{"list, malformed key", "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer k-r\xe9ad"}},
	{"[id], Bearer key", "/api/v1/models/42", map[string]string{"Authorization": "Bearer k-read"}},
	{"[id], block JWT shape", "/api/v1/models/42", map[string]string{"Authorization": "Bearer a.b.c"}},
	{"[id], other scheme", "/api/v1/models/42", map[string]string{"Authorization": "Basic eDp5"}},
	{"[id], ?token=", "/api/v1/models/42?token=k-read", nil},
}

// FEED_GO_V1_BEARER_AUTH off (the default), with the key resolver configured: every credential form
// is handed to the Node app exactly as before the switch existed (`bearer-token`, the request as it
// came, nothing computed, the principal cache never read), and a request without a credential is
// answered with the same bytes and headers whichever way the switch is set.
func TestV1BearerAuthOffKeepsTodaysBehaviour(t *testing.T) {
	if (&Server{}).V1BearerAuth {
		t.Fatal("V1BearerAuth is on in a zero Server")
	}
	for _, tc := range v1CredentialForms {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, up, computes := serveV1Server(t, reg, true)
			resolver, reads := v1BearerResolver(t)
			s.Resolver = resolver
			w := httptest.NewRecorder()
			req := v1Request(tc.target, nil)
			for k, v := range tc.headers {
				req.Header[k] = []string{v}
			}
			v1Handler(s, tc.target)(w, req)
			if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 || up.paths[0] != tc.target {
				t.Fatalf("code=%d proxied=%d computes=%d path=%v, want 418, 1, 0, the request as it came", w.Code, up.count(), *computes, up.paths)
			}
			if n := v1Count(t, reg, v1Endpoint(tc.target), "feed_go_fallback_total", map[string]string{"reason": "bearer-token"}); n != 1 {
				t.Fatalf("bearer-token = %v, want 1", n)
			}
			if n := reads.Load(); n != 0 {
				t.Fatalf("principal reads = %d, want 0 (off resolves nothing)", n)
			}
		})
	}
	for _, target := range []string{"/api/v1/models?limit=2", "/api/v1/models/42"} {
		var answers [2]*httptest.ResponseRecorder
		for i, on := range []bool{false, true} {
			s, _, _ := serveV1Server(t, prometheus.NewRegistry(), true)
			s.Resolver, _ = v1BearerResolver(t)
			s.V1BearerAuth = on
			answers[i] = httptest.NewRecorder()
			v1Handler(s, target)(answers[i], v1Request(target, nil))
		}
		off, on := answers[0], answers[1]
		if off.Code != 200 || on.Code != off.Code || on.Body.String() != off.Body.String() {
			t.Fatalf("%s: off %d %q, on %d %q, want the same 200", target, off.Code, off.Body, on.Code, on.Body)
		}
		if !headersEqual(off.Header(), on.Header()) {
			t.Fatalf("%s: headers off %v, on %v", target, off.Header(), on.Header())
		}
	}
}

func headersEqual(a, b http.Header) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w := b[k]
		if len(v) != len(w) {
			return false
		}
		for i := range v {
			if v[i] != w[i] {
				return false
			}
		}
	}
	return true
}

// FEED_GO_V1_BEARER_AUTH on, the public routes: each credential form is answered as the Node route
// answers it. Served means the signed-out body with the credentialed headers (Vary: Authorization,
// Cookie and the private Cache-Control, as MixedAuthEndpoint / PublicEndpoint key them on the
// credential's presence); every case Node answers as a user, or with a write or a read this service
// does not make, falls back with its reason.
func TestServeV1ModelsBearerAuthOn(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		headers [][2]string
		reason  string // "" = served
		reads   int32
	}{
		// The list (MixedAuthEndpoint, then searchViewer).
		{"list, read-only key: signed-out search", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-read"}}, "", 1},
		{"list, banned user's key: no session", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-banned"}}, "", 1},
		{"list, provider token: no session, no lookup", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer github:x"}}, "", 0},
		{"list, scheme only: cookies (none)", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer"}}, "", 0},
		{"list, full-scope key: the signed-in list", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-full"}}, "v1-models-bearer-session", 1},
		{"list, no model-view scope", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-images"}}, "v1-models-bearer-scope", 1},
		{"list, a moderator's scoped key", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-mod"}}, "v1-models-bearer-moderator", 1},
		{"list, lastUsedAt write due", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-due"}}, "bearer-last-used", 1},
		{"list, unknown key", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-unknown"}}, "bearer-key-cache-miss", 1},
		{"list, ?token=", "/api/v1/models?limit=2&token=k-read", nil, "bearer-query-token", 0},
		{"list, empty then a ?token=", "/api/v1/models?limit=2&token=&token=k-read", nil, "bearer-query-token", 0},
		{"list, two Authorization lines", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-read"}, {"Authorization", "Bearer k-read"}}, "bearer-multiple-headers", 0},
		{"list, malformed key", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-r\xe9ad"}}, "bearer-malformed", 0},
		{"list, own list: parsed before the key", "/api/v1/models?favorites=true", [][2]string{{"Authorization", "Bearer k-read"}}, "v1-models-authed-only", 0},
		{"list, followed: parsed before the key", "/api/v1/models?followed=true", [][2]string{{"Authorization", "Bearer k-read"}}, "v1-models-followed", 0},
		{"list, key and a session cookie", "/api/v1/models?limit=2", [][2]string{{"Authorization", "Bearer k-read"}, {"Cookie", "__Secure-civ-token=x"}}, "v1-models-session-cookie", 0},
		// `[id]` (withBlockScope, then PublicEndpoint: no session is read).
		{"[id], full-scope key: PublicEndpoint reads no session", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-full"}}, "", 1},
		{"[id], other scheme: no bearer, no lookup", "/api/v1/models/42", [][2]string{{"Authorization", "Basic eDp5"}}, "", 0},
		{"[id], ?token=: no lookup", "/api/v1/models/42?token=k-unknown", nil, "", 0},
		{"[id], block JWT shape", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer a.b.c"}}, "v1-models-block-token", 0},
		{"[id], lastUsedAt write due", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-due"}}, "bearer-last-used", 1},
		{"[id], unknown key", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-unknown"}}, "bearer-key-cache-miss", 1},
		{"[id], two Authorization lines", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-read"}, {"Authorization", "Basic x"}}, "bearer-multiple-headers", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, up, computes := serveV1Server(t, reg, true)
			resolver, reads := v1BearerResolver(t)
			s.Resolver = resolver
			s.V1BearerAuth = true
			var decided []bool
			inner := s.computeV1ModelsFn
			s.computeV1ModelsFn = func(ctx context.Context, r *http.Request) (*computed, error) {
				decided = append(decided, credentialDecided(ctx))
				return inner(ctx, r)
			}
			req := v1Request(tc.target, nil)
			for _, h := range tc.headers {
				req.Header.Add(h[0], h[1])
			}
			w := httptest.NewRecorder()
			v1Handler(s, tc.target)(w, req)
			endpoint := v1Endpoint(tc.target)
			if n := reads.Load(); n != tc.reads {
				t.Fatalf("principal reads = %d, want %d", n, tc.reads)
			}
			if tc.reason != "" {
				if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
					t.Fatalf("code=%d proxied=%d computes=%d, want 418, 1, 0", w.Code, up.count(), *computes)
				}
				if n := v1Count(t, reg, endpoint, "feed_go_fallback_total", map[string]string{"reason": tc.reason}); n != 1 {
					t.Fatalf("%s = %v, want 1", tc.reason, n)
				}
				return
			}
			if w.Code != 200 || up.count() != 0 || *computes != 1 || len(decided) != 1 || !decided[0] {
				t.Fatalf("code=%d proxied=%d computes=%d decided=%v, want 200, 0, 1, [true]", w.Code, up.count(), *computes, decided)
			}
			if got := w.Header().Get(ServedByHeader); got != ServedByGo {
				t.Fatalf("%s = %q, want go", ServedByHeader, got)
			}
			if got := w.Header().Get("Vary"); got != "Authorization, Cookie" {
				t.Fatalf("Vary = %q, want the credentialed arm", got)
			}
			wantCC := "max-age=0, private, no-cache"
			if endpoint == EndpointV1ModelsID {
				wantCC = "private, no-store"
			}
			if got := w.Header().Get("Cache-Control"); got != wantCC {
				t.Fatalf("Cache-Control = %q, want %q", got, wantCC)
			}
		})
	}
}

// The port answers a request whose credential was decided as signed out (the decision on its
// context), and keeps today's `bearer-token` without one: the gate the switch opens is that marker.
func TestComputeV1ModelsHonoursTheDecidedCredential(t *testing.T) {
	configured := &Server{
		Resolver: &auth.Resolver{},
		V1Models: &V1ModelsDeps{Deps: &v1models.Deps{Config: v1models.Config{BaseURL: "https://s.example"}}},
	}
	decided := context.WithValue(context.Background(), credentialDecidedKey{}, true)
	for _, c := range []struct {
		name   string
		ctx    context.Context
		id     bool
		reason string
	}{
		{"list, undecided", context.Background(), false, "bearer-token"},
		{"list, decided: reaches the port", decided, false, "v1-models-unconfigured-urls"},
		{"[id], undecided", context.Background(), true, "bearer-token"},
		{"[id], decided: reaches the port", decided, true, "v1-models-unconfigured-urls"},
	} {
		target := "/api/v1/models?limit=2"
		if c.id {
			target = "/api/v1/models/7"
		}
		r := httptest.NewRequestWithContext(c.ctx, http.MethodGet, target, nil)
		r.Header.Set("Authorization", "Bearer k")
		var err error
		if c.id {
			_, err = configured.computeV1ModelsID(c.ctx, r)
		} else {
			_, err = configured.computeV1Models(c.ctx, r)
		}
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
}

// The shadow: a credentialed sample carries the sampler's description and Node's viewer, never the
// key. SyntheticV1ModelsRequest moves both onto the context (a public request's headers of the same
// names are never read), the decision runs on them, a sample Node searched as a user that this decides
// signed out is the viewer-mismatch fallback, and a computed one is counted under the api-key viewer.
func TestV1ModelsShadowResolvesTheSampleCredential(t *testing.T) {
	hash := func(key string) string {
		sum := sha512.Sum512([]byte(key + bearerTestSecret))
		return "key:" + hex.EncodeToString(sum[:])
	}
	r, err := SyntheticV1ModelsRequest(context.Background(), ShadowRequest{
		Input: "limit=2", Headers: map[string]string{"host": "h.example", "authorization": "present",
			SampleCredentialHeader: hash("k-read"), SampleViewerHeader: "anonymous"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Header.Get(SampleCredentialHeader) != "" || r.Header.Get(SampleViewerHeader) != "" || r.Header.Get("Authorization") != "present" {
		t.Fatalf("sample headers on the rebuilt request: %v", r.Header)
	}
	cases := []struct {
		name, endpoint, input, cred, viewer, reason string
	}{
		{"list, read-only key, Node signed out: computed", EndpointV1Models, "limit=2", hash("k-read"), "anonymous", ""},
		{"list, read-only key, Node searched as the user", EndpointV1Models, "limit=2", hash("k-read"), NodeViewerUser, "v1-models-bearer-viewer-mismatch"},
		{"list, full key", EndpointV1Models, "limit=2", hash("k-full"), NodeViewerUser, "v1-models-bearer-session"},
		{"list, no description: the placeholder", EndpointV1Models, "limit=2", "", "", "bearer-token"},
		{"[id], dotted", EndpointV1ModelsID, "", auth.SampleCredentialDotted, "", "v1-models-block-token"},
		{"[id], full key: computed", EndpointV1ModelsID, "", hash("k-full"), "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, _, computes := serveV1Server(t, reg, true)
			s.Resolver, _ = v1BearerResolver(t)
			s.V1BearerAuth = true
			path := V1ModelsPath
			if tc.endpoint == EndpointV1ModelsID {
				path += "/42"
			}
			headers := map[string]string{"host": "h.example", "authorization": "present"}
			if tc.cred != "" {
				headers[SampleCredentialHeader] = tc.cred
			}
			if tc.viewer != "" {
				headers[SampleViewerHeader] = tc.viewer
			}
			body := v1ListBody
			if tc.endpoint == EndpointV1ModelsID {
				body = v1DetailBody
			}
			sample := ShadowRequest{Input: tc.input, Path: path, Headers: headers, Node: []byte(body)}
			if tc.endpoint == EndpointV1Models {
				// Node's headers for a credentialed request: the credentialed Vary and Cache-Control.
				sample.ResponseHeaders = v1ModelsResponse("max-age=0, private, no-cache")
				sample.ResponseHeaders["vary"] = "Authorization, Cookie"
				sample.ResponseHeaderSet = ResponseHeaderSetREST
			}
			s.compare(context.Background(), tc.endpoint, sample)
			shadow := func(name string, labels map[string]string) float64 {
				l := map[string]string{"feed_endpoint": tc.endpoint}
				for k, v := range labels {
					l[k] = v
				}
				v, _ := metricValue(t, reg, name, l)
				return v
			}
			if tc.reason != "" {
				if *computes != 0 || shadow("feed_go_fallback_total", map[string]string{"mode": "shadow", "reason": tc.reason}) != 1 {
					t.Fatalf("computes=%d %s=%v, want 0, 1", *computes, tc.reason, shadow("feed_go_fallback_total", map[string]string{"mode": "shadow", "reason": tc.reason}))
				}
				return
			}
			if *computes != 1 || shadow("feed_go_shadow_compare_total", map[string]string{"result": "match"}) != 1 {
				t.Fatalf("computes=%d match=%v, want 1, 1", *computes, shadow("feed_go_shadow_compare_total", map[string]string{"result": "match"}))
			}
			if n := shadow("feed_go_shadow_compare_viewer_total", map[string]string{"viewer": V1ViewerAPIKey, "result": "match"}); n != 1 {
				t.Fatalf("api-key viewer match = %v, want 1", n)
			}
			if tc.endpoint == EndpointV1Models {
				if n := shadow("feed_go_shadow_response_total", map[string]string{"result": "match"}); n != 1 {
					t.Fatalf("response headers match = %v, want 1 (the credentialed arm on both sides)", n)
				}
			}
		})
	}
}
