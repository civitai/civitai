package exchange

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BlockVerifier checks an App Block token's signature and claims here, before it is sent to the hub, so a
// token the hub would refuse as forged, expired or malformed never reaches it: a flood of made-up tokens
// spends nothing at the hub (where this service's exchange budget is shared with its user exchanges).
//
// It mirrors the hub's verifyBlockTokenForExchange (apps/auth/src/lib/server/oauth/block-token-verify.ts),
// which mirrors the site's verifyBlockToken: the kid'd key, RS256, `typ: JWT`, issuer, audience, expiry and
// not-before with 30 s of tolerance, the claim shapes, the signed-in subject, the dev / review / private-run
// markers and the 15-minute age cap. The hub still verifies every token it is sent; this check only keeps
// tokens it would refuse from being sent.
//
// The keys are the site's published JWKS (GET /api/v1/block-tokens/jwks: every key the site verifies
// with, current and next, so a rotation is two keys). They are fetched on first use, refreshed after
// JWKSRefresh, and refetched when a token names a kid not held, at most once per JWKSRefetchEvery. A key is
// used only when its published kid is the site's derivation from its modulus (block-token-verify.ts keyId).
//
// FAIL CLOSED: when no usable key set is held (never fetched, or the last good fetch is older than
// JWKSMaxStale), Check answers ErrBlockUnverifiable and the token is not sent: the read goes to REST.
type BlockVerifier struct {
	// JWKSURL is the site's block-token JWKS.
	JWKSURL string
	// HTTP is the client; nil is http.DefaultClient. Redirects are never followed.
	HTTP *http.Client
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time // the last fetch that produced a key set
	triedAt   time.Time // the last fetch attempted, good or not
}

const (
	// JWKSRefresh is how long a fetched key set is used before it is fetched again.
	JWKSRefresh = 5 * time.Minute
	// JWKSMaxStale is how long a key set may be used while fetching it again fails.
	JWKSMaxStale = time.Hour
	// JWKSRefetchEvery bounds how often the JWKS is fetched, an unknown kid included.
	JWKSRefetchEvery = 30 * time.Second
	jwksTimeout      = 5 * time.Second
	maxJWKSBytes     = 64 << 10
	maxBlockKeys     = 8
)

// The hub's constants (block-token-verify.ts, pinned there to the site's).
const (
	blockTokenIssuer   = "civitai"
	blockTokenAudience = "civitai-app-block" //nolint:gosec // G101: the block token audience name, not a credential
	blockMaxAge        = 15 * 60
	blockClockSkew     = 30
)

var blockUserSub = regexp.MustCompile(`^user:[1-9][0-9]{0,11}$`)

// ErrBlockUnverifiable is a block token that cannot be checked now: no usable key set is held (the JWKS
// could not be fetched), or its kid is unknown and the JWKS was fetched too recently to fetch again. Not
// a refusal: nothing is remembered, and the read goes to REST.
var ErrBlockUnverifiable = errors.New("exchange: the block token cannot be verified now")

// LocalRefusalCode is the refusal code of a block token refused here, never sent to the hub.
const LocalRefusalCode = "local"

// localRefusal is a token refused here: ErrRefused, with the code LocalRefusalCode, and the reason the hub
// would give (block-token-verify.ts BlockTokenRefusal). Never a token or a claim value.
func localRefusal(reason string) error {
	return &RefusedError{Status: 0, Code: LocalRefusalCode, Reason: reason}
}

// Check reports whether token may be sent to the hub's block exchange: nil when it verifies, an ErrRefused
// (code LocalRefusalCode) when the hub would refuse it, ErrBlockUnverifiable when it cannot be checked.
func (v *BlockVerifier) Check(ctx context.Context, token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return localRefusal("malformed")
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid any    `json:"kid"`
	}
	if !decodeSegment(parts[0], &header) {
		return localRefusal("malformed")
	}
	if header.Alg != "RS256" || header.Typ != "JWT" {
		return localRefusal("malformed")
	}
	kid, ok := header.Kid.(string)
	if !ok {
		return localRefusal("unknown key")
	}
	key, err := v.key(ctx, kid)
	if err != nil {
		return err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return localRefusal("signature or claims")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return localRefusal("signature or claims")
	}
	var claims map[string]any
	if !decodeSegment(parts[1], &claims) {
		return localRefusal("signature or claims")
	}
	return checkBlockClaims(claims, v.now().Unix())
}

