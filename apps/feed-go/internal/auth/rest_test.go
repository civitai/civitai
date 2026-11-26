package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// restFixture is a bearer fixture holding the key shapes `[id]` tells apart, each for its own user,
// and a counter of principal-cache reads:
//
//	k-full      full-scope personal key, user 51 (searches as its user)
//	k-read      ReadOnly personal key, user 52 (searches as signed out)
//	k-images    MediaRead-only personal key, user 53 (no model-view scope)
//	k-mod       ReadOnly personal key of a moderator, user 54
//	k-system    full-scope System key, user 55
//	k-banned    full-scope personal key of a banned user, user 56
//	k-cc        a client-credentials key (DownloadLink), user 57
//	k-due       full-scope personal key whose lastUsedAt write is due (2 h ago), user 51
func restFixture(t *testing.T) (*resolveFixture, *atomic.Int32) {
	t.Helper()
	f := newBearerFixture(t)
	reads := &atomic.Int32{}
	f.cache.KeyErr = func(key string) error {
		if strings.Contains(key, APIKeyPrincipalKey) {
			reads.Add(1)
		}
		return nil
	}
	for id, name := range map[int]string{51: "full-a", 52: "read-b", 53: "images-c", 55: "system-e", 57: "cc-g"} {
		f.session(t, id, map[string]any{"id": id, "username": name})
	}
	f.session(t, 54, map[string]any{"id": 54, "username": "mod-d", "isModerator": true})
	f.session(t, 56, map[string]any{"id": 56, "username": "banned-f", "bannedAt": time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)})
	scope := func(s int64) func(map[string]any) {
		return func(row map[string]any) { row["tokenScope"], row["tokenScopeWide"] = s, s }
	}
	f.principal(t, "k-full", f.apiKeyRow(51, nil))
	f.principal(t, "k-read", f.apiKeyRow(52, scope(ScopeReadOnly)))
	f.principal(t, "k-images", f.apiKeyRow(53, scope(1<<5)))
	// Hub OAuth tokens as they would read if a principal-cache entry ever held one.
	f.principal(t, "k-oauth", f.apiKeyRow(51, func(row map[string]any) { row["clientId"] = "app_block_client" }))
	f.principal(t, "k-oauth-access", f.apiKeyRow(51, func(row map[string]any) { row["type"] = "Access" }))
	f.principal(t, "k-oauth-noclient", f.apiKeyRow(51, func(row map[string]any) { delete(row, "clientId") }))
	f.principal(t, "k-mod", f.apiKeyRow(54, scope(ScopeReadOnly)))
	f.principal(t, "k-system", f.apiKeyRow(55, func(row map[string]any) { row["type"] = "System" }))
	f.principal(t, "k-banned", f.apiKeyRow(56, nil))
	f.principal(t, "k-cc", f.apiKeyRow(57, scope(1<<30|ScopeReadOnly)))
	f.principal(t, "k-due", f.apiKeyRow(51, func(row map[string]any) { row["lastUsedAt"] = f.now.Add(-2 * time.Hour) }))
	return f, reads
}

func restRequest(target string, headers ...[2]string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
	for _, h := range headers {
		r.Header.Add(h[0], h[1])
	}
	return r
}

func authz(v string) [2]string { return [2]string{"Authorization", v} }

