package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// FuzzTokenFromCookieHeader: never panics on any header, and a cookie written the way a browser
// sends it (`name=<percent-encoded value>` among other cookies) reads back as its value. Seed corpus:
// testdata/fuzz/FuzzTokenFromCookieHeader.
func FuzzTokenFromCookieHeader(f *testing.F) {
	f.Add("a=1; __Secure-civ-token=eyJ.x.y; b=2", "__Secure-civ-token", "eyJ.x.y")
	f.Add("civ-token=%E2%82%AC%zz", "civ-token", "")
	f.Fuzz(func(t *testing.T, header, name, val string) {
		_ = TokenFromCookieHeader(header, name)
		if name == "" || name != strings.TrimSpace(name) || strings.ContainsAny(name, ";=") {
			return
		}
		h := "other=1; " + name + "=" + url.PathEscape(val) + "; trailing=2"
		if name == "other" {
			h = name + "=" + url.PathEscape(val) + "; trailing=2"
		}
		if got := TokenFromCookieHeader(h, name); got != val {
			t.Fatalf("TokenFromCookieHeader(%q, %q) = %q, want %q", h, name, got, val)
		}
	})
}

// FuzzVerify: Verify never panics and never accepts what it must not. The first two arguments are a
// header and a payload signed with the verifier's own key, so the fuzzer reaches the claims checks; a
// token it accepts must name a positive user id from the expected issuer. The third is an arbitrary
// token string, which no signature from this process's key can be, so it must always be refused.
// Seed corpus: testdata/fuzz/FuzzVerify.
func FuzzVerify(f *testing.F) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	v := &Verifier{
		Issuer:    issuer,
		Now:       func() time.Time { return now },
		keys:      map[string]*ecdsa.PublicKey{"k1": &priv.PublicKey},
		lastFetch: now, // within MinRefetch: an unknown kid fails without a fetch
		lastGood:  now,
	}
	signed := func(t testing.TB, header, payload []byte) string {
		input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
		digest := sha256.Sum256([]byte(input))
		r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		sig := make([]byte, 64)
		r.FillBytes(sig[:32])
		s.FillBytes(sig[32:])
		return input + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	header := []byte(`{"alg":"ES256","kid":"k1","typ":"JWT"}`)
	payload := []byte(`{"sub":"42","jti":"t1","iss":"` + issuer + `","exp":` + strconv.FormatInt(now.Unix()+3600, 10) +
		`,"iat0":` + strconv.FormatInt(now.UnixMilli()-3600000, 10) + `}`)
	// Positive control: the seed session verifies, so the signed half of the fuzz input reaches the
	// claims checks rather than failing at the signature every time.
	if c, err := v.Verify(context.Background(), signed(f, header, payload)); err != nil || c.UserID() != 42 {
		f.Fatalf("the seed session is refused: %v, %+v", err, c)
	}
	f.Add(header, payload, "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2ln")
	f.Add([]byte(`{"alg":"none","kid":"k1"}`), []byte(`{"sub":42}`), "a.b.c")
	f.Fuzz(func(t *testing.T, header, payload []byte, raw string) {
		if c, err := v.Verify(context.Background(), signed(t, header, payload)); err == nil {
			if c.UserID() <= 0 || c.Iss != issuer {
				t.Fatalf("accepted claims with user %d issuer %q: header %s payload %s", c.UserID(), c.Iss, header, payload)
			}
		}
		if c, err := v.Verify(context.Background(), raw); err == nil {
			t.Fatalf("accepted a token this key never signed: %q -> %+v", raw, c)
		}
	})
}
