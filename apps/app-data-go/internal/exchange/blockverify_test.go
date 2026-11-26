package exchange

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The local check of an App Block token before the hub's block exchange (blockverify.go), against a JWKS
// served the way the site serves it (/api/v1/block-tokens/jwks: kty, use, alg, kid, n, e). Keys are real
// 2048-bit RSA keys and every signature is real, so a forged token is one signed by a key the site does not
// publish. Each refusal starts from a token the "valid" case proves is accepted and changes one thing.

var (
	keysOnce         sync.Once
	siteKey, nextKey *rsa.PrivateKey
	forgerKey        *rsa.PrivateKey
	siteKid, nextKid string
	forgerKid        string
)

func testKeys(t *testing.T) {
	t.Helper()
	keysOnce.Do(func() {
		gen := func() *rsa.PrivateKey {
			k, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				panic(err)
			}
			return k
		}
		siteKey, nextKey, forgerKey = gen(), gen(), gen()
		siteKid, nextKid, forgerKid = kidOf(&siteKey.PublicKey), kidOf(&nextKey.PublicKey), kidOf(&forgerKey.PublicKey)
	})
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func modulus(k *rsa.PublicKey) string { return b64(k.N.Bytes()) }

func kidOf(k *rsa.PublicKey) string { return BlockKeyID(modulus(k)) }

func jwk(k *rsa.PublicKey, kid string) map[string]string {
	return map[string]string{"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid, "n": modulus(k),
		"e": b64(big.NewInt(int64(k.E)).Bytes())}
}

// The fixed clock every case runs at.
var verifyNow = time.Unix(1_800_000_000, 0)

func claimsAt(now time.Time) map[string]any {
	return map[string]any{
		"iss": "civitai", "aud": "civitai-app-block", "sub": "user:42",
		"iat": now.Unix(), "exp": now.Unix() + 900, "jti": "blk-7c1d",
		"appId": "appblk-notes", "appBlockId": "apb_01notes", "blockInstanceId": "inst-1",
		"scopes": []string{"apps:storage"}, "maxBrowsingLevel": 31,
	}
}

func sign(t *testing.T, key *rsa.PrivateKey, header map[string]any, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	input := b64(h) + "." + b64(c)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + b64(sig)
}

