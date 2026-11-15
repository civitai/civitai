// Package auth identifies the viewer of a request the same way the main app does: the `civ-token`
// session cookie is an ES256 JWS signed by the auth hub, verified locally against the hub's JWKS
// (packages/civitai-auth/src/verify.ts), then checked against the shared revocation registry
// (packages/civitai-auth/src/session-registry.ts `isRevoked`).
//
// Anything that fails verification is treated as SIGNED OUT, never as an error: the procedure is a
// public one, and a signed-out viewer only ever receives public data. The one direction that must be
// impossible is the opposite — a request being treated as some OTHER user. Every check below is in
// that direction: the user id comes only from a signature-verified `sub`, never from a header.
package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SessionCookieBase is SESSION_COOKIE_BASE in packages/civitai-auth/src/constants.ts.
const SessionCookieBase = "civ-token"

// SessionLineageMaxAge is SESSION_LINEAGE_MAX_AGE_MS in packages/civitai-auth/src/family.ts.
const SessionLineageMaxAge = 90 * 24 * time.Hour

// SessionCookieName mirrors sessionCookieName(): the `__Secure-` prefix applies when the issuer is https.
func SessionCookieName(secure bool) string {
	if secure {
		return "__Secure-" + SessionCookieBase
	}
	return SessionCookieBase
}

// Claims is the subset of the session JWT payload this service reads (SessionClaims in
// packages/civitai-auth/src/types.ts).
type Claims struct {
	Sub            json.RawMessage `json:"sub"`
	Jti            string          `json:"jti"`
	SignedAt       *float64        `json:"signedAt"`
	ImpersonatedBy *float64        `json:"impersonatedBy"`
	ImpExp         *float64        `json:"impExp"`
	Sid            string          `json:"sid"`
	Iat0           *float64        `json:"iat0"`
	Iss            string          `json:"iss"`
	Aud            json.RawMessage `json:"aud"`
	Exp            *float64        `json:"exp"`
	Nbf            *float64        `json:"nbf"`
	Purpose        json.RawMessage `json:"purpose"`
}

// UserID returns the numeric user id from `sub`, or 0. Only `sub`: resolveSessionUser
// (packages/civitai-auth/src/session-client.ts) takes `Number(claims.sub)` and treats anything else as
// an invalid session, so a legacy `user.id` claim never names the viewer. (The revocation check reads
// `sub ?? user.id`, which equals `sub` for every token Verify accepts, since Verify requires it.)
func (c *Claims) UserID() int {
	raw := c.Sub
	if len(raw) == 0 {
		return 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			return n
		}
		return 0
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil && n > 0 && n == float64(int(n)) {
		return int(n)
	}
	return 0
}

// FamilyID mirrors familyId(): the root session's jti.
func (c *Claims) FamilyID() string {
	if c.Sid != "" {
		return c.Sid
	}
	return c.Jti
}

// Verifier verifies session tokens against a JWKS.
type Verifier struct {
	Issuer      string
	JWKSURL     string
	RequireIat0 bool
	HTTP        *http.Client
	Now         func() time.Time
	// MinRefetch bounds how often an unknown `kid` may trigger a JWKS refetch.
	MinRefetch time.Duration

	mu        sync.RWMutex
	keys      map[string]*ecdsa.PublicKey
	lastFetch time.Time
}