// checkBlockClaims is block-token-verify.ts after the signature: jose's issuer, audience, exp and nbf
// checks with 30 s of tolerance, then the claim shapes, the subject, the markers and the age cap.
func checkBlockClaims(c map[string]any, now int64) error {
	if c["iss"] != blockTokenIssuer {
		return localRefusal("signature or claims")
	}
	exp, expOK := number(c["exp"])
	iat, iatOK := number(c["iat"])
	if _, present := c["exp"]; present && !expOK {
		return localRefusal("signature or claims")
	}
	if expOK && exp <= float64(now-blockClockSkew) {
		return localRefusal("signature or claims")
	}
	if nbf, present := c["nbf"]; present {
		n, ok := number(nbf)
		if !ok || n > float64(now+blockClockSkew) {
			return localRefusal("signature or claims")
		}
	}
	if _, present := c["iat"]; present && !iatOK {
		return localRefusal("signature or claims")
	}
	// jose accepts `aud` as a list holding the audience; the hub's shape check then wants a string.
	aud, audOK := c["aud"].(string)
	sub, subOK := c["sub"].(string)
	appID, _ := c["appId"].(string)
	_, blockOK := c["appBlockId"].(string)
	_, instOK := c["blockInstanceId"].(string)
	jti, _ := c["jti"].(string)
	if !audOK || aud != blockTokenAudience || !subOK || appID == "" || !blockOK || !instOK || jti == "" ||
		!stringList(c["scopes"]) || !iatOK || !expOK {
		return localRefusal("claim shape")
	}
	if !blockUserSub.MatchString(sub) {
		return localRefusal("anonymous")
	}
	if !absentOrFalse(c, "dev") {
		return localRefusal("dev token")
	}
	if !absentOrFalse(c, "reviewRunForReal") {
		return localRefusal("review token")
	}
	if _, present := c["privateRunAudience"]; present || !absentOrFalse(c, "privateRun") {
		return localRefusal("private run")
	}
	if float64(now)-iat > blockMaxAge+blockClockSkew {
		return localRefusal("too old")
	}
	return nil
}

func number(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

func stringList(v any) bool {
	list, ok := v.([]any)
	if !ok {
		return false
	}
	for _, s := range list {
		if _, ok := s.(string); !ok {
			return false
		}
	}
	return true
}

func absentOrFalse(c map[string]any, name string) bool {
	v, present := c[name]
	return !present || v == false
}

func decodeSegment(seg string, out any) bool {
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}

// key is the key for kid, fetching the JWKS when it is due or kid is unknown (at most once per
// JWKSRefetchEvery). Concurrent callers wait on one fetch.
func (v *BlockVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	due := v.keys == nil || now.Sub(v.fetchedAt) >= JWKSRefresh
	_, known := v.keys[kid]
	fetched := false
	if (due || !known) && (v.triedAt.IsZero() || now.Sub(v.triedAt) >= JWKSRefetchEvery) {
		v.triedAt = now
		if keys, err := v.fetch(ctx); err == nil {
			v.keys, v.fetchedAt, fetched = keys, now, true
		}
	}
	if v.keys == nil || now.Sub(v.fetchedAt) >= JWKSMaxStale {
		return nil, ErrBlockUnverifiable
	}
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	// Unknown after a fetch made for it: the site holds no such key. Unknown while a fetch is not due
	// yet: it may be a key rotated in since, so not a refusal.
	if fetched {
		return nil, localRefusal("unknown key")
	}
	return nil, ErrBlockUnverifiable
}

// fetch reads the JWKS: the RS256 RSA signing keys whose kid is the site's derivation from their modulus.
// An answer with no such key is a failed fetch.
func (v *BlockVerifier) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, jwksTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.JWKSURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := NoRedirects(v.HTTP).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks: HTTP %d", res.StatusCode)
	}
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Use string `json:"use"`
			Alg string `json:"alg"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxJWKSBytes)).Decode(&set); err != nil {
		return nil, errors.New("jwks: not a key set")
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if len(keys) == maxBlockKeys {
			break
		}
		if k.Kty != "RSA" || (k.Alg != "" && k.Alg != "RS256") || (k.Use != "" && k.Use != "sig") {
			continue
		}
		if k.Kid != BlockKeyID(k.N) {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(k.N)
		e, errE := base64.RawURLEncoding.DecodeString(k.E)
		if errN != nil || errE != nil || len(n) < 256 || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := int(new(big.Int).SetBytes(e).Int64())
		if exp < 3 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
	}
	if len(keys) == 0 {
		return nil, errors.New("jwks: no usable key")
	}
	return keys, nil
}

// BlockKeyID is the site's kid for an RSA key: the first 32 hex characters of the SHA-256 of its
// base64url modulus (block-token.service.ts computeKeyId; block-token-verify.ts keyId).
func BlockKeyID(modulus string) string {
	sum := sha256.Sum256([]byte(modulus))
	return hex.EncodeToString(sum[:])[:32]
}

func (v *BlockVerifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}
