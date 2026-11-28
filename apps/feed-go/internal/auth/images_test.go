package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The scope bits the images route asks for, as decimal values of packages/civitai-auth/src/token-scope.ts.
func TestImagesScopeConstantsAreTheAppsValues(t *testing.T) {
	if ScopeMediaRead != 32 || ScopeAIServicesRead != 16384 {
		t.Fatalf("MediaRead %d AIServicesRead %d, want 32 16384", ScopeMediaRead, ScopeAIServicesRead)
	}
}

type imagesWant struct {
	id     int    // 0 = signed out
	full   bool   // ImagesViewer.Full
	reason string // a fallback reason; "" = none
}

func checkImages(t *testing.T, r *Resolver, req *http.Request, want imagesWant) {
	t.Helper()
	kv, err := r.ImagesCredential(req.Context(), req)
	reason := fallback.Reason(err)
	if err != nil && reason == "" {
		t.Fatalf("non-fallback error %v", err)
	}
	if reason != want.reason {
		t.Fatalf("fallback %q, want %q", reason, want.reason)
	}
	id := 0
	if kv.User != nil {
		id = kv.User.ID
		if !kv.User.APIKey {
			t.Fatalf("user %d not marked as an API key's", id)
		}
	}
	if id != want.id || kv.Full != want.full {
		t.Fatalf("user %d full %v, want %d %v (0 = signed out)", id, kv.Full, want.id, want.full)
	}
	if err != nil && (kv.User != nil || kv.Full) {
		t.Fatalf("a fallback carries a viewer: %+v", kv)
	}
}

