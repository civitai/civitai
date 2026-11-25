package auth

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

const testSecret = "test-secret"

// nodeHash is generateSecretHash written out here (SHA-512 hex of key + secret), not SecretHash.
func nodeHash(key string) string {
	sum := sha512.Sum512([]byte(key + testSecret))
	return hex.EncodeToString(sum[:])
}

// The literal is `require('crypto').createHash('sha512').update('k-full-user' + 'test-secret').digest('hex')`.
func TestSecretHashIsGenerateSecretHash(t *testing.T) {
	const want = "2b92bac81f4fa6786a4adf6abeaa0e27cd1307363f0d7252551a16fdea103dcdeebdfe027703da381e719b1b27e20a1f4fea4985a91a38df18c1c5339f05b24a"
	if got := SecretHash("k-full-user", testSecret); got != want {
		t.Fatalf("SecretHash = %s, want %s", got, want)
	}
}

// The scope masks, as decimal values of packages/civitai-auth/src/token-scope.ts.
func TestScopeConstantsAreTheAppsValues(t *testing.T) {
	for name, c := range map[string]struct{ got, want int64 }{
		"TokenScope.Full":                {ScopeFull, 33554431},
		"TokenScopePresets.ReadOnly":     {ScopeReadOnly, 10701093},
		"CLIENT_CREDENTIALS_ONLY_SCOPES": {ScopeClientCredentialsOnly, 1342177280},
	} {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d", name, c.got, c.want)
		}
	}
}

// principal writes a principal-cache entry for key, as cacheApiKey stores it (`{apiKey: row}`).
func (f *resolveFixture) principal(t *testing.T, key string, entry any) {
	t.Helper()
	b, err := msgpack.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	f.cache.SetString("ns:packed:caches:api-key-principal:"+nodeHash(key), b)
}

// apiKeyRow is a cacheable, live, full-scope personal key row for userID, used within the hour.
func (f *resolveFixture) apiKeyRow(userID int, mut func(map[string]any)) map[string]any {
	row := map[string]any{
		"id":             7,
		"userId":         userID,
		"tokenScope":     33554431,
		"tokenScopeWide": 33554431,
		"lastUsedAt":     f.now.Add(-10 * time.Minute),
		"buzzLimit":      nil,
		"clientId":       nil,
		"type":           "User",
		"expiresAt":      nil,
	}
	if mut != nil {
		mut(row)
	}
	return map[string]any{"apiKey": row}
}

func newBearerFixture(t *testing.T) *resolveFixture {
	t.Helper()
	f := newResolveFixture(t)
	f.r.ModerationAccountID = 9131
	f.r.APIKeys = &APIKeys{Cache: f.r.Sessions, Secret: testSecret, OrchestratorToken: "orch-service-token", Now: func() time.Time { return f.now }}
	return f
}

type bearerWant struct {
	id        int    // 0 = signed out
	moderator bool   // the viewer's moderator flag
	key       bool   // the viewer came from the API key (SessionUser.APIKey), not a cookie
	reason    string // a fallback reason; "" = none
}

func checkResolve(t *testing.T, r *Resolver, req *http.Request, want bearerWant) {
	t.Helper()
	u, err := r.Resolve(req.Context(), req)
	reason := fallback.Reason(err)
	if err != nil && reason == "" {
		t.Fatalf("non-fallback error %v", err)
	}
	if reason != want.reason {
		t.Fatalf("fallback %q, want %q", reason, want.reason)
	}
	gotID, gotMod, gotKey := 0, false, false
	if u != nil {
		gotID, gotMod, gotKey = u.ID, u.IsModerator, u.APIKey
	}
	if gotID != want.id || gotMod != want.moderator || gotKey != want.key {
		t.Fatalf("user %d moderator %v key %v, want %d %v %v (0 = signed out)", gotID, gotMod, gotKey, want.id, want.moderator, want.key)
	}
}

