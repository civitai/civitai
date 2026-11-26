package auth

// API-key (bearer) credentials, resolved as the main app resolves them for the tRPC procedures this
// service serves: readRequestBearerToken (src/server/auth/request-bearer-token.ts), then
// getSessionFromBearerToken and getBearerTokenUser (src/server/auth/bearer-token.ts), then
// createContext / enforceTokenScope (src/server/createContext.ts,
// src/server/services/oauth/enforce-token-scope.ts). DESIGN.md §4.2 has the rule table.
//
// Only what this service can decide with the main app's own data, at the same freshness, is decided
// here: a key served from the app's own short-lived Redis copy of its ApiKey row (the principal
// cache, src/server/auth/api-key-principal-cache.ts), whose user is in the shared session cache, and
// that the app would answer with the same viewer a cookie session gets. Every other case — a key the
// cache does not hold (the app reads the primary database), a lastUsedAt write the app would make, a
// system account's write key (the app reads the primary), a scoped or non-personal key (the app
// withholds owner and moderator views, which the ported feeds do not model) — is a fallback.

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// APIKeyPrincipalKey is REDIS_KEYS.CACHES.API_KEY_PRINCIPAL (packages/civitai-redis/src/client.ts): the
// principal cache's key prefix, `${prefix}:${hash}`, on the cache cluster.
const APIKeyPrincipalKey = "packed:caches:api-key-principal" //nolint:gosec // G101: a Redis key prefix, not a credential

// LastUsedDebounce is API_KEY_LAST_USED_DEBOUNCE_SECONDS: claimLastUsedWrite writes `lastUsedAt` when the
// cached value is null or older than this.
const LastUsedDebounce = time.Hour

// BearerClockMargin is how far from a time boundary the app's decision must be for this service to
// take it: a key whose expiry, or whose `lastUsedAt` debounce, ends within this margin of now falls
// back, because the app's pod reads its own clock.
const BearerClockMargin = 5 * time.Second

// Token scope bits (packages/civitai-auth/src/token-scope.ts).
const (
	// ScopeFull is TokenScope.Full, bits 0..24.
	ScopeFull int64 = 1<<25 - 1
	// ScopeReadOnly is TokenScopePresets.ReadOnly: UserRead, ModelsRead, MediaRead, ArticlesRead,
	// BountiesRead, BuzzRead, CollectionsRead, AIServicesRead, NotificationsRead, VaultRead.
	ScopeReadOnly int64 = 1<<0 | 1<<2 | 1<<5 | 1<<8 | 1<<11 | 1<<16 | 1<<17 | 1<<14 | 1<<21 | 1<<23
	// ScopeClientCredentialsOnly is CLIENT_CREDENTIALS_ONLY_SCOPES: AppStoreCatalogWrite | DownloadLink.
	ScopeClientCredentialsOnly int64 = 1<<28 | 1<<30
	// ScopeRunnerOnly is RUNNER_ONLY_SCOPES: RunnerMint, accepted only by the app's block-token mint.
	ScopeRunnerOnly int64 = 1 << 33
)

// ApiKeyType values (packages/civitai-db-schema/src/enums.ts) this service tells apart.
const (
	apiKeyTypeUser   = "User"
	apiKeyTypeSystem = "System"
)

// APIKeys resolves API keys. A nil *APIKeys on the Resolver (FEED_GO_BEARER_AUTH off) keeps every
// API credential a `bearer-token` fallback.
type APIKeys struct {
	// Cache reads the principal cache on the cache cluster (Redis and Prefix as for the session cache).
	Cache *hydrate.PackedReader
	// Secret is NEXTAUTH_SECRET, the salt of generateSecretHash. Blank: every key falls back
	// (`bearer-unconfigured`), as the app could not hash it either.
	Secret string
	// OrchestratorToken is ORCHESTRATOR_SERVICE_TOKEN: the app answers it as an unknown key without a
	// lookup (isOrchestratorServiceToken). Blank is unset, as isConfiguredSecret reads it.
	OrchestratorToken string
	// ReadTimeout bounds the principal-cache read (0 = 400ms); past it the request falls back.
	ReadTimeout time.Duration
	// Now is the clock (nil = time.Now).
	Now func() time.Time
}

func (k *APIKeys) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

type redactedKey struct{}

// WithRedactedCredentials marks a request context whose API credential was replaced by a placeholder
// (a shadow or probe sample: the Node sampler sends `authorization: present`, never the key). On such a
// request any API credential is the `bearer-token` fallback, as before this service resolved keys.
func WithRedactedCredentials(ctx context.Context) context.Context {
	return context.WithValue(ctx, redactedKey{}, true)
}

func credentialsRedacted(ctx context.Context) bool {
	v, _ := ctx.Value(redactedKey{}).(bool)
	return v
}