// ImagesCredential is getApiAuthSession on /api/v1/images (readRequestBearerToken, then
// getSessionFromBearerToken, getBearerTokenUser, applySessionScope({anyOf: [MediaRead,
// AIServicesRead]}) and credentialViews): each expectation is the app's reading of that request, or
// the fallback where the app would read what this service does not. The pre-change images compute
// fell back `bearer-token` on every one of these requests (TestRESTRoutesKeepAPICredentialsAFallback,
// switch off), so each viewer row below is red there.
func TestImagesCredentialAsNodeReadsIt(t *testing.T) {
	f := newBearerFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "mod-a", "isModerator": true})
	f.session(t, 45, map[string]any{"id": 45, "username": "viewer-c"})
	f.session(t, 46, map[string]any{"id": 46, "username": "banned-d", "bannedAt": time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)})
	f.session(t, 49, map[string]any{"id": 49, "username": "sys-f", "meta": map[string]any{"systemAccount": true}})

	row := f.apiKeyRow
	scope := func(n int64) func(map[string]any) {
		return func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = n, n }
	}
	f.principal(t, "k-full", row(45, nil))
	f.principal(t, "k-full-mod", row(42, nil))
	f.principal(t, "k-media-read", row(45, scope(32)))
	f.principal(t, "k-ai-read", row(45, scope(16384)))
	f.principal(t, "k-read-only", row(45, scope(10701093)))
	f.principal(t, "k-user-read", row(45, scope(1))) // UserRead alone: short of the route's scope
	f.principal(t, "k-media-read-mod", row(42, scope(32)))
	f.principal(t, "k-full-plus-opt-in", row(45, scope(33554431|1<<25)))
	f.principal(t, "k-system-type", row(45, func(m map[string]any) { m["type"] = "System" }))
	f.principal(t, "k-revoked", map[string]any{"revoked": true})
	f.principal(t, "k-expired", row(45, func(m map[string]any) { m["expiresAt"] = f.now.Add(-time.Minute) }))
	f.principal(t, "k-never-used", row(45, func(m map[string]any) { m["lastUsedAt"] = nil }))
	f.principal(t, "k-oauth", row(45, func(m map[string]any) { m["clientId"] = "client-1" }))
	f.principal(t, "k-download-link", row(45, func(m map[string]any) {
		m["tokenScope"], m["tokenScopeWide"] = 33554431, int64(33554431|1<<30)
		m["lastUsedAt"] = nil
	}))
	f.principal(t, "k-banned", row(46, nil))
	f.principal(t, "k-system-write", row(49, nil))
	// Answered without a lookup: entries under their hashes must never be read.
	f.principal(t, "github:secret", row(45, nil))
	f.principal(t, "orch-service-token", row(45, nil))

	B := func(v string) map[string]string { return map[string]string{"Authorization": v} }
	cases := []struct {
		name    string
		headers map[string]string
		target  string
		want    imagesWant
	}{
		{"full-scope personal key: its user, the session's views", B("Bearer k-full"), "/api/v1/images", imagesWant{id: 45, full: true}},
		{"full-scope key of a moderator: the session's views", B("Bearer k-full-mod"), "/api/v1/images", imagesWant{id: 42, full: true}},
		{"any scheme: the second space-separated part", B("Token k-full"), "/api/v1/images", imagesWant{id: 45, full: true}},
		{"MediaRead key: its user, neither view", B("Bearer k-media-read"), "/api/v1/images", imagesWant{id: 45}},
		{"AIServicesRead key: its user, neither view", B("Bearer k-ai-read"), "/api/v1/images", imagesWant{id: 45}},
		{"read-only preset: its user, neither view", B("Bearer k-read-only"), "/api/v1/images", imagesWant{id: 45}},
		{"full scope plus an opt-in bit is not Full", B("Bearer k-full-plus-opt-in"), "/api/v1/images", imagesWant{id: 45}},
		{"a full-scope System key is not a personal key", B("Bearer k-system-type"), "/api/v1/images", imagesWant{id: 45}},
		{"short of the route's scope (REST_SCOPE_ENFORCE not read)", B("Bearer k-user-read"), "/api/v1/images", imagesWant{reason: "v1-images-key-scope"}},
		{"scoped key of a moderator (the withheld flag not read)", B("Bearer k-media-read-mod"), "/api/v1/images", imagesWant{reason: "v1-images-key-scoped-moderator"}},
		{"revoked key", B("Bearer k-revoked"), "/api/v1/images", imagesWant{reason: "bearer-key-revoked"}},
		{"expired key", B("Bearer k-expired"), "/api/v1/images", imagesWant{reason: "bearer-key-expiry"}},
		{"key not in the principal cache", B("Bearer k-unknown"), "/api/v1/images", imagesWant{reason: "bearer-key-cache-miss"}},
		{"a lastUsedAt write due", B("Bearer k-never-used"), "/api/v1/images", imagesWant{reason: "bearer-last-used"}},
		{"OAuth client key", B("Bearer k-oauth"), "/api/v1/images", imagesWant{reason: "bearer-key-uncacheable"}},
		{"client-credentials key: signed out", B("Bearer k-download-link"), "/api/v1/images", imagesWant{}},
		{"banned user: signed out", B("Bearer k-banned"), "/api/v1/images", imagesWant{}},
		{"system account's write key", B("Bearer k-system-write"), "/api/v1/images", imagesWant{reason: "bearer-system-account"}},
		{"provider download token: signed out, no lookup", B("Bearer github:secret"), "/api/v1/images", imagesWant{}},
		{"orchestrator service token: signed out, no lookup", B("Bearer orch-service-token"), "/api/v1/images", imagesWant{}},
		{"no token part: the app reads the cookies", B("Bearer"), "/api/v1/images", imagesWant{reason: "v1-images-key-none"}},
		{"a ?token= (the webhook token is a secret)", nil, "/api/v1/images?token=k-full", imagesWant{reason: "bearer-query-token"}},
		{"a key holding a tab", B("Bearer k-fu\tll"), "/api/v1/images", imagesWant{reason: "bearer-malformed"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			checkImages(t, f.r, request(c.headers, c.target), c.want)
		})
	}

	t.Run("several Authorization lines", func(t *testing.T) {
		r := request(nil, "/api/v1/images")
		r.Header.Add("Authorization", "Bearer k-full")
		r.Header.Add("Authorization", "Bearer k-media-read")
		checkImages(t, f.r, r, imagesWant{reason: "bearer-multiple-headers"})
	})
}

