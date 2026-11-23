package exchange

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func signRaw(t *testing.T, key *rsa.PrivateKey, header map[string]any, payload string) string {
	t.Helper()
	h, _ := json.Marshal(header)
	input := b64(h) + "." + b64([]byte(payload))
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + b64(sig)
}

// The remaining shapes the hub refuses, each refused here.
func TestMoreMalformedBlockTokensAreRefusedHere(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	v := verifier(s, &clock{t: verifyNow})
	h := map[string]any{"alg": "RS256", "typ": "JWT", "kid": siteKid}
	p := splitToken(siteToken(t, nil))
	for name, tc := range map[string]struct{ token, reason string }{
		"two segments":            {p[0] + "." + p[1], "malformed"},
		"header not JSON":         {b64([]byte("{")) + "." + p[1] + "." + p[2], "malformed"},
		"kid not a string":        {sign(t, siteKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": 7}, claimsAt(verifyNow)), "unknown key"},
		"signature not base64url": {p[0] + "." + p[1] + ".+/+/", "signature or claims"},
		"payload not JSON":        {signRaw(t, siteKey, h, "not json"), "signature or claims"},
		"exp not a number":        {siteToken(t, map[string]any{"exp": "soon"}), "signature or claims"},
		"iat not a number":        {siteToken(t, map[string]any{"iat": "now"}), "signature or claims"},
		"no exp":                  {siteToken(t, map[string]any{"exp": nil}), "claim shape"},
		"a scope not a string":    {siteToken(t, map[string]any{"scopes": []any{"apps:storage", 1}}), "claim shape"},
	} {
		if got := localReason(v.Check(context.Background(), tc.token)); got != tc.reason {
			t.Errorf("%s: %q, want %q", name, got, tc.reason)
		}
	}
}

// What a fetched key set keeps: RSA signing keys for RS256 whose kid is their modulus's, at most
// maxBlockKeys. A set with none, an error answer, a body that is not a key set, or an unreachable URL
// is a failed fetch: the token is unverifiable, never refused.
func TestTheJWKSKeepsOnlyUsableKeys(t *testing.T) {
	testKeys(t)
	site := jwk(&siteKey.PublicKey, siteKid)
	with := func(over map[string]string) map[string]string {
		k := map[string]string{}
		for a, b := range site {
			k[a] = b
		}
		for a, b := range over {
			k[a] = b
		}
		return k
	}
	short := b64(make([]byte, 128))
	for name, key := range map[string]map[string]string{
		"an EC key":           with(map[string]string{"kty": "EC"}),
		"another alg":         with(map[string]string{"alg": "RS512"}),
		"an encryption key":   with(map[string]string{"use": "enc"}),
		"a modulus too short": with(map[string]string{"n": short, "kid": BlockKeyID(short)}),
		"an exponent of 1":    with(map[string]string{"e": b64([]byte{1})}),
		"an empty exponent":   with(map[string]string{"e": ""}),
		"a bad modulus":       with(map[string]string{"n": "!!", "kid": BlockKeyID("!!")}),
	} {
		s := newJWKS(t, key)
		err := verifier(s, &clock{t: verifyNow}).Check(context.Background(), siteToken(t, nil))
		if !errors.Is(err, ErrBlockUnverifiable) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// No alg and no use are allowed (the defaults).
	s := newJWKS(t, with(map[string]string{"alg": "", "use": ""}))
	if err := verifier(s, &clock{t: verifyNow}).Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Errorf("no alg/use: %v", err)
	}
	// At most maxBlockKeys are read: the site key listed after eight others is not, so its kid is unknown
	// after a fresh fetch (refused). Listed first, it is read.
	many := make([]map[string]string, 0, maxBlockKeys+1)
	for i := range maxBlockKeys {
		n := b64(append(make([]byte, 255), byte(i+1)))
		many = append(many, with(map[string]string{"n": n, "kid": BlockKeyID(n)}))
	}
	s = newJWKS(t, append(many, site)...)
	if got := localReason(verifier(s, &clock{t: verifyNow}).Check(context.Background(), siteToken(t, nil))); got != "unknown key" {
		t.Errorf("ninth key: %q", got)
	}
	s = newJWKS(t, append([]map[string]string{site}, many...)...)
	if err := verifier(s, &clock{t: verifyNow}).Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Errorf("first key: %v", err)
	}
	// Not a key set.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("<html>")) }))
	defer bad.Close()
	if err := (&BlockVerifier{JWKSURL: bad.URL}).Check(context.Background(), siteToken(t, nil)); !errors.Is(err, ErrBlockUnverifiable) {
		t.Errorf("html: %v", err)
	}
	// Unreachable, and not a URL; on the real clock (Now nil), where the token has long expired, but no
	// key set means it is never read.
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	for _, u := range []string{closed.URL, "::not a url"} {
		if err := (&BlockVerifier{JWKSURL: u}).Check(context.Background(), siteToken(t, nil)); !errors.Is(err, ErrBlockUnverifiable) {
			t.Errorf("%q: %v", u, err)
		}
	}
}