type resolvedKey struct{}

type resolved struct {
	user *SessionUser
	err  error
}

// WithResolved records Resolve's answer for a request on ctx, so a later Resolve with a context
// derived from it returns the same answer without reading the stores again.
func WithResolved(ctx context.Context, u *SessionUser, err error) context.Context {
	return context.WithValue(ctx, resolvedKey{}, &resolved{user: u, err: err})
}

// HasAPICredential reports whether the request carries an API credential: a non-empty Authorization
// header, or a `?token=` value (hasQueryToken).
func HasAPICredential(req *http.Request) bool {
	return req.Header.Get("Authorization") != "" || hasQueryToken(req)
}

// hasQueryToken is the one rule for "the request has a `?token=`", for both FEED_GO_BEARER_AUTH
// settings: the first `token` value as URLSearchParams.get reads it (firstQueryValue) is non-empty,
// or Go's own query parser finds one. The two can disagree (Go drops a pair with an invalid escape or
// a `;`, and then may read a later value), so either one seeing a token counts: the looser reading
// only ever turns a request into a fallback.
func hasQueryToken(req *http.Request) bool {
	return HasQueryTokenRaw(req.URL.RawQuery)
}

// HasQueryTokenRaw is hasQueryToken over a raw query string: the FIRST `token` value is non-empty,
// read as URLSearchParams.get reads it (firstQueryValue) or as Go's parser does. It is
// readRequestBearerToken's reading (`?token=&token=k` is no credential there: the app resolves the
// cookies).
func HasQueryTokenRaw(raw string) bool {
	if v, _ := firstQueryValue(raw, "token"); v != "" {
		return true
	}
	q, _ := url.ParseQuery(raw)
	return q.Get("token") != ""
}

// AnyQueryToken is requestCarriesQueryToken (src/server/utils/request-query-token.ts), the endpoint
// wrappers' credential test: ANY `token` value is non-empty, read as URLSearchParams reads the pairs
// (split on `&` only, an invalid escape kept as written: firstQueryValue's reading) or as Go's parser
// does (which drops a pair with an invalid escape or a `;`). It reports every request HasQueryTokenRaw
// does, and also one whose first value is empty and a later one is not (`?token=&token=k`).
func AnyQueryToken(raw string) bool {
	for _, pair := range strings.Split(raw, "&") {
		k, v, _ := strings.Cut(pair, "=")
		if lenientUnescape(k) == "token" && lenientUnescape(v) != "" {
			return true
		}
	}
	q, _ := url.ParseQuery(raw)
	for _, v := range q["token"] {
		if v != "" {
			return true
		}
	}
	return false
}

// CarriesBearer reports whether the app would resolve the request's session from an API credential
// rather than from its cookies (readRequestBearerToken returns a non-empty token). When it cannot be
// told (a query token, several Authorization headers), it reports true, so the caller resolves and
// meets the fallback. Only serve() calls it, on public requests (never a redacted synthetic one).
func CarriesBearer(req *http.Request) bool {
	_, present, err := bearerToken(req)
	return present || err != nil
}

// bearerToken is readRequestBearerToken: the token is the second space-separated part of the
// Authorization header, whatever the scheme (`header.split(' ')[1]`). A header that is set but has no
// second part (or an empty one) gives no token, and then the `token` query key is NOT read: the app
// returns from the header branch and resolves the cookies. With no header, the first `token` query
// value is the token unless it is the webhook token, which this service cannot know: a fallback
// (hasQueryToken).
func bearerToken(req *http.Request) (token string, present bool, err error) {
	values := req.Header.Values("Authorization")
	if len(values) > 1 {
		// Node keeps the first and discards the rest; a proxy in between may not. Not decided here.
		return "", false, fallback.New("bearer-multiple-headers")
	}
	if len(values) == 1 && values[0] != "" {
		parts := strings.Split(values[0], " ")
		if len(parts) < 2 || parts[1] == "" {
			return "", false, nil
		}
		return parts[1], true, nil
	}
	if hasQueryToken(req) {
		return "", false, fallback.New("bearer-query-token")
	}
	return "", false, nil
}

// firstQueryValue is URLSearchParams.get(name): pairs split on `&` only, `+` read as a space, and a
// percent-escape decoded only where it is valid (an invalid one is kept as written, where Go's own
// query parser would drop the whole pair).
func firstQueryValue(raw, name string) (string, bool) {
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		if lenientUnescape(k) == name {
			return lenientUnescape(v), true
		}
	}
	return "", false
}

func lenientUnescape(s string) string {
	if !strings.ContainsAny(s, "%+") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '+':
			b.WriteByte(' ')
		case c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]):
			b.WriteByte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			i += 2
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isHex(c byte) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case '0' <= c && c <= '9':
		return c - '0'
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// SecretHash is generateSecretHash (packages/civitai-auth/src/secret-hash.ts): the hex SHA-512 of the
// key followed by the secret, the ApiKey row's `key` column.
func SecretHash(key, secret string) string {
	sum := sha512.Sum512([]byte(key + secret))
	return hex.EncodeToString(sum[:])
}