// TestResolveAPIKeysAsNodeDoes is the rule table of DESIGN.md §4.2: readRequestBearerToken,
// getSessionFromBearerToken and getBearerTokenUser (src/server/auth/), with the credential the app
// gives a cookie session's views (isFullScopeUserKey). Each expectation is the app's answer for that
// request, or the fallback where the app would read data this service does not.
func TestResolveAPIKeysAsNodeDoes(t *testing.T) {
	f := newBearerFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "mod-a", "isModerator": true})
	f.session(t, 45, map[string]any{"id": 45, "username": "viewer-c"})
	f.session(t, 46, map[string]any{"id": 46, "username": "banned-d", "bannedAt": time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)})
	f.session(t, 47, map[string]any{"id": 47, "username": "unbanned-e", "bannedAt": nil})
	f.session(t, 57, map[string]any{"id": 57, "username": "memorialized-k", "memorialized": true})
	f.session(t, 48, map[string]any{"id": 48, "username": "civitaimoderation"})
	f.session(t, 9131, map[string]any{"id": 9131, "username": "renamed-mod-account"})
	f.session(t, 49, map[string]any{"id": 49, "username": "sys-f", "meta": map[string]any{"systemAccount": true}})
	f.session(t, 50, map[string]any{"id": 50, "username": "sys-g", "meta": `{"systemAccount":true}`})
	f.session(t, 51, map[string]any{"id": 51, "username": "notsys-h", "meta": map[string]any{"systemAccount": false}})
	f.session(t, 52, map[string]any{"id": 52, "username": "badmeta-i", "meta": "{not json"})
	f.session(t, 53, map[string]any{"id": 53, "username": "deleted-j", "deletedAt": time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC)})
	f.session(t, 54, map[string]any{"id": 54, "clearedAt": time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC)})
	f.session(t, 56, map[string]any{"id": 999, "username": "other"})
	cookieUser := f.token(t, func(m map[string]any) { m["sub"] = "45"; m["jti"] = "tok-45" })

	row := f.apiKeyRow
	f.principal(t, "k-full-user", row(42, nil))
	f.principal(t, "k-plain", row(45, nil))
	f.principal(t, "k-expired", row(45, func(m map[string]any) { m["expiresAt"] = f.now.Add(-time.Minute) }))
	f.principal(t, "k-expiring", row(45, func(m map[string]any) { m["expiresAt"] = f.now.Add(2 * time.Second) }))
	f.principal(t, "k-expires-later", row(45, func(m map[string]any) { m["expiresAt"] = f.now.Add(time.Hour) }))
	f.principal(t, "k-no-expiry-field", row(45, func(m map[string]any) { delete(m, "expiresAt") }))
	f.principal(t, "k-tombstone", map[string]any{"revoked": true})
	f.principal(t, "k-oauth", row(45, func(m map[string]any) { m["clientId"] = "client-1" }))
	f.principal(t, "k-no-client-field", row(45, func(m map[string]any) { delete(m, "clientId") }))
	f.principal(t, "k-access", row(45, func(m map[string]any) { m["type"] = "Access" }))
	f.principal(t, "k-refresh", row(45, func(m map[string]any) { m["type"] = "Refresh" }))
	f.principal(t, "k-system-type", row(45, func(m map[string]any) { m["type"] = "System" }))
	f.principal(t, "k-read-only", row(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 10701093, 10701093 }))
	f.principal(t, "k-media-read", row(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 32, 32 }))
	f.principal(t, "k-full-plus-opt-in", row(45, func(m map[string]any) {
		m["tokenScope"], m["tokenScopeWide"] = 33554431, int64(33554431|1<<25)
	}))
	f.principal(t, "k-wide-wins", row(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 32, 33554431 }))
	f.principal(t, "k-wide-null", row(45, func(m map[string]any) { m["tokenScope"], m["tokenScopeWide"] = 33554431, nil }))
	f.principal(t, "k-wide-absent", row(45, func(m map[string]any) { m["tokenScope"] = 33554431; delete(m, "tokenScopeWide") }))
	f.principal(t, "k-download-link", row(45, func(m map[string]any) {
		m["tokenScope"], m["tokenScopeWide"] = 33554431, int64(33554431|1<<30)
		m["lastUsedAt"] = nil // refused before the lastUsedAt write
	}))
	f.principal(t, "k-never-used", row(45, func(m map[string]any) { m["lastUsedAt"] = nil }))
	f.principal(t, "k-used-2h-ago", row(45, func(m map[string]any) { m["lastUsedAt"] = f.now.Add(-2 * time.Hour) }))
	f.principal(t, "k-used-at-the-hour", row(45, func(m map[string]any) { m["lastUsedAt"] = f.now.Add(-time.Hour + 2*time.Second) }))
	f.principal(t, "k-no-last-used-field", row(45, func(m map[string]any) { delete(m, "lastUsedAt") }))
	f.principal(t, "k-banned", row(46, nil))
	f.principal(t, "k-banned-stale-use", row(46, func(m map[string]any) { m["lastUsedAt"] = nil }))
	f.principal(t, "k-unbanned", row(47, nil))
	f.principal(t, "k-memorialized", row(57, nil))
	f.principal(t, "k-mod-account-name", row(48, nil))
	f.principal(t, "k-mod-account-id", row(9131, nil))
	f.principal(t, "k-system-meta", row(49, nil))
	f.principal(t, "k-system-meta-string", row(50, nil))
	f.principal(t, "k-system-read-only", row(49, func(m map[string]any) {
		m["type"], m["tokenScope"], m["tokenScopeWide"] = "System", 10701093, 10701093
	}))
	f.principal(t, "k-not-system", row(51, nil))
	f.principal(t, "k-bad-meta", row(52, nil))
	f.principal(t, "k-deleted", row(53, nil))
	f.principal(t, "k-cleared-user", row(54, nil))
	f.principal(t, "k-uncached-user", row(55, nil))
	f.principal(t, "k-id-mismatch", row(56, nil))
	f.principal(t, "k-scope-fraction", row(45, func(m map[string]any) { m["tokenScopeWide"] = 1.5 }))
	f.principal(t, "k-no-user", row(0, nil))
	f.principal(t, "k-expiry-string", row(45, func(m map[string]any) { m["expiresAt"] = "2999-01-01" }))
	f.principal(t, "k-row-not-map", map[string]any{"apiKey": "x"})
	f.principal(t, "k-entry-not-map", 1)
	// The download token and the service token are answered without a lookup: an entry under their
	// hashes, pointing at a user, must never be read.
	f.principal(t, "github:secret", row(42, nil))
	f.principal(t, "orch-service-token", row(42, nil))

	auth := func(v string) map[string]string { return map[string]string{"Authorization": v} }
	B := func(key string) map[string]string { return auth("Bearer " + key) }
	withCookie := func(h map[string]string, v string) map[string]string {
		h["Cookie"] = "__Secure-civ-token=" + v
		return h
	}
	cases := []struct {
		name    string
		headers map[string]string
		target  string
		want    bearerWant
	}{
		// valid keys
		{"full-scope personal key: its user, moderator kept", B("k-full-user"), "/x", bearerWant{id: 42, moderator: true, key: true}},
		{"full-scope personal key, not a moderator", B("k-plain"), "/x", bearerWant{id: 45, key: true}},
		{"expiry an hour away", B("k-expires-later"), "/x", bearerWant{id: 45, key: true}},
		{"tokenScopeWide wins over tokenScope", B("k-wide-wins"), "/x", bearerWant{id: 45, key: true}},
		{"tokenScopeWide null reads tokenScope", B("k-wide-null"), "/x", bearerWant{id: 45, key: true}},
		{"tokenScopeWide absent reads tokenScope", B("k-wide-absent"), "/x", bearerWant{id: 45, key: true}},
		{"bannedAt null is not banned", B("k-unbanned"), "/x", bearerWant{id: 47, key: true}},
		{"a deleted user's cached entry: the app does not check deletedAt", B("k-deleted"), "/x", bearerWant{id: 53, key: true}},
		{"systemAccount false", B("k-not-system"), "/x", bearerWant{id: 51, key: true}},
		{"meta that is not JSON is no meta", B("k-bad-meta"), "/x", bearerWant{id: 52, key: true}},

		// unknown, expired, revoked: the app reads the primary
		{"unknown key", B("k-unknown"), "/x", bearerWant{reason: "bearer-key-cache-miss"}},
		{"expired key", B("k-expired"), "/x", bearerWant{reason: "bearer-key-expiry"}},
		{"key expiring within the clock margin", B("k-expiring"), "/x", bearerWant{reason: "bearer-key-expiry"}},
		{"expiresAt undefined", B("k-no-expiry-field"), "/x", bearerWant{reason: "bearer-key-expiry"}},
		{"revocation tombstone", B("k-tombstone"), "/x", bearerWant{reason: "bearer-key-revoked"}},

		// key type and scope
		{"OAuth key (clientId set)", B("k-oauth"), "/x", bearerWant{reason: "bearer-key-uncacheable"}},
		{"clientId undefined", B("k-no-client-field"), "/x", bearerWant{reason: "bearer-key-uncacheable"}},
		{"Access key", B("k-access"), "/x", bearerWant{reason: "bearer-key-uncacheable"}},
		{"Refresh key", B("k-refresh"), "/x", bearerWant{reason: "bearer-key-uncacheable"}},
		{"System key, full scope", B("k-system-type"), "/x", bearerWant{reason: "bearer-scoped-key"}},
		{"read-only key", B("k-read-only"), "/x", bearerWant{reason: "bearer-scoped-key"}},
		{"MediaRead-only key", B("k-media-read"), "/x", bearerWant{reason: "bearer-scoped-key"}},
		{"full scope plus an opt-in bit is not Full", B("k-full-plus-opt-in"), "/x", bearerWant{reason: "bearer-scoped-key"}},
		{"client-credentials-only scope: signed out", B("k-download-link"), "/x", bearerWant{}},

		// lastUsedAt: a write the app would make
		{"never used", B("k-never-used"), "/x", bearerWant{reason: "bearer-last-used"}},
		{"used two hours ago", B("k-used-2h-ago"), "/x", bearerWant{reason: "bearer-last-used"}},
		{"used an hour ago, within the margin", B("k-used-at-the-hour"), "/x", bearerWant{reason: "bearer-last-used"}},
		{"lastUsedAt undefined", B("k-no-last-used-field"), "/x", bearerWant{reason: "bearer-last-used"}},

		// the user
		{"banned user: signed out", B("k-banned"), "/x", bearerWant{}},
		{"memorialized user: signed out", B("k-memorialized"), "/x", bearerWant{}},
		{"banned user, but the app writes lastUsedAt first", B("k-banned-stale-use"), "/x", bearerWant{reason: "bearer-last-used"}},
		{"moderation account by username: signed out", B("k-mod-account-name"), "/x", bearerWant{}},
		{"moderation account by id: signed out", B("k-mod-account-id"), "/x", bearerWant{}},
		{"system account, write key", B("k-system-meta"), "/x", bearerWant{reason: "bearer-system-account"}},
		{"system account, meta as a JSON string", B("k-system-meta-string"), "/x", bearerWant{reason: "bearer-system-account"}},
		{"system account, read-only System key", B("k-system-read-only"), "/x", bearerWant{reason: "bearer-scoped-key"}},
		{"user not in the session cache", B("k-uncached-user"), "/x", bearerWant{reason: "session-cache-miss"}},
		{"cleared session entry", B("k-cleared-user"), "/x", bearerWant{reason: "session-cache-cleared"}},
		{"session entry for another id", B("k-id-mismatch"), "/x", bearerWant{reason: "session-id-mismatch"}},

		// cache entry shapes the app would not read as this service does
		{"fractional scope", B("k-scope-fraction"), "/x", bearerWant{reason: "bearer-key-cache-shape"}},
		{"no user id", B("k-no-user"), "/x", bearerWant{reason: "bearer-key-cache-shape"}},
		{"expiresAt not a date", B("k-expiry-string"), "/x", bearerWant{reason: "bearer-key-cache-shape"}},
		{"apiKey not an object", B("k-row-not-map"), "/x", bearerWant{reason: "bearer-key-cache-shape"}},
		{"entry not an object", B("k-entry-not-map"), "/x", bearerWant{reason: "bearer-key-cache-shape"}},

		// answered without a lookup
		{"download token (contains ':'): signed out", B("github:secret"), "/x", bearerWant{}},
		{"orchestrator service token: signed out", B("orch-service-token"), "/x", bearerWant{}},

		// bearer and cookie together: the key decides, the cookie is never read
		{"valid key + another user's cookie: the key's user", withCookie(B("k-full-user"), cookieUser), "/x", bearerWant{id: 42, moderator: true, key: true}},
		{"signed-out key + valid cookie: signed out", withCookie(B("github:secret"), cookieUser), "/x", bearerWant{}},
		{"unknown key + valid cookie: the key's fallback", withCookie(B("k-unknown"), cookieUser), "/x", bearerWant{reason: "bearer-key-cache-miss"}},
		{"banned key + valid cookie: signed out", withCookie(B("k-banned"), cookieUser), "/x", bearerWant{}},
		{"memorialized key + valid cookie: signed out", withCookie(B("k-memorialized"), cookieUser), "/x", bearerWant{}},
		{"scheme with no token + valid cookie: the cookie", withCookie(auth("Bearer"), cookieUser), "/x", bearerWant{id: 45}},
		{"control: cookie alone", withCookie(map[string]string{}, cookieUser), "/x", bearerWant{id: 45}},

		// the header as readRequestBearerToken splits it
		{"any scheme: the second part is the key", auth("Basic k-full-user"), "/x", bearerWant{id: 42, moderator: true, key: true}},
		{"lowercase scheme", auth("bearer k-full-user"), "/x", bearerWant{id: 42, moderator: true, key: true}},
		{"a third part is ignored", auth("Bearer k-full-user trailing"), "/x", bearerWant{id: 42, moderator: true, key: true}},
		{"no scheme: no second part, so no key and no session", auth("k-full-user"), "/x", bearerWant{}},
		{"two spaces: an empty second part, so no key", auth("Bearer  k-full-user"), "/x", bearerWant{}},
		{"tab separator: no second part", auth("Bearer\tk-full-user"), "/x", bearerWant{}},
		{"non-ASCII byte in the key", auth("Bearer k-full-user\xa0"), "/x", bearerWant{reason: "bearer-malformed"}},
		{"control byte in the key", auth("Bearer k-full\x01user"), "/x", bearerWant{reason: "bearer-malformed"}},
		{"empty header, no query token: no credential", auth(""), "/x", bearerWant{}},

		// `?token=`, read only without a header (the webhook token cannot be told apart here)
		{"query token", nil, "/x?token=k-full-user", bearerWant{reason: "bearer-query-token"}},
		{"query token, escaped name", nil, "/x?%74oken=k-full-user", bearerWant{reason: "bearer-query-token"}},
		{"query token with an invalid escape", nil, "/x?token=a%zz", bearerWant{reason: "bearer-query-token"}},
		{"empty first query token: no credential", nil, "/x?token=&token=k-full-user", bearerWant{}},
		{"header wins over the query token", B("k-full-user"), "/x?token=k-unknown", bearerWant{id: 42, moderator: true, key: true}},
		{"header without a key: the query token is not read", auth("Bearer"), "/x?token=k-full-user", bearerWant{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkResolve(t, f.r, request(tc.headers, tc.target), tc.want)
		})
	}
}