func siteToken(t *testing.T, over map[string]any) string {
	t.Helper()
	testKeys(t)
	c := claimsAt(verifyNow)
	for k, v := range over {
		if v == nil {
			delete(c, k)
			continue
		}
		c[k] = v
	}
	return sign(t, siteKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": siteKid}, c)
}

// jwksServer serves keys (changeable mid-test) or, while down, a 503; it counts fetches.
type jwksServer struct {
	mu      sync.Mutex
	keys    []map[string]string
	down    bool
	fetches atomic.Int32
	url     string
}

func newJWKS(t *testing.T, keys ...map[string]string) *jwksServer {
	t.Helper()
	s := &jwksServer{keys: keys}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.fetches.Add(1)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": s.keys})
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

func (s *jwksServer) set(down bool, keys ...map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down, s.keys = down, keys
}

// clock is a settable clock.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func verifier(s *jwksServer, c *clock) *BlockVerifier {
	return &BlockVerifier{JWKSURL: s.url, Now: c.now}
}

func localReason(err error) string {
	var re *RefusedError
	if errors.As(err, &re) && re.Code == LocalRefusalCode {
		return re.Reason
	}
	return ""
}

// A cache whose hub counts its calls and issues every token it is sent.
func countingCache(v *BlockVerifier, c *clock) (*BlockCache, *atomic.Int32, *[]string) {
	var calls atomic.Int32
	var outcomes []string
	var mu sync.Mutex
	return &BlockCache{
		Hub: func(context.Context, string) (Token, error) {
			calls.Add(1)
			return Token{Access: "eyJexchanged", Expires: c.now().Add(10 * time.Minute)}, nil
		},
		Verify: v.Check,
		Now:    c.now,
		Observe: func(outcome, code string) {
			mu.Lock()
			outcomes = append(outcomes, outcome+"/"+code)
			mu.Unlock()
		},
	}, &calls, &outcomes
}

func TestAValidBlockTokenVerifiesAndReachesTheHub(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	cache, calls, outcomes := countingCache(verifier(s, c), c)
	tok, err := cache.Exchange(context.Background(), siteToken(t, nil))
	if err != nil || tok.Access != "eyJexchanged" {
		t.Fatalf("%+v, %v", tok, err)
	}
	if calls.Load() != 1 || s.fetches.Load() != 1 {
		t.Fatalf("hub calls %d, JWKS fetches %d; want 1, 1", calls.Load(), s.fetches.Load())
	}
	if len(*outcomes) != 1 || (*outcomes)[0] != "issued/none" {
		t.Fatalf("%v", *outcomes)
	}
}

// 🔴 Every token the hub would refuse is refused here and never sent, and the refusal is remembered.
func TestAForgedExpiredOrMalformedBlockTokenNeverReachesTheHub(t *testing.T) {
	testKeys(t)
	header := func(over map[string]any) map[string]any {
		h := map[string]any{"alg": "RS256", "typ": "JWT", "kid": siteKid}
		for k, v := range over {
			h[k] = v
		}
		return h
	}
	cases := map[string]struct {
		token  func() string
		reason string
	}{
		"forged: another key under the site kid": {func() string {
			return sign(t, forgerKey, header(nil), claimsAt(verifyNow))
		}, "signature or claims"},
		"a tampered payload": {func() string {
			tok := siteToken(t, nil)
			c := claimsAt(verifyNow)
			c["sub"] = "user:43"
			raw, _ := json.Marshal(c)
			p := splitToken(tok)
			return p[0] + "." + b64(raw) + "." + p[2]
		}, "signature or claims"},
		"expired": {func() string {
			return siteToken(t, map[string]any{"iat": verifyNow.Unix() - 600, "exp": verifyNow.Unix() - 31})
		}, "signature or claims"},
		"not yet valid":      {func() string { return siteToken(t, map[string]any{"nbf": verifyNow.Unix() + 31}) }, "signature or claims"},
		"another issuer":     {func() string { return siteToken(t, map[string]any{"iss": "civitai-dev"}) }, "signature or claims"},
		"another audience":   {func() string { return siteToken(t, map[string]any{"aud": "civitai-other"}) }, "claim shape"},
		"audience as a list": {func() string { return siteToken(t, map[string]any{"aud": []string{"civitai-app-block"}}) }, "claim shape"},
		"no jti":             {func() string { return siteToken(t, map[string]any{"jti": nil}) }, "claim shape"},
		"no appId":           {func() string { return siteToken(t, map[string]any{"appId": ""}) }, "claim shape"},
		"scopes not a list":  {func() string { return siteToken(t, map[string]any{"scopes": "apps:storage"}) }, "claim shape"},
		"anonymous":          {func() string { return siteToken(t, map[string]any{"sub": "anon"}) }, "anonymous"},
		"dev":                {func() string { return siteToken(t, map[string]any{"dev": true}) }, "dev token"},
		"review":             {func() string { return siteToken(t, map[string]any{"reviewRunForReal": true}) }, "review token"},
		"private run":        {func() string { return siteToken(t, map[string]any{"privateRunAudience": "x"}) }, "private run"},
		"runner":             {func() string { return siteToken(t, map[string]any{"mintOrigin": "runner"}) }, "runner token"},
		"other mintOrigin":   {func() string { return siteToken(t, map[string]any{"mintOrigin": "live"}) }, "runner token"},
		"older than 15 min":  {func() string { return siteToken(t, map[string]any{"iat": verifyNow.Unix() - 931}) }, "too old"},
		"typ not JWT": {func() string {
			return sign(t, siteKey, header(map[string]any{"typ": "at+jwt"}), claimsAt(verifyNow))
		}, "malformed"},
		"alg none": {func() string {
			return sign(t, siteKey, header(map[string]any{"alg": "none"}), claimsAt(verifyNow))
		}, "malformed"},
		"not a JWS": {func() string { return "a.b.c" }, "malformed"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
			c := &clock{t: verifyNow}
			cache, calls, outcomes := countingCache(verifier(s, c), c)
			tok := tc.token()
			_, err := cache.Exchange(context.Background(), tok)
			if !errors.Is(err, ErrRefused) || localReason(err) != tc.reason {
				t.Fatalf("err %v (reason %q); want a local refusal %q", err, localReason(err), tc.reason)
			}
			// Remembered: asked again, neither the hub nor the check runs.
			_, err = cache.Exchange(context.Background(), tok)
			if !errors.Is(err, ErrRefused) {
				t.Fatalf("second answer %v", err)
			}
			if calls.Load() != 0 {
				t.Fatalf("the hub was called %d times", calls.Load())
			}
			if got := *outcomes; len(got) != 2 || got[0] != "refused/local" || got[1] != "remembered/local" {
				t.Fatalf("outcomes %v", got)
			}
		})
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

// 🔴 A kid the site does not publish: the JWKS is fetched again for it (rotation), then the token is
// refused, never sent.
func TestAnUnknownKidIsRefetchedThenRefused(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := verifier(s, c)
	cache, calls, _ := countingCache(v, c)
	// Warm the key set.
	if _, err := cache.Exchange(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	c.add(JWKSRefetchEvery)
	forged := sign(t, forgerKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": forgerKid}, claimsAt(c.now()))
	_, err := cache.Exchange(context.Background(), forged)
	if localReason(err) != "unknown key" {
		t.Fatalf("%v", err)
	}
	if s.fetches.Load() != 2 || calls.Load() != 1 {
		t.Fatalf("fetches %d, hub calls %d; want 2, 1", s.fetches.Load(), calls.Load())
	}
}

// 🔴 A flood of made-up kids fetches the JWKS at most once per JWKSRefetchEvery; inside that window an
// unknown kid is not checkable (not a refusal: it may be a key rotated in since), and still never sent.
func TestUnknownKidsDoNotHammerTheJWKS(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := verifier(s, c)
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	for i := range 50 {
		h := map[string]any{"alg": "RS256", "typ": "JWT", "kid": BlockKeyID(string(rune('a' + i%26)))}
		err := v.Check(context.Background(), sign(t, forgerKey, h, claimsAt(c.now())))
		if !errors.Is(err, ErrBlockUnverifiable) {
			t.Fatalf("%d: %v", i, err)
		}
	}
	if s.fetches.Load() != 1 {
		t.Fatalf("fetches %d; want 1", s.fetches.Load())
	}
}

// 🔴 Rotation: a token signed by the site's next key verifies once the JWKS publishes it (two keys), via
// the refetch its unknown kid triggers.
func TestKeyRotationRefetchesOnTheNewKid(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := verifier(s, c)
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	s.set(false, jwk(&siteKey.PublicKey, siteKid), jwk(&nextKey.PublicKey, nextKid))
	c.add(JWKSRefetchEvery)
	rotated := sign(t, nextKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": nextKid}, claimsAt(c.now()))
	if err := v.Check(context.Background(), rotated); err != nil {
		t.Fatalf("rotated key: %v", err)
	}
	// The old key still verifies from the same set.
	if err := v.Check(context.Background(), siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})); err != nil {
		t.Fatalf("old key: %v", err)
	}
	if s.fetches.Load() != 2 {
		t.Fatalf("fetches %d; want 2", s.fetches.Load())
	}
}

// 🔴 JWKS unreachable and no key set held: fail closed. The token is not sent, not remembered (a later
// read checks again), and counted as `unverifiable`.
func TestAJWKSOutageFailsClosedWithoutCallingTheHub(t *testing.T) {
	testKeys(t)
	s := newJWKS(t)
	s.set(true)
	c := &clock{t: verifyNow}
	cache, calls, outcomes := countingCache(verifier(s, c), c)
	tok := siteToken(t, nil)
	if _, err := cache.Exchange(context.Background(), tok); !errors.Is(err, ErrBlockUnverifiable) || errors.Is(err, ErrRefused) {
		t.Fatalf("%v", err)
	}
	if calls.Load() != 0 || (*outcomes)[0] != "unverifiable/none" {
		t.Fatalf("hub calls %d, outcomes %v", calls.Load(), *outcomes)
	}
	// Back up, past the refetch interval: the same token is checked again and sent.
	s.set(false, jwk(&siteKey.PublicKey, siteKid))
	c.add(JWKSRefetchEvery)
	if _, err := cache.Exchange(context.Background(), tok); err != nil {
		t.Fatalf("after recovery: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("hub calls %d; want 1", calls.Load())
	}
}

// A held key set outlives a failing refetch for JWKSMaxStale, then fails closed. The refresh runs in the
// background, so the test waits for it to finish (and fail) before checking again: a failed refresh must
// neither wipe the held set nor extend its life.
func TestAStaleKeySetIsUsedForAnHourThenFailsClosed(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := verifier(s, c)
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	s.set(true)
	fresh := func() string {
		return siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})
	}
	c.add(JWKSMaxStale - time.Second)
	if err := v.Check(context.Background(), fresh()); err != nil {
		t.Fatalf("inside the stale window: %v", err)
	}
	if !settle(t, v) {
		t.Fatal("no refresh was started inside the stale window")
	}
	if s.fetches.Load() != 2 {
		t.Fatalf("fetches %d; want 2 (the warm-up and the failed refresh)", s.fetches.Load())
	}
	if err := v.Check(context.Background(), fresh()); err != nil {
		t.Fatalf("inside the stale window, after the failed refresh: %v", err)
	}
	c.add(time.Second)
	if err := v.Check(context.Background(), fresh()); !errors.Is(err, ErrBlockUnverifiable) {
		t.Fatalf("past it: %v", err)
	}
}

// A published key whose kid is not the site's derivation from its modulus is never used; a set with no
// usable key is a failed fetch.
func TestAKeyWhoseKidIsNotItsModulusIsSkipped(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, nextKid)) // the site key published under the wrong kid
	c := &clock{t: verifyNow}
	tok := sign(t, siteKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": nextKid}, claimsAt(verifyNow))
	if err := verifier(s, c).Check(context.Background(), tok); !errors.Is(err, ErrBlockUnverifiable) {
		t.Fatalf("%v", err)
	}
}

// The site's kid derivation (block-token.service.ts computeKeyId): sha256 of the base64url modulus, the
// first 32 hex characters. Pinned to a literal vector.
func TestBlockKeyIDIsTheSites(t *testing.T) {
	if got := BlockKeyID("AQAB"); got != "300119d97daa790a59e67b6101ca6f83" {
		t.Fatalf("%s", got)
	}
}