// ErrInvalid is returned for any token that is not a valid session.
var ErrInvalid = errors.New("invalid session token")

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// Verify checks signature, issuer, expiry, purpose and lineage. It does NOT check revocation.
func (v *Verifier) Verify(ctx context.Context, token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrInvalid
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &header) != nil {
		return nil, ErrInvalid
	}
	// Pinned: the allowed algorithm is never taken from the token (alg-confusion guard, as in verify.ts).
	if header.Alg != "ES256" {
		return nil, ErrInvalid
	}
	key, err := v.key(ctx, header.Kid)
	if err != nil {
		return nil, ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return nil, ErrInvalid
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return nil, ErrInvalid
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	var c Claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, ErrInvalid
	}
	if err := v.checkClaims(&c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (v *Verifier) checkClaims(c *Claims) error {
	now := v.now()
	nowSec := float64(now.UnixMilli()) / 1000
	if v.Issuer != "" && c.Iss != v.Issuer {
		return ErrInvalid
	}
	if c.Exp != nil && nowSec >= *c.Exp {
		return ErrInvalid
	}
	if c.Nbf != nil && nowSec < *c.Nbf {
		return ErrInvalid
	}
	// Session tokens carry no `aud`; a token with one is not a session.
	if len(c.Aud) > 0 && string(c.Aud) != "null" {
		return ErrInvalid
	}
	if string(c.Purpose) == `"swap"` {
		return ErrInvalid
	}
	nowMs := float64(now.UnixMilli())
	if c.ImpExp != nil && nowMs >= *c.ImpExp {
		return ErrInvalid
	}
	if c.ImpersonatedBy != nil && c.ImpExp == nil {
		return ErrInvalid
	}
	if c.Iat0 == nil {
		if v.RequireIat0 {
			return ErrInvalid
		}
	} else if nowMs >= *c.Iat0+float64(SessionLineageMaxAge.Milliseconds()) {
		return ErrInvalid
	}
	if c.UserID() == 0 {
		return ErrInvalid
	}
	return nil
}

func (v *Verifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.keys[kid]
	last := v.lastFetch
	v.mu.RUnlock()
	if ok {
		return k, nil
	}
	minRefetch := v.MinRefetch
	if minRefetch == 0 {
		minRefetch = 30 * time.Second
	}
	if !last.IsZero() && v.now().Sub(last) < minRefetch {
		return nil, fmt.Errorf("unknown kid %q", kid)
	}
	if err := v.refresh(ctx); err != nil {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("unknown kid %q", kid)
}

type jwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Use string `json:"use"`
	Alg string `json:"alg"`
}

func (v *Verifier) refresh(ctx context.Context) error {
	v.mu.Lock()
	v.lastFetch = v.now()
	v.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond) // JWKS_TIMEOUT_MS in verify.ts
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.JWKSURL, nil)
	if err != nil {
		return err
	}
	client := v.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks: status %d", res.StatusCode)
	}
	var set struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&set); err != nil {
		return err
	}
	keys := ParseJWKS(set.Keys)
	v.mu.Lock()
	v.keys = keys
	v.mu.Unlock()
	return nil
}

// ParseJWKS keeps the EC P-256 signing keys of a key set.
func ParseJWKS(keys []jwk) map[string]*ecdsa.PublicKey {
	out := map[string]*ecdsa.PublicKey{}
	for _, k := range keys {
		if k.Kty != "EC" || k.Crv != "P-256" || (k.Use != "" && k.Use != "sig") || (k.Alg != "" && k.Alg != "ES256") {
			continue
		}
		xb, err1 := base64.RawURLEncoding.DecodeString(k.X)
		yb, err2 := base64.RawURLEncoding.DecodeString(k.Y)
		if err1 != nil || err2 != nil {
			continue
		}
		pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xb), Y: new(big.Int).SetBytes(yb)}
		if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
			continue
		}
		out[k.Kid] = pub
	}
	return out
}

// TokenFromCookieHeader extracts a cookie's value from a raw Cookie header, URL-decoding it as
// readCookie() in verify.ts does.
func TokenFromCookieHeader(header, name string) string {
	for _, part := range strings.Split(header, ";") {
		idx := strings.IndexByte(part, '=')
		if idx < 0 {
			continue
		}
		if strings.TrimSpace(part[:idx]) == name {
			val := strings.TrimSpace(part[idx+1:])
			if dec, err := urlDecode(val); err == nil {
				return dec
			}
			return val
		}
	}
	return ""
}

// urlDecode is decodeURIComponent: percent-escapes only, '+' is left as is.
func urlDecode(s string) (string, error) { return url.PathUnescape(s) }