func TestResolveAPIKeyEdges(t *testing.T) {
	f := newBearerFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "mod-a", "isModerator": true})
	f.principal(t, "k-full-user", f.apiKeyRow(42, nil))
	good := request(map[string]string{"Authorization": "Bearer k-full-user"}, "/x")
	checkResolve(t, f.r, good, bearerWant{id: 42, moderator: true, key: true}) // positive control

	t.Run("several Authorization headers", func(t *testing.T) {
		r := request(nil, "/x")
		r.Header.Add("Authorization", "Bearer k-full-user")
		r.Header.Add("Authorization", "Bearer k-other")
		checkResolve(t, f.r, r, bearerWant{reason: "bearer-multiple-headers"})
	})
	t.Run("a redacted credential (shadow, probe)", func(t *testing.T) {
		r := good.WithContext(WithRedactedCredentials(context.Background()))
		checkResolve(t, f.r, r, bearerWant{reason: "bearer-token"})
	})
	t.Run("off (no APIKeys)", func(t *testing.T) {
		keys := f.r.APIKeys
		f.r.APIKeys = nil
		defer func() { f.r.APIKeys = keys }()
		checkResolve(t, f.r, good, bearerWant{reason: "bearer-token"})
	})
	t.Run("no secret", func(t *testing.T) {
		secret := f.r.APIKeys.Secret
		f.r.APIKeys.Secret = " "
		defer func() { f.r.APIKeys.Secret = secret }()
		checkResolve(t, f.r, good, bearerWant{reason: "bearer-unconfigured"})
	})
	t.Run("no cache", func(t *testing.T) {
		cache := f.r.APIKeys.Cache
		f.r.APIKeys.Cache = nil
		defer func() { f.r.APIKeys.Cache = cache }()
		checkResolve(t, f.r, good, bearerWant{reason: "bearer-unconfigured"})
	})
	t.Run("the hash depends on the secret", func(t *testing.T) {
		secret := f.r.APIKeys.Secret
		f.r.APIKeys.Secret = "another-secret"
		defer func() { f.r.APIKeys.Secret = secret }()
		checkResolve(t, f.r, good, bearerWant{reason: "bearer-key-cache-miss"})
	})
	t.Run("service token unset: an ordinary key", func(t *testing.T) {
		tok := f.r.APIKeys.OrchestratorToken
		f.r.APIKeys.OrchestratorToken = ""
		defer func() { f.r.APIKeys.OrchestratorToken = tok }()
		f.principal(t, "orch-service-token", f.apiKeyRow(42, nil))
		checkResolve(t, f.r, request(map[string]string{"Authorization": "Bearer orch-service-token"}, "/x"), bearerWant{id: 42, moderator: true, key: true})
	})
	t.Run("cache read fails", func(t *testing.T) {
		f.cache.KeyErr = func(key string) error {
			if strings.Contains(key, "api-key-principal") {
				return errors.New("shard down")
			}
			return nil
		}
		defer func() { f.cache.KeyErr = nil }()
		checkResolve(t, f.r, good, bearerWant{reason: "bearer-key-cache-miss"})
	})
	t.Run("undecodable entry", func(t *testing.T) {
		f.cache.SetString("ns:packed:caches:api-key-principal:"+nodeHash("k-garbage"), []byte{0xc1})
		checkResolve(t, f.r, request(map[string]string{"Authorization": "Bearer k-garbage"}, "/x"), bearerWant{reason: "bearer-key-cache-miss"})
	})
	t.Run("empty entry", func(t *testing.T) {
		f.cache.SetString("ns:packed:caches:api-key-principal:"+nodeHash("k-empty"), []byte{})
		checkResolve(t, f.r, request(map[string]string{"Authorization": "Bearer k-empty"}, "/x"), bearerWant{reason: "bearer-key-cache-miss"})
	})
	t.Run("a recorded answer is returned without a read", func(t *testing.T) {
		before := f.cache.Calls
		ctx := WithResolved(context.Background(), &SessionUser{ID: 77, APIKey: true}, nil)
		u, err := f.r.Resolve(ctx, good)
		if err != nil || u == nil || u.ID != 77 || f.cache.Calls != before {
			t.Fatalf("user %+v err %v calls %d->%d, want 77, nil, no read", u, err, before, f.cache.Calls)
		}
	})
	t.Run("a cookie session is not an API-key viewer", func(t *testing.T) {
		tok := f.token(t, nil)
		u, err := f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=" + tok}, "/x"))
		if err != nil || u == nil || u.ID != 42 || u.APIKey {
			t.Fatalf("user %+v err %v, want 42 without APIKey", u, err)
		}
		u, err = f.r.Resolve(context.Background(), good)
		if err != nil || u == nil || !u.APIKey {
			t.Fatalf("key user %+v err %v, want APIKey set", u, err)
		}
	})
}

