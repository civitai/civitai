package auth

// API credentials on the public REST route `GET /api/v1/models/[id]` (FEED_GO_V1_BEARER_AUTH; DESIGN.md
// §16.10): a PublicEndpoint (src/server/utils/endpoint-helpers.ts, which reads no session) behind
// withBlockScope (src/server/middleware/block-scope.middleware.ts), which reads an `Authorization:
// Bearer` value of its own. The list route (`GET /api/v1/models`) does not use this: every API
// credential there stays the `bearer-token` fallback.

import (
	"context"
	"net/http"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Sample credentials: what the Node sampler sends in place of a key (src/server/trpc/
// feed-go-shadow-credential.ts), so a shadow sample can be resolved here without the key ever leaving
// the Node app. It is read only off a sample's context (WithSampleCredential), never off a header of a
// public request.
const (
	// SampleCredentialNone: the credential gave no bearer (no `Bearer ` value, or an empty one).
	SampleCredentialNone = "none"
	// SampleCredentialProvider: a token holding `:` (a provider download token): no session.
	SampleCredentialProvider = "provider"
	// SampleCredentialService: the orchestrator service token: no session.
	SampleCredentialService = "service"
	// SampleCredentialDotted: a bearer holding `.` (a block JWT, or what may be one).
	SampleCredentialDotted = "dotted"
	// SampleCredentialKeyPrefix precedes generateSecretHash of an ordinary key: the principal cache key.
	SampleCredentialKeyPrefix = "key:"
)

type sampleCredentialKey struct{}

// WithSampleCredential records the sampler's description of a sample's credential on its context: the
// context of the request rebuilt from the sample, which is where DetailCredential reads it (the compute's own context is the comparison's, not the request's).
func WithSampleCredential(ctx context.Context, desc string) context.Context {
	return context.WithValue(ctx, sampleCredentialKey{}, desc)
}

// sampleCredentialOf is the description on the request's own context (WithSampleCredential).
func sampleCredentialOf(req *http.Request) (string, bool) {
	v, ok := req.Context().Value(sampleCredentialKey{}).(string)
	return v, ok
}

// sampleKeyHash is the hash of a `key:` description: 128 lowercase hex digits, the SHA-512 hex
// generateSecretHash writes. Anything else is no description this service reads.
func sampleKeyHash(desc string) (string, bool) {
	h, ok := strings.CutPrefix(desc, SampleCredentialKeyPrefix)
	if !ok || len(h) != 128 {
		return "", false
	}
	for i := 0; i < len(h); i++ {
		if c := h[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	return h, true
}

// DetailCredential decides an `[id]` request's Authorization header as withBlockScope does. nil means
// Node answers the request as PublicEndpoint does for any caller (the anonymous body; the headers
// follow requestCarriesCallerCredentials) with no side effect this service skips; otherwise the
// fallback.
//
// withBlockScope reads a bearer only from a header that starts with `bearer ` in any case
// (`authHeader.slice(7).trim()`); a `?token=` and any other header value are left to PublicEndpoint,
// which reads no session. A bearer that is a block JWT is verified (not ported: any bearer holding `.`
// falls back, `v1-models-block-token`); any other bearer, while the hub-token path is on, is resolved
// with getSessionFromBearerToken, which may write the key's `lastUsedAt` (and reads the primary on a
// key the principal cache does not hold) and then, for a personal or system key, hands the request to
// PublicEndpoint whatever the user. So such a bearer is answered only when its principal-cache entry
// is read here as getSessionFromBearerToken would read it with no write due (readPrincipal).
//
// A hub OAuth token (an app block's own client) is the one bearer withBlockScope turns into block
// claims: getSessionFromBearerToken gives it an `oauth` subject only when its ApiKey row has a
// clientId. readPrincipal answers only an entry whose `clientId` is null and whose type is User or
// System (isCacheableApiKey), so every such token, cached or not, falls back
// (`bearer-key-uncacheable`, or the miss); TestDetailCredentialRefusesOAuthTokens holds it.
func (r *Resolver) DetailCredential(ctx context.Context, req *http.Request) error {
	if desc, ok := sampleCredentialOf(req); ok && r.APIKeys != nil {
		switch desc {
		case SampleCredentialNone, SampleCredentialProvider, SampleCredentialService:
			return nil
		case SampleCredentialDotted:
			return fallback.New("v1-models-block-token")
		}
		hash, ok := sampleKeyHash(desc)
		if !ok {
			return fallback.New("bearer-sample-credential")
		}
		_, err := r.APIKeys.readPrincipal(ctx, hash, r.APIKeys.now())
		return err
	}
	if r.APIKeys == nil || credentialsRedacted(ctx) {
		if len(req.Header.Values("Authorization")) > 0 {
			return fallback.New("bearer-token")
		}
		return nil
	}
	values := req.Header.Values("Authorization")
	if len(values) > 1 {
		// Node keeps the first and discards the rest; a proxy in between may not. Not decided here.
		return fallback.New("bearer-multiple-headers")
	}
	if len(values) == 0 {
		return nil
	}
	token, isBearer, err := blockBearer(values[0])
	if err != nil || !isBearer || token == "" {
		return err
	}
	if strings.Contains(token, ".") {
		return fallback.New("v1-models-block-token")
	}
	k := r.APIKeys
	if strings.TrimSpace(k.Secret) == "" {
		return fallback.New("bearer-unconfigured")
	}
	if !plainToken(token) {
		return fallback.New("bearer-malformed")
	}
	// getSessionFromBearerToken answers these without a lookup.
	if strings.Contains(token, ":") || k.isOrchestratorServiceToken(token) {
		return nil
	}
	_, err = k.readPrincipal(ctx, SecretHash(token, k.Secret), k.now())
	return err
}

// blockBearer is withBlockScope's bearer: the header lowercased starts with `bearer `, and the bearer
// is the rest, JS-trimmed. Node reads a header as latin-1 and JS's trim also strips non-ASCII space,
// so a rest holding a byte outside printable ASCII and tab is malformed here. A header that does not
// start with `bearer ` (in ASCII; no latin-1 letter lowercases to one of its letters) is no bearer.
func blockBearer(h string) (token string, isBearer bool, err error) {
	const prefix = "bearer "
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) || !isASCII(h[:len(prefix)]) {
		return "", false, nil
	}
	rest := h[len(prefix):]
	for i := 0; i < len(rest); i++ {
		if c := rest[i]; c != '\t' && (c < 0x20 || c > 0x7e) {
			return "", true, fallback.New("bearer-malformed")
		}
	}
	return strings.Trim(rest, " \t"), true, nil
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
