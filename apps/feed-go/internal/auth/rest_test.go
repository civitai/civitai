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

// restFixture is a bearer fixture holding the key shapes the REST model routes tell apart, each for
// its own user, and a counter of principal-cache reads:
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

type restWant struct {
	user   int    // the session's user id; 0 = signed out
	bearer bool   // an API key decided the session
	scope  int64  // the key's scope, when it resolved to a user
	full   bool   // FullUserKey
	reason string // a fallback reason; "" = none
	reads  int32  // principal-cache reads
}

func checkREST(t *testing.T, f *resolveFixture, reads *atomic.Int32, ctx context.Context, r *http.Request, want restWant) {
	t.Helper()
	reads.Store(0)
	got, err := f.r.ResolveREST(ctx, r)
	reason := fallback.Reason(err)
	if err != nil && reason == "" {
		t.Fatalf("non-fallback error %v", err)
	}
	if reason != want.reason {
		t.Fatalf("fallback %q, want %q", reason, want.reason)
	}
	if n := reads.Load(); n != want.reads {
		t.Fatalf("principal reads = %d, want %d", n, want.reads)
	}
	if err != nil {
		return
	}
	id := 0
	if got.User != nil {
		id = got.User.ID
	}
	if id != want.user || (got.Bearer != nil) != want.bearer {
		t.Fatalf("user %d bearer %v, want %d %v", id, got.Bearer != nil, want.user, want.bearer)
	}
	if got.Bearer != nil {
		if got.Bearer.User != got.User {
			t.Fatal("Bearer.User is not the session's user")
		}
		if got.Bearer.User != nil && (got.Bearer.Scope != want.scope || got.Bearer.FullUserKey() != want.full) {
			t.Fatalf("scope %d full %v, want %d %v", got.Bearer.Scope, got.Bearer.FullUserKey(), want.scope, want.full)
		}
	}
}

// ResolveREST is getServerAuthSession's resolveSession for each credential form the list route can
// see: readRequestBearerToken's token (header split, else `?token=`) decides the session and the
// cookies are not read; no token, the cookies decide. Each row is the app's session for the request,
// or the fallback where the app reads what this service does not.
func TestResolveRESTCredentialForms(t *testing.T) {
	f, reads := restFixture(t)
	cookie := [2]string{"Cookie", "__Secure-civ-token=" + f.token(t, func(c map[string]any) { c["sub"] = "52" })}
	cases := []struct {
		name    string
		target  string
		headers [][2]string
		want    restWant
	}{
		{"no credential", "/api/v1/models", nil, restWant{}},
		{"a cookie session", "/api/v1/models", [][2]string{cookie}, restWant{user: 52}},
		{"full-scope personal key", "/api/v1/models", [][2]string{authz("Bearer k-full")}, restWant{user: 51, bearer: true, scope: ScopeFull, full: true, reads: 1}},
		{"any scheme: the second part is the token", "/api/v1/models", [][2]string{authz("Token k-full")}, restWant{user: 51, bearer: true, scope: ScopeFull, full: true, reads: 1}},
		{"a key wins over a cookie (cookies unread)", "/api/v1/models", [][2]string{authz("Bearer k-read"), cookie}, restWant{user: 52, bearer: true, scope: ScopeReadOnly, reads: 1}},
		{"read-only key", "/api/v1/models", [][2]string{authz("Bearer k-read")}, restWant{user: 52, bearer: true, scope: ScopeReadOnly, reads: 1}},
		{"system key", "/api/v1/models", [][2]string{authz("Bearer k-system")}, restWant{user: 55, bearer: true, scope: ScopeFull, reads: 1}},
		{"banned user's key: no session", "/api/v1/models", [][2]string{authz("Bearer k-banned")}, restWant{bearer: true, reads: 1}},
		{"client-credentials key: no session", "/api/v1/models", [][2]string{authz("Bearer k-cc")}, restWant{bearer: true, reads: 1}},
		{"provider download token: no session, no lookup", "/api/v1/models", [][2]string{authz("Bearer github:secret")}, restWant{bearer: true}},
		{"orchestrator token: no session, no lookup", "/api/v1/models", [][2]string{authz("Bearer orch-service-token")}, restWant{bearer: true}},
		{"scheme only: the cookies decide", "/api/v1/models", [][2]string{authz("Bearer"), cookie}, restWant{user: 52}},
		{"scheme then empty part: the cookies decide", "/api/v1/models", [][2]string{authz("Bearer  k-full")}, restWant{}},
		{"unknown key", "/api/v1/models", [][2]string{authz("Bearer k-unknown")}, restWant{reason: "bearer-key-cache-miss", reads: 1}},
		{"lastUsedAt write due", "/api/v1/models", [][2]string{authz("Bearer k-due")}, restWant{reason: "bearer-last-used", reads: 1}},
		{"two Authorization lines", "/api/v1/models", [][2]string{authz("Bearer k-full"), authz("Bearer k-read")}, restWant{reason: "bearer-multiple-headers"}},
		{"a query token", "/api/v1/models?token=k-full", nil, restWant{reason: "bearer-query-token"}},
		{"a byte outside printable ASCII", "/api/v1/models", [][2]string{authz("Bearer k-f\xe9ll")}, restWant{reason: "bearer-malformed"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := restRequest(tc.target, tc.headers...)
			checkREST(t, f, reads, r.Context(), r, tc.want)
		})
	}
	// Keys off: any API credential is the old fallback, and the cookies still resolve.
	off, offReads := restFixture(t)
	off.r.APIKeys = nil
	r := restRequest("/api/v1/models", authz("Bearer k-full"))
	checkREST(t, off, offReads, r.Context(), r, restWant{reason: "bearer-token"})
	r = restRequest("/api/v1/models?token=k-full")
	checkREST(t, off, offReads, r.Context(), r, restWant{reason: "bearer-token"})
}