func TestCarriesBearer(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		target  string
		want    bool
	}{
		{"none", nil, "/x", false},
		{"bearer key", map[string]string{"Authorization": "Bearer k"}, "/x", true},
		{"scheme only", map[string]string{"Authorization": "Bearer"}, "/x", false},
		{"query token (undecidable)", nil, "/x?token=k", true},
		{"empty query token", nil, "/x?token=", false},
		{"cookie only", map[string]string{"Cookie": "a=1"}, "/x", false},
	}
	for _, tc := range cases {
		if got := CarriesBearer(request(tc.headers, tc.target)); got != tc.want {
			t.Errorf("%s: CarriesBearer = %v, want %v", tc.name, got, tc.want)
		}
	}
	r := request(nil, "/x")
	r.Header.Add("Authorization", "Bearer a")
	r.Header.Add("Authorization", "Bearer b")
	if !CarriesBearer(r) {
		t.Error("several headers: CarriesBearer = false, want true")
	}
}

// hasQueryToken is one rule for both switch settings: the URLSearchParams reading, or Go's.
func TestHasQueryToken(t *testing.T) {
	for _, c := range []struct {
		target string
		want   bool
	}{
		{"/x", false},
		{"/x?token=", false},
		{"/x?token=&token=k", false}, // both readings take the first value, ""
		{"/x?token=k", true},
		{"/x?%74oken=k", true},
		{"/x?token=a%zz", true},        // Go drops the pair; URLSearchParams keeps it
		{"/x?token=%zz&token=k", true}, // both see a token, different ones
		{"/x?a=1;token=k", false},      // neither: URLSearchParams reads key `a`, Go drops the pair
		{"/x?tokens=k", false},
	} {
		if got := hasQueryToken(request(nil, c.target)); got != c.want {
			t.Errorf("hasQueryToken(%q) = %v, want %v", c.target, got, c.want)
		}
	}
	// The switch-off path reads the same rule: an invalid escape Go's parser drops still falls back.
	f := newResolveFixture(t)
	checkResolve(t, f.r, request(nil, "/x?token=a%zz"), bearerWant{reason: "bearer-token"})
}