// A shadow sample carries the Node sampler's description (apiCredentialDescriptor), never the key, and
// is read as the key itself would be: the same rows as TestImagesCredentialAsNodeReadsIt by hash.
func TestImagesCredentialReadsASampleDescription(t *testing.T) {
	f := newBearerFixture(t)
	f.session(t, 45, map[string]any{"id": 45, "username": "viewer-c"})
	f.principal(t, "k-full", f.apiKeyRow(45, nil))
	f.principal(t, "k-media-read", f.apiKeyRow(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 32, 32 }))
	f.principal(t, "k-revoked", map[string]any{"revoked": true})

	sample := func(desc string) *http.Request {
		ctx := WithSampleCredential(WithRedactedCredentials(context.Background()), desc)
		r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/images", nil)
		r.Header.Set("Authorization", "present") // the sampler's placeholder
		return r
	}
	for _, c := range []struct {
		name, desc string
		want       imagesWant
	}{
		{"a full key's hash", SampleCredentialKeyPrefix + nodeHash("k-full"), imagesWant{id: 45, full: true}},
		{"a scoped key's hash", SampleCredentialKeyPrefix + nodeHash("k-media-read"), imagesWant{id: 45}},
		{"a revoked key's hash", SampleCredentialKeyPrefix + nodeHash("k-revoked"), imagesWant{reason: "bearer-key-revoked"}},
		{"an unknown key's hash", SampleCredentialKeyPrefix + nodeHash("k-unknown"), imagesWant{reason: "bearer-key-cache-miss"}},
		{"provider", SampleCredentialProvider, imagesWant{}},
		{"service", SampleCredentialService, imagesWant{}},
		{"none", SampleCredentialNone, imagesWant{reason: "v1-images-key-none"}},
		{"dotted (the images sampler never sends it)", SampleCredentialDotted, imagesWant{reason: "bearer-sample-credential"}},
		{"not a hash", "key:abc", imagesWant{reason: "bearer-sample-credential"}},
	} {
		t.Run(c.name, func(t *testing.T) { checkImages(t, f.r, sample(c.desc), c.want) })
	}

	// A sample without a description (a sampler that predates it) is still the bearer-token fallback,
	// as is every credential with API keys off.
	r := httptest.NewRequestWithContext(WithRedactedCredentials(context.Background()), http.MethodGet, "/api/v1/images", nil)
	r.Header.Set("Authorization", "present")
	checkImages(t, f.r, r, imagesWant{reason: "bearer-token"})
	off := *f.r
	off.APIKeys = nil
	checkImages(t, &off, request(map[string]string{"Authorization": "Bearer k-full"}, "/api/v1/images"), imagesWant{reason: "bearer-token"})
}

// The refactor of resolveBearer (keyUser, fullUserKey) keeps the tRPC routes' reading: a scoped key
// there is still `bearer-scoped-key`, a full one its user. An invariant guard.
func TestResolveBearerStillRefusesScopedKeys(t *testing.T) {
	f := newBearerFixture(t)
	f.session(t, 45, map[string]any{"id": 45, "username": "viewer-c"})
	f.principal(t, "k-full", f.apiKeyRow(45, nil))
	f.principal(t, "k-media-read", f.apiKeyRow(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 32, 32 }))
	checkResolve(t, f.r, request(map[string]string{"Authorization": "Bearer k-full"}, "/x"), bearerWant{id: 45, key: true})
	checkResolve(t, f.r, request(map[string]string{"Authorization": "Bearer k-media-read"}, "/x"), bearerWant{reason: "bearer-scoped-key"})
}