// isOrchestratorServiceToken compares fixed-length digests, as the app does.
func (k *APIKeys) isOrchestratorServiceToken(v string) bool {
	if strings.TrimSpace(k.OrchestratorToken) == "" {
		return false
	}
	a, b := sha256.Sum256([]byte(v)), sha256.Sum256([]byte(k.OrchestratorToken))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// plainToken reports whether every byte of the key is printable ASCII other than space. Node reads a
// header as latin-1 and trims Unicode whitespace before hashing the key as UTF-8, so a key with any
// other byte could hash differently here: such a key falls back.
func plainToken(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// cachedAPIKey is the principal cache entry's `apiKey` (CachedApiKey), as far as this service reads it.
type cachedAPIKey struct {
	userID int
	scope  int64
	typ    string
}

// resolveBearer is getSessionFromBearerToken for an API key, followed by the parts of createContext and
// enforceTokenScope that decide the viewer. (nil, nil) is signed out: the app's session is null, and
// its cookies are not read.
func (r *Resolver) resolveBearer(ctx context.Context, key string) (*SessionUser, error) {
	k := r.APIKeys
	if strings.TrimSpace(k.Secret) == "" {
		return nil, fallback.New("bearer-unconfigured")
	}
	if !plainToken(key) {
		return nil, fallback.New("bearer-malformed")
	}
	// A per-provider download token (`<provider>:<secret>`) never stands for a session.
	if strings.Contains(key, ":") {
		return nil, nil
	}
	if k.isOrchestratorServiceToken(key) {
		return nil, nil
	}
	now := k.now()
	apiKey, err := k.readPrincipal(ctx, SecretHash(key, k.Secret), now)
	if err != nil {
		return nil, err
	}
	// A client-credentials or runner token resolves to no session (no caller here opts in).
	if apiKey.scope&(ScopeClientCredentialsOnly|ScopeRunnerOnly) != 0 {
		return nil, nil
	}
	u, err := r.user(ctx, apiKey.userID)
	if err != nil {
		return nil, err
	}
	// getBearerTokenUser: a banned or memorialized user, or the moderation account, has no bearer session.
	banned, ok := jsTruthy(u.raw["bannedAt"])
	if !ok {
		return nil, fallback.New("bearer-user-shape")
	}
	memorialized, ok := jsTruthy(u.raw["memorialized"])
	if !ok {
		return nil, fallback.New("bearer-user-shape")
	}
	if banned || memorialized {
		return nil, nil
	}
	if IsModerationAccount(u.ID, u.Username, r.ModerationAccountID) {
		return nil, nil
	}
	if apiKey.scope&^ScopeReadOnly != 0 {
		// A system account with moderator access and a write key: the app reads its access from the
		// primary database.
		if sys, ok := systemAccountMeta(u.raw["meta"]); sys || !ok {
			return nil, fallback.New("bearer-system-account")
		}
	}
	// The one credential with a cookie session's views (isFullScopeUserKey): a full-scope personal key
	// not issued to an OAuth client (the cache holds no OAuth key). Any other key changes the moderator
	// and owner views (withModeratorRightsFor, credentialViews) and is held to each procedure's scope.
	if apiKey.typ != apiKeyTypeUser || apiKey.scope != ScopeFull {
		return nil, fallback.New("bearer-scoped-key")
	}
	out := *u
	out.APIKey = true
	return &out, nil
}

// readPrincipal is readCachedApiKey plus the checks getSessionFromBearerToken makes on a cache hit
// before the user is read. Anything the app would answer from the primary database is a fallback.
func (k *APIKeys) readPrincipal(ctx context.Context, hash string, now time.Time) (*cachedAPIKey, error) {
	if k.Cache == nil || k.Cache.Redis == nil {
		return nil, fallback.New("bearer-unconfigured")
	}
	timeout := k.ReadTimeout
	if timeout <= 0 {
		timeout = 400 * time.Millisecond
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	b, err := k.Cache.Redis.Get(rctx, k.Cache.Prefix+APIKeyPrincipalKey+":"+hash).Bytes()
	if errors.Is(err, redis.Nil) {
		// Not cached: an unknown key, or one the app has not read in the last 30 s.
		return nil, fallback.New("bearer-key-cache-miss")
	}
	if err != nil || len(b) == 0 {
		return nil, fallback.Wrap("bearer-key-cache-miss", err)
	}
	v, err := hydrate.Unpack(b)
	if err != nil {
		return nil, fallback.Wrap("bearer-key-cache-miss", err)
	}
	entry, ok := v.(map[string]any)
	if !ok {
		return nil, fallback.New("bearer-key-cache-shape")
	}
	raw, ok := entry["apiKey"]
	if !ok || raw == nil {
		// A revocation tombstone (`{revoked: true}`): the app reads the primary.
		return nil, fallback.New("bearer-key-revoked")
	}
	row, ok := raw.(map[string]any)
	if !ok {
		return nil, fallback.New("bearer-key-cache-shape")
	}
	// isCacheableApiKey: `clientId === null` (absent is undefined, not null) and a User or System key.
	clientID, has := row["clientId"]
	typ, _ := row["type"].(string)
	if !has || clientID != nil || (typ != apiKeyTypeUser && typ != apiKeyTypeSystem) {
		return nil, fallback.New("bearer-key-uncacheable")
	}
	// isLive: `expiresAt === null` or not before now (absent reads as an invalid date: not live).
	exp, has := row["expiresAt"]
	if !has {
		return nil, fallback.New("bearer-key-expiry")
	}
	if exp != nil {
		t, ok := exp.(time.Time)
		if !ok {
			return nil, fallback.New("bearer-key-cache-shape")
		}
		if t.Before(now.Add(BearerClockMargin)) {
			return nil, fallback.New("bearer-key-expiry")
		}
	}
	scope, ok := apiKeyScope(row)
	if !ok {
		return nil, fallback.New("bearer-key-cache-shape")
	}
	userID, ok := hydrate.Int(row["userId"])
	if !ok || userID <= 0 {
		return nil, fallback.New("bearer-key-cache-shape")
	}
	out := &cachedAPIKey{userID: userID, scope: scope, typ: typ}
	if scope&(ScopeClientCredentialsOnly|ScopeRunnerOnly) != 0 {
		return out, nil // refused before the lastUsedAt write
	}
	// claimLastUsedWrite: no write while the cached lastUsedAt is within the hour; otherwise the app
	// claims the hour and writes the row, which this service never does.
	last, has := row["lastUsedAt"]
	t, isTime := last.(time.Time)
	if !has || !isTime || now.Sub(t) > LastUsedDebounce-BearerClockMargin {
		return nil, fallback.New("bearer-last-used")
	}
	return out, nil
}

// apiKeyScope is readApiKeyScope: `BigInt(tokenScopeWide ?? tokenScope)`. A value BigInt would refuse
// (a fraction, a non-number) is not read.
func apiKeyScope(row map[string]any) (int64, bool) {
	v, ok := row["tokenScopeWide"]
	if !ok || v == nil {
		v = row["tokenScope"]
	}
	switch n := v.(type) {
	case int64:
		return n, n >= 0
	case uint64:
		return int64(n), n <= math.MaxInt64 //nolint:gosec // G115: bounded on the same line
	case int:
		return int64(n), n >= 0
	case int32:
		return int64(n), n >= 0
	case int16:
		return int64(n), n >= 0
	case int8:
		return int64(n), n >= 0
	case uint32:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint8:
		return int64(n), true
	case float64:
		if n >= 0 && n <= 1<<53 && n == math.Trunc(n) {
			return int64(n), true
		}
	}
	return 0, false
}

// jsTruthy is JavaScript truthiness for a decoded cache value; ok is false for a type it does not know.
func jsTruthy(v any) (truthy, ok bool) {
	switch t := v.(type) {
	case nil:
		return false, true
	case bool:
		return t, true
	case string:
		return t != "", true
	case int64:
		return t != 0, true
	case uint64:
		return t != 0, true
	case int:
		return t != 0, true
	case int32:
		return t != 0, true
	case int16:
		return t != 0, true
	case int8:
		return t != 0, true
	case uint32:
		return t != 0, true
	case uint16:
		return t != 0, true
	case uint8:
		return t != 0, true
	case float64:
		return t != 0 && !math.IsNaN(t), true
	case float32:
		return t != 0 && !math.IsNaN(float64(t)), true
	case time.Time, map[string]any, []any, []byte:
		return true, true
	}
	return false, false
}

// systemAccountMeta is isSystemAccountMeta (packages/civitai-auth/src/system-account.ts):
// `!!parseMeta(meta)?.systemAccount`, where a string is JSON-parsed (invalid JSON is no meta) and only a
// non-null object is read. ok is false when a value's truthiness is not known.
func systemAccountMeta(meta any) (sys, ok bool) {
	if s, isString := meta.(string); isString {
		var parsed any
		if json.Unmarshal([]byte(s), &parsed) != nil {
			return false, true
		}
		meta = parsed
	}
	m, isMap := meta.(map[string]any)
	if !isMap {
		// null, a number, a boolean, an array (whose `systemAccount` is undefined): no marker.
		return false, true
	}
	return jsTruthy(m["systemAccount"])
}
