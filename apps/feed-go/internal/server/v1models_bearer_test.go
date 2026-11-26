package server

import (
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"log/slog"
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
// fallback with V1BearerAuth off, and every list one with it on as well.
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
	{"list, empty then a ?token=", "/api/v1/models?limit=2&token=&token=k-read", nil},
	{"list, provider token", "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer github:x"}},
	{"[id], Bearer key", "/api/v1/models/42", map[string]string{"Authorization": "Bearer k-read"}},
	{"[id], block JWT shape", "/api/v1/models/42", map[string]string{"Authorization": "Bearer a.b.c"}},
	{"[id], other scheme", "/api/v1/models/42", map[string]string{"Authorization": "Basic eDp5"}},
	{"[id], ?token=", "/api/v1/models/42?token=k-read", nil},
}

// FEED_GO_V1_BEARER_AUTH off (the default), with the key resolver configured: every credential form
// is handed to the Node app exactly as before the switch existed (`bearer-token`, the request as it
// came, nothing computed, the principal cache never read). The list is held to the same with the
// switch ON: only `[id]` decides credentials. A request without a credential is answered with the
// same bytes and headers whichever way the switch is set.
func TestV1BearerAuthOffKeepsTodaysBehaviour(t *testing.T) {
	if (&Server{}).V1BearerAuth {
		t.Fatal("V1BearerAuth is on in a zero Server")
	}
	for _, on := range []bool{false, true} {
		for _, tc := range v1CredentialForms {
			if on && v1Endpoint(tc.target) == EndpointV1ModelsID {
				continue // `[id]` with the switch on: TestServeV1ModelsBearerAuthOn
			}
			t.Run(fmt.Sprintf("switch %v, %s", on, tc.name), func(t *testing.T) {
				reg := prometheus.NewRegistry()
				s, up, computes := serveV1Server(t, reg, true)
				resolver, reads := v1BearerResolver(t)
				s.Resolver = resolver
				s.V1BearerAuth = on
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
					t.Fatalf("principal reads = %d, want 0 (nothing resolved)", n)
				}
			})
		}
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

// FEED_GO_V1_BEARER_AUTH on, the public `[id]` route (withBlockScope over PublicEndpoint, which reads
// no session): a credential is answered with the body any caller gets and the credentialed headers
// (Vary: Authorization, Cookie; Cache-Control: private, no-store), except a possible block token and a
// bearer whose Node read would write lastUsedAt or read the primary, which fall back with their reason.
func TestServeV1ModelsBearerAuthOn(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		headers [][2]string
		reason  string // "" = served
		reads   int32
	}{
		{"full-scope key: PublicEndpoint reads no session", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-full"}}, "", 1},
		{"read-only key", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-read"}}, "", 1},
		{"banned user's key", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-banned"}}, "", 1},
		{"provider token: no lookup", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer github:x"}}, "", 0},
		{"other scheme: no bearer, no lookup", "/api/v1/models/42", [][2]string{{"Authorization", "Basic eDp5"}}, "", 0},
		{"?token=: no lookup", "/api/v1/models/42?token=k-unknown", nil, "", 0},
		{"block JWT shape", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer a.b.c"}}, "v1-models-block-token", 0},
		{"lastUsedAt write due", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-due"}}, "bearer-last-used", 1},
		{"unknown key", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-unknown"}}, "bearer-key-cache-miss", 1},
		{"two Authorization lines", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-read"}, {"Authorization", "Basic x"}}, "bearer-multiple-headers", 0},
		{"malformed bearer", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-r\xe9ad"}}, "bearer-malformed", 0},
		{"an Origin: still the serve-only fallback first", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-read"}, {"Origin", "https://app.example"}}, "v1-models-origin", 0},
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
			if n := reads.Load(); n != tc.reads {
				t.Fatalf("principal reads = %d, want %d", n, tc.reads)
			}
			if tc.reason != "" {
				if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
					t.Fatalf("code=%d proxied=%d computes=%d, want 418, 1, 0", w.Code, up.count(), *computes)
				}
				if n := v1Count(t, reg, EndpointV1ModelsID, "feed_go_fallback_total", map[string]string{"reason": tc.reason}); n != 1 {
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
			if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
		})
	}
}

// `[id]` answers a request whose credential was decided (the marker on its context) and keeps today's
// `bearer-token` without one; the list ignores the marker: its API credentials always fall back.
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
		{"list, marked: still bearer-token", decided, false, "bearer-token"},
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

func sampleKey(key string) string {
	sum := sha512.Sum512([]byte(key + bearerTestSecret))
	return "key:" + hex.EncodeToString(sum[:])
}

// The shadow: a credentialed `[id]` sample carries the sampler's description, never the key.
// SyntheticV1ModelsRequest moves it onto the rebuilt request's context and off its headers, the
// decision runs on it, and a computed one is counted under the api-key viewer. A list sample with a
// description is still the placeholder's `bearer-token`.
func TestV1ModelsShadowResolvesTheSampleCredential(t *testing.T) {
	r, err := SyntheticV1ModelsRequest(context.Background(), ShadowRequest{
		Path: V1ModelsPath + "/42", Headers: map[string]string{"host": "h.example", "authorization": "present",
			SampleCredentialHeader: sampleKey("k-read")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Header.Get(SampleCredentialHeader) != "" || r.Header.Get("Authorization") != "present" {
		t.Fatalf("sample headers on the rebuilt request: %v", r.Header)
	}
	cases := []struct {
		name, endpoint, cred, reason string
	}{
		{"[id], full key: computed", EndpointV1ModelsID, sampleKey("k-full"), ""},
		{"[id], provider: computed", EndpointV1ModelsID, auth.SampleCredentialProvider, ""},
		{"[id], dotted", EndpointV1ModelsID, auth.SampleCredentialDotted, "v1-models-block-token"},
		{"[id], due write", EndpointV1ModelsID, sampleKey("k-due"), "bearer-last-used"},
		{"[id], no description: the placeholder", EndpointV1ModelsID, "", "bearer-token"},
		{"list, with a description: unchanged", EndpointV1Models, sampleKey("k-read"), "bearer-token"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, _, computes := serveV1Server(t, reg, true)
			s.Resolver, _ = v1BearerResolver(t)
			s.V1BearerAuth = true
			path, body := V1ModelsPath, v1ListBody
			if tc.endpoint == EndpointV1ModelsID {
				path, body = V1ModelsPath+"/42", v1DetailBody
			}
			headers := map[string]string{"host": "h.example", "authorization": "present"}
			if tc.cred != "" {
				headers[SampleCredentialHeader] = tc.cred
			}
			s.compare(context.Background(), tc.endpoint, ShadowRequest{Input: "limit=2", Path: path, Headers: headers, Node: []byte(body)})
			metric := func(name string, labels map[string]string) float64 {
				l := map[string]string{"feed_endpoint": tc.endpoint}
				for k, v := range labels {
					l[k] = v
				}
				v, _ := metricValue(t, reg, name, l)
				return v
			}
			if tc.reason != "" {
				if n := metric("feed_go_fallback_total", map[string]string{"mode": "shadow", "reason": tc.reason}); *computes != 0 || n != 1 {
					t.Fatalf("computes=%d %s=%v, want 0, 1", *computes, tc.reason, n)
				}
				return
			}
			if n := metric("feed_go_shadow_compare_total", map[string]string{"result": "match"}); *computes != 1 || n != 1 {
				t.Fatalf("computes=%d match=%v, want 1, 1", *computes, n)
			}
			if n := metric("feed_go_shadow_compare_viewer_total", map[string]string{"viewer": V1ViewerAPIKey, "result": "match"}); n != 1 {
				t.Fatalf("api-key viewer match = %v, want 1", n)
			}
		})
	}
}

// No log line feed-go writes for a credentialed sample carries the sampler's description (the key's
// hash) or its header name: not the fallback line, not the shadow diff line. Positive controls: both
// lines are written (so the logger saw these samples), and the hash appears in the sample itself.
func TestV1ModelsShadowNeverLogsTheSampleCredential(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s, _, _ := serveV1Server(t, prometheus.NewRegistry(), true)
	s.Log = log
	s.Events = &EventLog{Log: log, FallbackPerMinute: 1000, ErrorPerMinute: 1000}
	s.Resolver, _ = v1BearerResolver(t)
	s.V1BearerAuth = true
	hit, miss := sampleKey("k-read"), sampleKey("k-unknown")
	sample := func(cred, node string) ShadowRequest {
		return ShadowRequest{Path: V1ModelsPath + "/42", Node: []byte(node),
			Headers: map[string]string{"host": "h.example", "authorization": "present", SampleCredentialHeader: cred}}
	}
	// A fallback (the cache misses that hash), and a computed sample whose body differs (a diff line).
	s.compare(context.Background(), EndpointV1ModelsID, sample(miss, v1DetailBody))
	s.compare(context.Background(), EndpointV1ModelsID, sample(hit, `{"id":42,"name":"b"}`))
	out := buf.String()
	if !strings.Contains(out, "bearer-key-cache-miss") || !strings.Contains(out, "shadow diff") {
		t.Fatalf("positive control: the fallback and diff lines were not logged:\n%s", out)
	}
	for _, secret := range []string{hit, miss, hit[len("key:"):], miss[len("key:"):], SampleCredentialHeader} {
		if strings.Contains(out, secret) {
			t.Fatalf("a log line carries %q:\n%s", secret, out)
		}
	}
}
