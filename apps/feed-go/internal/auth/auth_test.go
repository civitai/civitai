package auth

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
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

const issuer = "https://auth.example.test"

type keyPair struct {
	kid  string
	priv *ecdsa.PrivateKey
}

func newKey(t *testing.T, kid string) keyPair {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return keyPair{kid: kid, priv: k}
}

func (k keyPair) jwk() map[string]string {
	pad := func(b []byte) []byte { // fixed 32-byte coordinates
		out := make([]byte, 32)
		copy(out[32-len(b):], b)
		return out
	}
	return map[string]string{
		"kty": "EC", "crv": "P-256", "kid": k.kid, "use": "sig", "alg": "ES256",
		"x": base64.RawURLEncoding.EncodeToString(pad(k.priv.X.Bytes())),
		"y": base64.RawURLEncoding.EncodeToString(pad(k.priv.Y.Bytes())),
	}
}

func sign(t *testing.T, k keyPair, alg string, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": alg, "kid": k.kid, "typ": "JWT"})
	p, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func jwksServer(t *testing.T, fetches *int32, keys ...keyPair) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(fetches, 1)
		set := []map[string]string{}
		for _, k := range keys {
			set = append(set, k.jwk())
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": set})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func baseClaims(now time.Time) map[string]any {
	return map[string]any{
		"sub": "42", "jti": "tok-1", "iss": issuer,
		"exp": now.Add(time.Hour).Unix(), "iat": now.Unix(),
		"signedAt": now.UnixMilli(), "iat0": now.Add(-time.Hour).UnixMilli(),
	}
}

func TestVerifyAcceptsAValidSession(t *testing.T) {
	now := time.Now()
	k := newKey(t, "k1")
	var fetches int32
	srv := jwksServer(t, &fetches, k)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, Now: func() time.Time { return now }}
	c, err := v.Verify(context.Background(), sign(t, k, "ES256", baseClaims(now)))
	if err != nil {
		t.Fatal(err)
	}
	if c.UserID() != 42 || c.Jti != "tok-1" {
		t.Fatalf("claims = %+v", c)
	}
	// Second verify reuses the cached key set.
	if _, err := v.Verify(context.Background(), sign(t, k, "ES256", baseClaims(now))); err != nil || fetches != 1 {
		t.Fatalf("err %v, fetches %d", err, fetches)
	}
}

func TestVerifyRejects(t *testing.T) {
	now := time.Now()
	k := newKey(t, "k1")
	other := newKey(t, "k1") // same kid, different key: a forged signature
	var fetches int32
	srv := jwksServer(t, &fetches, k)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, Now: func() time.Time { return now }}

	with := func(mut func(m map[string]any)) map[string]any {
		m := baseClaims(now)
		mut(m)
		return m
	}
	cases := map[string]string{
		"forged signature":             sign(t, other, "ES256", baseClaims(now)),
		"alg not pinned":               sign(t, k, "ES384", baseClaims(now)),
		"expired":                      sign(t, k, "ES256", with(func(m map[string]any) { m["exp"] = now.Add(-time.Second).Unix() })),
		"wrong issuer":                 sign(t, k, "ES256", with(func(m map[string]any) { m["iss"] = "https://evil.test" })),
		"has audience":                 sign(t, k, "ES256", with(func(m map[string]any) { m["aud"] = "x" })),
		"swap token":                   sign(t, k, "ES256", with(func(m map[string]any) { m["purpose"] = "swap" })),
		"impersonation without impExp": sign(t, k, "ES256", with(func(m map[string]any) { m["impersonatedBy"] = 7 })),
		"impersonation expired": sign(t, k, "ES256", with(func(m map[string]any) {
			m["impersonatedBy"] = 7
			m["impExp"] = now.Add(-time.Second).UnixMilli()
		})),
		"lineage older than 90 days": sign(t, k, "ES256", with(func(m map[string]any) { m["iat0"] = now.Add(-91 * 24 * time.Hour).UnixMilli() })),
		"no user id":                 sign(t, k, "ES256", with(func(m map[string]any) { delete(m, "sub") })),
		// resolveSessionUser reads only `sub`: a legacy `user.id` claim never names the viewer.
		"user.id without sub": sign(t, k, "ES256", with(func(m map[string]any) {
			delete(m, "sub")
			m["user"] = map[string]any{"id": 77}
		})),
		"non-numeric sub with user.id": sign(t, k, "ES256", with(func(m map[string]any) {
			m["sub"] = "abc"
			m["user"] = map[string]any{"id": 77}
		})),
		"not a jws": "abc.def",
	}
	for name, tok := range cases {
		if c, err := v.Verify(context.Background(), tok); err == nil {
			t.Errorf("%s: accepted (%+v)", name, c)
		}
	}
	// Tamper with the payload of a valid token: the signature no longer matches.
	good := sign(t, k, "ES256", baseClaims(now))
	parts := splitToken(good)
	forged, _ := json.Marshal(with(func(m map[string]any) { m["sub"] = "1" }))
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString(forged) + "." + parts[2]
	if _, err := v.Verify(context.Background(), tampered); err == nil {
		t.Error("tampered payload accepted")
	}
}