// A sample carries the sampler's description, never the key: the description is resolved from the
// principal step on (the key's hash), and a redacted sample without one keeps the old fallback.
func TestResolveRESTFromSample(t *testing.T) {
	f, reads := restFixture(t)
	redacted := WithRedactedCredentials(context.Background())
	present := restRequest("/api/v1/models", authz("present"))
	cases := []struct {
		name string
		desc string // "" = none on the context
		want restWant
	}{
		{"no description: the placeholder falls back", "", restWant{reason: "bearer-token"}},
		{"none: the cookies decide (none here)", SampleCredentialNone, restWant{}},
		{"provider token", SampleCredentialProvider, restWant{bearer: true}},
		{"service token", SampleCredentialService, restWant{bearer: true}},
		{"full-scope key by hash", "key:" + nodeHash("k-full"), restWant{user: 51, bearer: true, scope: ScopeFull, full: true, reads: 1}},
		{"read-only key by hash", "key:" + nodeHash("k-read"), restWant{user: 52, bearer: true, scope: ScopeReadOnly, reads: 1}},
		{"unknown hash", "key:" + nodeHash("k-unknown"), restWant{reason: "bearer-key-cache-miss", reads: 1}},
		{"uppercase hex is not generateSecretHash's", "key:" + strings.ToUpper(nodeHash("k-full")), restWant{reason: "bearer-sample-credential"}},
		{"a short hash", "key:abc", restWant{reason: "bearer-sample-credential"}},
		{"the key itself is never read", "k-full", restWant{reason: "bearer-sample-credential"}},
		{"dotted is not a list description", SampleCredentialDotted, restWant{reason: "bearer-sample-credential"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := redacted
			if tc.desc != "" {
				ctx = WithSampleCredential(ctx, tc.desc)
			}
			checkREST(t, f, reads, ctx, present.WithContext(ctx), tc.want)
		})
	}
}

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

// The new scope bits are the app's values (packages/civitai-auth/src/token-scope.ts).
func TestModelViewScopeBits(t *testing.T) {
	if ScopeModelsRead != 4 || ScopeAIServicesRead != 16384 {
		t.Fatalf("ModelsRead %d AIServicesRead %d, want 4 16384", ScopeModelsRead, ScopeAIServicesRead)
	}
}