// principal-entry.hex is msgpackr's `pack` (the encoder the app's cacheApiKey writes with, msgpackr
// 1.11.5) of
//
//	{ apiKey: { id: 7, userId: 42, tokenScope: 33554431, tokenScopeWide: undefined,
//	  lastUsedAt: new Date('2026-11-20T12:00:00.000Z'), buzzLimit: null, clientId: null, type: 'User',
//	  expiresAt: new Date('2027-01-01T00:00:00.000Z') } }
//
// generated with `node -e "console.log(require('msgpackr').pack(<that>).toString('hex'))"`.
func TestPrincipalEntryFromNodeEncoder(t *testing.T) {
	raw, err := os.ReadFile("testdata/principal-entry.hex")
	if err != nil {
		t.Fatal(err)
	}
	b, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	v, err := hydrate.Unpack(b)
	if err != nil {
		t.Fatal(err)
	}
	row := v.(map[string]any)["apiKey"].(map[string]any)
	if _, has := row["tokenScopeWide"]; has {
		t.Fatalf("tokenScopeWide (undefined) decoded as present: %#v", row["tokenScopeWide"])
	}
	if got, ok := apiKeyScope(row); !ok || got != 33554431 {
		t.Fatalf("scope %d %v, want 33554431", got, ok)
	}
	if id, ok := hydrate.Int(row["userId"]); !ok || id != 42 {
		t.Fatalf("userId %v, want 42", row["userId"])
	}
	last, ok := row["lastUsedAt"].(time.Time)
	if !ok || !last.Equal(time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("lastUsedAt %#v, want 2026-11-20T12:00:00Z", row["lastUsedAt"])
	}
	exp, ok := row["expiresAt"].(time.Time)
	if !ok || !exp.Equal(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("expiresAt %#v, want 2027-01-01T00:00:00Z", row["expiresAt"])
	}
	if cid, has := row["clientId"]; !has || cid != nil {
		t.Fatalf("clientId %#v (present %v), want null", cid, has)
	}
	if row["type"] != "User" {
		t.Fatalf("type %#v, want User", row["type"])
	}

	// The same bytes through Resolve: served 30 minutes after lastUsedAt, a fallback 2 hours after.
	f := newBearerFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "mod-a", "isModerator": true})
	f.cache.SetString("ns:packed:caches:api-key-principal:"+nodeHash("k-node"), b)
	good := request(map[string]string{"Authorization": "Bearer k-node"}, "/x")
	f.r.APIKeys.Now = func() time.Time { return time.Date(2026, 11, 20, 12, 30, 0, 0, time.UTC) }
	checkResolve(t, f.r, good, bearerWant{id: 42, moderator: true, key: true})
	f.r.APIKeys.Now = func() time.Time { return time.Date(2026, 11, 20, 14, 0, 0, 0, time.UTC) }
	checkResolve(t, f.r, good, bearerWant{reason: "bearer-last-used"})
}

