package auth

// API credentials on the public REST route `GET /api/v1/images` (FEED_GO_V1_IMAGES_BEARER_AUTH and
// FEED_GO_V1_IMAGES_SERVE_BEARER; DESIGN.md §13.8.1). The handler (src/pages/api/v1/images/index.ts) is
// a PublicEndpoint that reads the session itself with getApiAuthSession({ whenBanned: 'anonymous',
// scope: { anyOf: [MediaRead, AIServicesRead] } }): resolveSession reads the API credential first
// (readRequestBearerToken), and when there is one its answer is the request's, signed out included;
// the cookies are not read. runImageSearch then reads the content with credentialViews: a full-scope
// personal key gets a cookie session's views (the owner's, and a moderator's for a moderator); any
// other key gets neither, while its user's id still reaches the feed query (`currentUserId`) and
// getAllImages (`userId`).
//
// Unlike the tRPC routes (resolveBearer), a scoped key is answered here, with ImagesViewer.Full false.
// Every case whose answer this service cannot reproduce from the principal cache falls back.

import (
	"context"
	"net/http"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Token scope bits the images route asks a credential for (packages/civitai-auth/src/token-scope.ts).
const (
	// ScopeMediaRead is TokenScope.MediaRead.
	ScopeMediaRead int64 = 1 << 5
	// ScopeAIServicesRead is TokenScope.AIServicesRead.
	ScopeAIServicesRead int64 = 1 << 14
)

// ImagesViewer is the images route's reading of a request's API credential.
type ImagesViewer struct {
	// User is the session user the credential stands for (SessionUser.APIKey set); nil = signed out
	// (getSessionFromBearerToken returned no session, so the route answers as for anyone).
	User *SessionUser
	// Full reports credentialViews' `isSessionOrFullUserKey`: a full-scope personal key, which reads
	// content as the user's cookie session does (asOwner, and asModerator for a moderator). False:
	// neither view, though the user's id still reaches the feed query.
	Full bool
}

// ImagesCredential decides the API credential of a `GET /api/v1/images` request (one that carries an
// Authorization header or a `token` query value) as getApiAuthSession does. A non-nil error is always
// a fallback.
//
// On a shadow sample the key is never sent: the Node sampler sends its description
// (src/server/trpc/feed-go-shadow-credential.ts apiCredentialDescriptor, carried on the context by
// WithSampleCredential), read here as the key itself would be:
//
//   - `provider` / `service`: a download token or the orchestrator service token, which stands for no
//     session: signed out;
//   - `none`: the header has no token part (`header.split(' ')[1]` is empty), so the app resolves the
//     cookies instead: `v1-images-key-none` (not ported);
//   - `key:<hash>`: the principal cache entry for that hash (imagesKey);
//   - anything else: `bearer-sample-credential`.
//
// On a public request the credential is read as readRequestBearerToken reads it (bearerToken): several
// Authorization lines fall back (`bearer-multiple-headers`), a `?token=` too (`bearer-query-token`: the
// app compares it with the webhook token, a secret this service does not hold), and a header with no
// token part is `v1-images-key-none`. A token holding `:` or the orchestrator service token is signed
// out, as getSessionFromBearerToken answers both without a lookup.
func (r *Resolver) ImagesCredential(ctx context.Context, req *http.Request) (ImagesViewer, error) {
	if r == nil || r.APIKeys == nil {
		return ImagesViewer{}, fallback.New("bearer-token")
	}
	if desc, ok := sampleCredentialOf(req); ok {
		switch desc {
		case SampleCredentialProvider, SampleCredentialService:
			return ImagesViewer{}, nil
		case SampleCredentialNone:
			return ImagesViewer{}, fallback.New("v1-images-key-none")
		}
		hash, ok := sampleKeyHash(desc)
		if !ok {
			return ImagesViewer{}, fallback.New("bearer-sample-credential")
		}
		return r.imagesKey(ctx, hash)
	}
	if credentialsRedacted(ctx) {
		// A sample with no description (a sampler that predates it): the key was not sent.
		return ImagesViewer{}, fallback.New("bearer-token")
	}
	key, present, err := bearerToken(req)
	if err != nil {
		return ImagesViewer{}, err
	}
	if !present {
		return ImagesViewer{}, fallback.New("v1-images-key-none")
	}
	k := r.APIKeys
	if strings.TrimSpace(k.Secret) == "" {
		return ImagesViewer{}, fallback.New("bearer-unconfigured")
	}
	if !plainToken(key) {
		return ImagesViewer{}, fallback.New("bearer-malformed")
	}
	if strings.Contains(key, ":") || k.isOrchestratorServiceToken(key) {
		return ImagesViewer{}, nil
	}
	return r.imagesKey(ctx, SecretHash(key, k.Secret))
}

// imagesKey resolves the key whose generateSecretHash is hash: getSessionFromBearerToken on a
// principal-cache hit with no write due (readPrincipal: a miss, a revocation, an OAuth client's key,
// an expired or expiring key and a due lastUsedAt write all fall back), getBearerTokenUser (keyUser),
// then applySessionScope and credentialViews:
//
//   - a client-credentials or runner token: signed out (getSessionFromBearerToken refuses it);
//   - a full-scope personal key: the user, Full;
//   - any other key holding MediaRead or AIServicesRead: the user, not Full, unless the user is a
//     moderator (`v1-images-key-scoped-moderator`: applySessionScope then withholds the moderator flag
//     under REST_SCOPE_ENFORCE=enforce only, a setting this service does not read);
//   - any other key: `v1-images-key-scope` (short of the route's scope the app answers signed out
//     under REST_SCOPE_ENFORCE=enforce and as the user otherwise: not read here either).
func (r *Resolver) imagesKey(ctx context.Context, hash string) (ImagesViewer, error) {
	k := r.APIKeys
	apiKey, err := k.readPrincipal(ctx, hash, k.now())
	if err != nil {
		return ImagesViewer{}, err
	}
	if apiKey.scope&(ScopeClientCredentialsOnly|ScopeRunnerOnly) != 0 {
		return ImagesViewer{}, nil
	}
	u, err := r.keyUser(ctx, apiKey)
	if err != nil || u == nil {
		return ImagesViewer{}, err
	}
	if apiKey.fullUserKey() {
		return ImagesViewer{User: u, Full: true}, nil
	}
	if apiKey.scope&(ScopeMediaRead|ScopeAIServicesRead) == 0 {
		return ImagesViewer{}, fallback.New("v1-images-key-scope")
	}
	if u.IsModerator {
		return ImagesViewer{}, fallback.New("v1-images-key-scoped-moderator")
	}
	return ImagesViewer{User: u}, nil
}
