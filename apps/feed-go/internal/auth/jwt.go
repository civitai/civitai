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
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
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
	// FetchTimeout bounds one JWKS fetch (0 = the JWKS_TIMEOUT_MS default).
	FetchTimeout time.Duration
	// RefreshInterval is how often Run refetches the key set (0 = DefaultJWKSRefresh), jittered by
	// ±10% so replicas do not refetch in step. RetryMin is the first retry delay after a failed
	// refresh (0 = 5 s); each further failure doubles it, up to RefreshInterval.
	RefreshInterval time.Duration
	RetryMin        time.Duration
	// OnRefresh, when set, is called after every periodic refresh with its error (nil = success).
	OnRefresh func(err error)
	// MaxStaleness bounds keep-last-good (0 = 3 × the refresh interval): once no fetch has succeeded
	// for this long, the key set is dropped and every session verifies as signed out until a fetch
	// succeeds again. OnStale, when set, is called once each time that happens.
	MaxStaleness time.Duration
	OnStale      func(age time.Duration)

	mu        sync.RWMutex
	keys      map[string]*ecdsa.PublicKey
	lastFetch time.Time
	// lastGood is when a fetch last returned a usable key set (zero = never).
	lastGood time.Time
}

func (v *Verifier) maxStaleness() time.Duration {
	if v.MaxStaleness > 0 {
		return v.MaxStaleness
	}
	interval := v.RefreshInterval
	if interval <= 0 {
		interval = DefaultJWKSRefresh
	}
	return 3 * interval
}

// expireIfStale drops the key set once the last good fetch is older than the maximum staleness, so a
// hub that stays unreachable (or keeps answering an empty set) eventually fails closed, as Node's
// remote JWKS does once its cached set ages out. It reports the drop once per stale episode.
func (v *Verifier) expireIfStale() {
	now := v.now()
	limit := v.maxStaleness()
	v.mu.Lock()
	if v.keys == nil || v.lastGood.IsZero() || now.Sub(v.lastGood) <= limit {
		v.mu.Unlock()
		return
	}
	age := now.Sub(v.lastGood)
	v.keys = nil
	v.mu.Unlock()
	if v.OnStale != nil {
		v.OnStale(age)
	}
}

// DefaultJWKSRefresh is the periodic refresh interval. Without it a signing key the hub removed stayed
// trusted until a restart: the set was only refetched for an unknown kid.
const DefaultJWKSRefresh = 10 * time.Minute

// defaultRetryMin is the first retry delay after a failed periodic refresh.
const defaultRetryMin = 5 * time.Second

// Run refetches the key set right away and then every RefreshInterval (jittered) until ctx ends,
// retrying a failed fetch with exponential backoff. A failed fetch keeps the last good key set (refresh
// replaces the set only on success), so a short hub outage never signs everyone out — but only for
// MaxStaleness: past it the set is dropped (expireIfStale) and verification fails closed.
func (v *Verifier) Run(ctx context.Context) {
	interval := v.RefreshInterval
	if interval <= 0 {
		interval = DefaultJWKSRefresh
	}
	retry := v.RetryMin
	if retry <= 0 {
		retry = defaultRetryMin
	}
	var delay time.Duration // the first fetch runs at once: it warms the set before the first request
	failures := 0
	for {
		if delay > 0 {
			t := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
		}
		if ctx.Err() != nil {
			return
		}
		err := v.refresh(ctx)
		if ctx.Err() != nil {
			return // shutting down: not a refresh failure
		}
		if v.OnRefresh != nil {
			v.OnRefresh(err)
		}
		if err != nil {
			v.expireIfStale()
			failures++
			delay = backoff(retry, interval, failures)
		} else {
			failures = 0
			delay = jitter(interval)
		}
	}
}

// backoff is retry·2^(failures-1), capped at limit.
func backoff(retry, limit time.Duration, failures int) time.Duration {
	d := retry
	for i := 1; i < failures && d < limit; i++ {
		d *= 2
	}
	return min(d, limit)
}

// jitter spreads d over [0.9d, 1.1d).
func jitter(d time.Duration) time.Duration {
	spread := int64(d / 5)
	if spread <= 0 {
		return d
	}
	return d - d/10 + time.Duration(rand.Int64N(spread)) //nolint:gosec // G404: refresh-timing jitter, not a secret
}

// ErrInvalid is returned for any token that is not a valid session.
var ErrInvalid = errors.New("invalid session token")

// now is the key set's clock (refetch pacing, staleness): the wall clock unless a test sets Now. It
// paces this process, so eval mode's frozen clock never reaches it (a frozen pace would never refetch).
func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// tokenNow is the instant a token's times (exp, nbf, signedAt, iat0) are read at: clock.Now (eval
// mode's FEED_GO_EVAL_NOW, else the wall clock) unless a test sets Now.
func (v *Verifier) tokenNow() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return clock.Now()
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
	now := v.tokenNow()
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
	v.expireIfStale()
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
	timeout := v.FetchTimeout
	if timeout <= 0 {
		timeout = 2500 * time.Millisecond // JWKS_TIMEOUT_MS in verify.ts
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
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
	defer func() { _ = res.Body.Close() }()
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
	if len(keys) == 0 {
		// A set with no usable signing key would reject every session; keep the last good one, within
		// MaxStaleness (lastGood is not advanced, so an empty set never extends the window).
		return errors.New("jwks: no usable signing keys")
	}
	v.mu.Lock()
	v.keys = keys
	v.lastGood = v.now()
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
		pub, err := p256PublicKey(xb, yb)
		if err != nil {
			continue
		}
		out[k.Kid] = pub
	}
	return out
}

// p256PublicKey builds a P-256 public key from a JWK's big-endian x and y coordinates, refusing a
// point that is not on the curve. A coordinate is read as an integer: a shorter one is
// left-padded, and leading zero bytes beyond 32 are dropped.
func p256PublicKey(x, y []byte) (*ecdsa.PublicKey, error) {
	const size = 32
	point := make([]byte, 1, 1+2*size)
	point[0] = 4 // SEC 1 uncompressed form: 0x04 || x || y
	for _, c := range [][]byte{x, y} {
		c = bytes.TrimLeft(c, "\x00")
		if len(c) > size {
			return nil, errors.New("jwk: coordinate longer than 32 bytes")
		}
		point = append(point, make([]byte, size-len(c))...)
		point = append(point, c...)
	}
	return ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point)
}

// TokenFromCookieHeader extracts a cookie's value from a raw Cookie header as the `cookie` package's
// parse() (Next's req.cookies, which getHubSession reads) does: the first part with that name wins,
// even when its value is empty; a value starting with `"` loses its first and last character; the value
// is then URL-decoded, and kept raw when it does not decode.
func TokenFromCookieHeader(header, name string) string {
	for _, part := range strings.Split(header, ";") {
		idx := strings.IndexByte(part, '=')
		if idx < 0 {
			continue
		}
		if strings.TrimSpace(part[:idx]) == name {
			val := strings.TrimSpace(part[idx+1:])
			if strings.HasPrefix(val, `"`) {
				// parse()'s value.slice(1, -1): a lone `"` becomes "".
				if len(val) < 2 {
					return ""
				}
				val = val[1 : len(val)-1]
			}
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