func TestJSTruthy(t *testing.T) {
	for _, c := range []struct {
		v        any
		truthy   bool
		knownTyp bool
	}{
		{nil, false, true}, {false, false, true}, {true, true, true}, {"", false, true}, {"x", true, true},
		{int64(0), false, true}, {int64(3), true, true}, {uint64(0), false, true}, {uint64(1), true, true},
		{0, false, true}, {2, true, true}, {int32(0), false, true}, {int16(1), true, true}, {int8(0), false, true},
		{uint32(1), true, true}, {uint16(0), false, true}, {uint8(1), true, true},
		{0.0, false, true}, {0.5, true, true}, {float32(0), false, true}, {float32(1), true, true},
		{time.Unix(0, 0), true, true}, {map[string]any{}, true, true}, {[]any{}, true, true}, {[]byte{}, true, true},
		{struct{}{}, false, false},
	} {
		truthy, ok := jsTruthy(c.v)
		if truthy != c.truthy || ok != c.knownTyp {
			t.Errorf("jsTruthy(%#v) = %v, %v, want %v, %v", c.v, truthy, ok, c.truthy, c.knownTyp)
		}
	}
}

func TestSystemAccountMeta(t *testing.T) {
	for _, c := range []struct {
		meta    any
		sys, ok bool
	}{
		{nil, false, true},
		{map[string]any{"systemAccount": true}, true, true},
		{map[string]any{"systemAccount": "true"}, true, true}, // any truthy marker counts
		{map[string]any{"systemAccount": 0.0}, false, true},
		{map[string]any{}, false, true},
		{`{"systemAccount":1}`, true, true},
		{`{"systemAccount":false}`, false, true},
		{`null`, false, true},
		{`[1]`, false, true},
		{"not json", false, true},
		{int64(1), false, true},
		{map[string]any{"systemAccount": struct{}{}}, false, false},
	} {
		sys, ok := systemAccountMeta(c.meta)
		if sys != c.sys || ok != c.ok {
			t.Errorf("systemAccountMeta(%#v) = %v, %v, want %v, %v", c.meta, sys, ok, c.sys, c.ok)
		}
	}
}