func splitToken(tok string) [3]string {
	var out [3]string
	i := 0
	start := 0
	for j := 0; j < len(tok); j++ {
		if tok[j] == '.' {
			out[i] = tok[start:j]
			i++
			start = j + 1
		}
	}
	out[i] = tok[start:]
	return out
}

func TestUnknownKidRefetchIsRateLimited(t *testing.T) {
	now := time.Now()
	k := newKey(t, "k1")
	stranger := newKey(t, "k2")
	var fetches int32
	srv := jwksServer(t, &fetches, k)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, Now: func() time.Time { return now }, MinRefetch: time.Minute}
	for i := 0; i < 5; i++ {
		_, _ = v.Verify(context.Background(), sign(t, stranger, "ES256", baseClaims(now)))
	}
	if fetches != 1 {
		t.Fatalf("unknown kid fetched the key set %d times, want 1", fetches)
	}
}

func TestDecideRevocation(t *testing.T) {
	signed := float64(1_000_000)
	c := &Claims{Jti: "t", SignedAt: &signed}
	if !Decide(c, "invalid", "", "", "", "", "") || !Decide(c, "", "invalid", "", "", "", "") {
		t.Fatal("an invalid token or family marker revokes")
	}
	if !Decide(c, "", "", "", "1000001", "", "") || Decide(c, "", "", "", "999999", "", "") {
		t.Fatal("user cut compares against signedAt")
	}
	// session:all is an ISO date.
	after := time.UnixMilli(1_000_001).UTC().Format(time.RFC3339Nano)
	before := time.UnixMilli(999_000).UTC().Format(time.RFC3339Nano)
	if !Decide(c, "", "", after, "", "", "") || Decide(c, "", "", before, "", "", "") {
		t.Fatal("session:all compares against signedAt")
	}
	// No signedAt: only the explicit markers revoke.
	if Decide(&Claims{Jti: "t"}, "", "", after, "9999999", "", "") {
		t.Fatal("cut markers need signedAt")
	}
}

func TestSessionUserFrom(t *testing.T) {
	u, err := SessionUserFrom(42, map[string]any{"id": int64(42), "username": "a", "isModerator": true, "bannedAt": nil})
	if err != nil || u.ID != 42 || !u.IsModerator || u.Banned || u.Username != "a" {
		t.Fatalf("got %+v %v", u, err)
	}
	if u, _ := SessionUserFrom(42, map[string]any{"id": int64(42), "bannedAt": time.Now()}); !u.Banned {
		t.Fatal("bannedAt must mark the user banned")
	}
	if _, err := SessionUserFrom(42, map[string]any{"id": int64(43)}); fallback.Reason(err) != "session-id-mismatch" {
		t.Fatalf("a cached user for another id must never be served: %v", err)
	}
	if _, err := SessionUserFrom(42, map[string]any{"id": int64(42), "clearedAt": time.Now()}); fallback.Reason(err) != "session-cache-cleared" {
		t.Fatalf("cleared session: %v", err)
	}
}

func TestTokenFromCookieHeader(t *testing.T) {
	h := `a=1; __Secure-civ-token=abc%2Edef; civ-token=zzz`
	if got := TokenFromCookieHeader(h, "__Secure-civ-token"); got != "abc.def" {
		t.Fatalf("got %q", got)
	}
	if got := TokenFromCookieHeader(h, "__Host-civ-token"); got != "" {
		t.Fatalf("got %q", got)
	}
	if SessionCookieName(true) != "__Secure-civ-token" || SessionCookieName(false) != "civ-token" {
		t.Fatal("cookie names")
	}
}

func TestIsModerationAccount(t *testing.T) {
	const configured = 9131
	if !IsModerationAccount(configured, "someone", configured) {
		t.Fatal("the configured id must be refused")
	}
	if !IsModerationAccount(55, "civitaimoderation", configured) || !IsModerationAccount(55, "CivitaiModeration", 0) {
		t.Fatal("the reserved username must be refused in any casing, with or without a configured id")
	}
	if IsModerationAccount(55, "someone", configured) || IsModerationAccount(configured, "someone", 0) {
		t.Fatal("other users, and any id when none is configured, must pass")
	}
}

func TestResolveRefusesTheModerationAccountBySub(t *testing.T) {
	now := time.Now()
	k := newKey(t, "k1")
	var fetches int32
	srv := jwksServer(t, &fetches, k)
	claims := baseClaims(now)
	claims["sub"] = "9131"
	tok := sign(t, k, "ES256", claims)
	r := &Resolver{
		Verifier:            &Verifier{Issuer: issuer, JWKSURL: srv.URL, Now: func() time.Time { return now }},
		CookieNames:         []string{"civ-token"},
		ModerationAccountID: 9131,
		// Sessions is nil: reaching the session-cache read would panic, so a pass proves the refusal
		// happens on the token's sub, before any lookup.
	}
	req := httptest.NewRequest(http.MethodGet, "/api/trpc/x", nil)
	req.Header.Set("Cookie", "civ-token="+tok)
	u, err := r.Resolve(context.Background(), req)
	if u != nil || err != nil {
		t.Fatalf("moderation account session: got %+v, %v; want signed out", u, err)
	}
}