// DetailCredential is withBlockScope's reading of the Authorization header on `[id]`, then
// PublicEndpoint's (which reads no session): every case answers nil (the anonymous body) except a
// block JWT shape, a bearer whose getSessionFromBearerToken would write lastUsedAt or read the
// primary, and the forms not decided here.
func TestDetailCredential(t *testing.T) {
	f, reads := restFixture(t)
	cases := []struct {
		name    string
		target  string
		headers [][2]string
		reason  string
		reads   int32
	}{
		{"no credential", "/api/v1/models/1", nil, "", 0},
		{"a query token: PublicEndpoint reads no session", "/api/v1/models/1?token=k-unknown", nil, "", 0},
		{"not a Bearer header", "/api/v1/models/1", [][2]string{authz("Token k-unknown")}, "", 0},
		{"Bearer without a space", "/api/v1/models/1", [][2]string{authz("Bearer")}, "", 0},
		{"an empty bearer", "/api/v1/models/1", [][2]string{authz("Bearer    ")}, "", 0},
		{"a cached key, no write due", "/api/v1/models/1", [][2]string{authz("Bearer k-full")}, "", 1},
		{"any case of the scheme", "/api/v1/models/1", [][2]string{authz("bEaReR k-read")}, "", 1},
		{"the bearer is trimmed (not split)", "/api/v1/models/1", [][2]string{authz("Bearer \t k-full  ")}, "", 1},
		{"a banned user's key: no write due, handed on", "/api/v1/models/1", [][2]string{authz("Bearer k-banned")}, "", 1},
		{"a client-credentials key", "/api/v1/models/1", [][2]string{authz("Bearer k-cc")}, "", 1},
		{"provider download token", "/api/v1/models/1", [][2]string{authz("Bearer github:secret")}, "", 0},
		{"orchestrator token", "/api/v1/models/1", [][2]string{authz("Bearer orch-service-token")}, "", 0},
		{"a block JWT shape", "/api/v1/models/1", [][2]string{authz("Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig")}, "v1-models-block-token", 0},
		{"lastUsedAt write due", "/api/v1/models/1", [][2]string{authz("Bearer k-due")}, "bearer-last-used", 1},
		{"unknown key (Node reads the primary)", "/api/v1/models/1", [][2]string{authz("Bearer k-unknown")}, "bearer-key-cache-miss", 1},
		{"two Authorization lines", "/api/v1/models/1", [][2]string{authz("Bearer k-full"), authz("Basic x")}, "bearer-multiple-headers", 0},
		{"a latin-1 byte in the bearer", "/api/v1/models/1", [][2]string{authz("Bearer k-f\xe9ll")}, "bearer-malformed", 0},
		{"a space inside the bearer", "/api/v1/models/1", [][2]string{authz("Bearer k full")}, "bearer-malformed", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reads.Store(0)
			r := restRequest(tc.target, tc.headers...)
			err := f.r.DetailCredential(r.Context(), r)
			if got := fallback.Reason(err); got != tc.reason || (err != nil && got == "") {
				t.Fatalf("DetailCredential = %v (%q), want %q", err, got, tc.reason)
			}
			if n := reads.Load(); n != tc.reads {
				t.Fatalf("principal reads = %d, want %d", n, tc.reads)
			}
		})
	}
	// Keys off: any Authorization header is the old fallback; a query token is still nothing.
	off, _ := restFixture(t)
	off.r.APIKeys = nil
	if got := fallback.Reason(off.r.DetailCredential(context.Background(), restRequest("/api/v1/models/1", authz("Token x")))); got != "bearer-token" {
		t.Fatalf("keys off, Authorization: %q, want bearer-token", got)
	}
	// A sample's description.
	ctx := WithRedactedCredentials(context.Background())
	present := restRequest("/api/v1/models/1", authz("present"))
	if got := fallback.Reason(f.r.DetailCredential(ctx, present.WithContext(ctx))); got != "bearer-token" {
		t.Fatalf("sample without a description: %q, want bearer-token", got)
	}
	for desc, want := range map[string]string{
		SampleCredentialNone:                    "",
		SampleCredentialProvider:                "",
		SampleCredentialService:                 "",
		SampleCredentialDotted:                  "v1-models-block-token",
		"key:" + nodeHash("k-full"):             "",
		"key:" + nodeHash("k-due"):              "bearer-last-used",
		"key:" + nodeHash("k-unknown"):          "bearer-key-cache-miss",
		"k-full":                                "bearer-sample-credential",
		"key:" + nodeHash("k-full")[:100] + "z": "bearer-sample-credential",
	} {
		c := WithSampleCredential(ctx, desc)
		if got := fallback.Reason(f.r.DetailCredential(c, present.WithContext(c))); got != want {
			t.Errorf("sample %q: %q, want %q", desc, got, want)
		}
	}
}

// withBlockScope turns a hub OAuth token (an ApiKey row with a clientId: getSessionFromBearerToken's
// `oauth` subject) into block claims, whose answer differs from PublicEndpoint's. Such a token is never
// served on `[id]`: an entry with a clientId, of a type other than User or System, or with no clientId
// key at all falls back, whether presented as a header or described by a sample; and an uncached one
// (the usual case: the app never caches OAuth rows) is a miss. Positive control: the same user's
// personal key is served.
func TestDetailCredentialRefusesOAuthTokens(t *testing.T) {
	f, _ := restFixture(t)
	if err := f.r.DetailCredential(context.Background(), restRequest("/api/v1/models/1", authz("Bearer k-full"))); err != nil {
		t.Fatalf("positive control: a personal key = %v, want served", err)
	}
	ctx := WithRedactedCredentials(context.Background())
	for key, want := range map[string]string{
		"k-oauth":          "bearer-key-uncacheable",
		"k-oauth-access":   "bearer-key-uncacheable",
		"k-oauth-noclient": "bearer-key-uncacheable",
		"k-oauth-uncached": "bearer-key-cache-miss",
	} {
		r := restRequest("/api/v1/models/1", authz("Bearer "+key))
		if got := fallback.Reason(f.r.DetailCredential(r.Context(), r)); got != want {
			t.Errorf("header %s: %q, want %q", key, got, want)
		}
		c := WithSampleCredential(ctx, "key:"+nodeHash(key))
		present := restRequest("/api/v1/models/1", authz("present")).WithContext(c)
		if got := fallback.Reason(f.r.DetailCredential(c, present)); got != want {
			t.Errorf("sample %s: %q, want %q", key, got, want)
		}
	}
}