func TestAPIKeyScope(t *testing.T) {
	for _, c := range []struct {
		row  map[string]any
		want int64
		ok   bool
	}{
		{map[string]any{"tokenScope": int64(32)}, 32, true},
		{map[string]any{"tokenScope": int64(32), "tokenScopeWide": int64(33554431)}, 33554431, true},
		{map[string]any{"tokenScope": int64(32), "tokenScopeWide": nil}, 32, true},
		{map[string]any{"tokenScope": uint64(4294967296)}, 4294967296, true},
		{map[string]any{"tokenScope": 33554431.0}, 33554431, true},
		{map[string]any{"tokenScope": int32(5)}, 5, true},
		{map[string]any{"tokenScope": int16(5)}, 5, true},
		{map[string]any{"tokenScope": int8(5)}, 5, true},
		{map[string]any{"tokenScope": uint32(5)}, 5, true},
		{map[string]any{"tokenScope": uint16(5)}, 5, true},
		{map[string]any{"tokenScope": uint8(5)}, 5, true},
		{map[string]any{"tokenScope": 5}, 5, true},
		{map[string]any{"tokenScope": int64(-1)}, 0, false},
		{map[string]any{"tokenScope": 1.5}, 0, false},
		{map[string]any{"tokenScope": "32"}, 0, false},
		{map[string]any{}, 0, false},
	} {
		got, ok := apiKeyScope(c.row)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("apiKeyScope(%v) = %d, %v, want %d, %v", c.row, got, ok, c.want, c.ok)
		}
	}
}

// firstQueryValue reads a query as URLSearchParams.get does.
func TestFirstQueryValue(t *testing.T) {
	for _, c := range []struct {
		raw, want string
		found     bool
	}{
		{"", "", false},
		{"a=1&&token=x+y", "x y", true},
		{"to%6ben=v", "v", true},
		{"to%6Ben=v%2F1", "v/1", true},
		{"token=a%zz&token=b", "a%zz", true},
		{"token", "", true},
		{"tokens=1", "", false},
	} {
		got, found := firstQueryValue(c.raw, "token")
		if got != c.want || found != c.found {
			t.Errorf("firstQueryValue(%q) = %q, %v, want %q, %v", c.raw, got, found, c.want, c.found)
		}
	}
}
