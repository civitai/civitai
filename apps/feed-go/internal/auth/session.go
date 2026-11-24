package auth

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// SessionUser is the part of the hydrated session user this procedure reads.
type SessionUser struct {
	ID          int
	Username    string
	IsModerator bool
	Banned      bool
	// APIKey is set when the viewer came from an API key rather than a session cookie: the app then
	// accepts the request whatever its Origin (createContext's isBearerAuth).
	APIKey bool
	// The Flipt targeting properties buildFliptContext reads off the session user (flipt.TargetUser):
	// Tier is `tier` (nil when absent or not a string), IsEarlyAdopter and AppBuilderApproved are
	// `isEarlyAdopter` / `appBuilderApproved` (true only when the boolean true), Onboarding is
	// `onboarding` (0 when absent, a string, or not an integer).
	Tier               *string
	IsEarlyAdopter     bool
	AppBuilderApproved bool
	Onboarding         int

	// raw is the cached session entry, for the bearer checks that read more of it.
	raw map[string]any
}

// Resolver turns a request into a viewer. It is deliberately narrow: any credential shape it does not
// handle exactly as the main app does (an API key it cannot decide, an uncached session user) is a
// fallback, never a guess. Session cookies are read as getHubSession reads them (readSessionToken in
// packages/civitai-auth/src/cookies.ts), API keys as getSessionFromBearerToken does (bearer.go): see
// Resolve.
type Resolver struct {
	Verifier   *Verifier
	Revocation *Revocation
	// Sessions reads `session:data2:<userId>` on the cache cluster (session-client.ts).
	Sessions *hydrate.PackedReader
	// CookieNames gives the session cookie names to look for on a request to a host, in the order the
	// main app reads them (e.g. `__Host-civ-token` then `__Secure-civ-token` in host mode): a site's
	// cookie mode picks them. Resolve reads the first one present.
	CookieNames func(host string) []string
	// OnSlot, when set, is told the cookie slot ("host" | "shared", see CookieSlot) of each session it resolves.
	OnSlot func(slot string)
	// SessionReadTimeout bounds the session-cache read (400ms in session-client.ts).
	SessionReadTimeout time.Duration
	// ModerationAccountID is CIVITAI_MODERATION_USER_ID (0 = unset): the shared moderation account,
	// which nobody signs in as. See IsModerationAccount.
	ModerationAccountID int
	// APIKeys resolves API keys (FEED_GO_BEARER_AUTH); nil keeps every API credential a `bearer-token`
	// fallback.
	APIKeys *APIKeys
}

// ModerationAccountUsername is MODERATION_ACCOUNT_USERNAME (packages/civitai-auth).
const ModerationAccountUsername = "CivitaiModeration"

// IsModerationAccount is isModerationAccountUser (packages/civitai-auth/src/moderation-account.ts):
// true for the shared moderation account, by its configured id (when configuredID > 0) or by its
// username in any casing, so a missing id still refuses it. The app's getHubSession refuses a session
// for that account (refuseModerationAccountSession): signed out.
func IsModerationAccount(id int, username string, configuredID int) bool {
	if configuredID > 0 && id == configuredID {
		return true
	}
	return strings.EqualFold(username, ModerationAccountUsername)
}

// Resolve returns the viewer, or nil when signed out. A non-nil error is always a fallback.
//
// An API credential is read first, as resolveSession does: when the request carries one
// (readRequestBearerToken), its answer is the request's, signed out included, and the cookies are never
// read. See resolveBearer.
//
// Otherwise the session token is the value of the first name in CookieNames(req.Host) that the request
// carries with a non-empty value, as readSessionToken does: presence alone picks the cookie, its
// validity is never consulted. When that token does not verify, is revoked, or names the moderation
// account, the request is signed out; the other slot's cookie is not tried, as getHubSession does not
// try it.
func (r *Resolver) Resolve(ctx context.Context, req *http.Request) (*SessionUser, error) {
	if m, ok := ctx.Value(resolvedKey{}).(*resolved); ok {
		return m.user, m.err
	}
	if r.APIKeys == nil || credentialsRedacted(ctx) {
		if HasAPICredential(req) {
			return nil, fallback.New("bearer-token")
		}
	} else {
		key, present, err := bearerToken(req)
		if err != nil {
			return nil, err
		}
		if present {
			return r.resolveBearer(ctx, key)
		}
	}
	// Several Cookie header lines are joined with "; ", as Node's http server joins them (and Next's
	// cookie parser joins an array), so a cookie on a later line is seen.
	cookie := strings.Join(req.Header.Values("Cookie"), "; ")
	var token, tokenCookie string
	var names []string
	if r.CookieNames != nil {
		names = r.CookieNames(req.Host)
	}
	for _, name := range names {
		if t := TokenFromCookieHeader(cookie, name); t != "" {
			token, tokenCookie = t, name
			break
		}
	}
	if token == "" {
		return nil, nil
	}
	claims, err := r.Verifier.Verify(ctx, token)
	if err != nil {
		return nil, nil // not a valid session: signed out, as getHubSession treats it
	}
	// session-verifier.ts isRevoked: the moderation account's token is revoked by its sub alone.
	if IsModerationAccount(claims.UserID(), "", r.ModerationAccountID) {
		return nil, nil
	}
	if r.Revocation != nil && r.Revocation.IsRevoked(ctx, claims) {
		return nil, nil
	}
	u, err := r.user(ctx, claims.UserID())
	if err != nil {
		return nil, err
	}
	// getHubSession: refused by the resolved user's id or username.
	if IsModerationAccount(u.ID, u.Username, r.ModerationAccountID) {
		return nil, nil
	}
	if r.OnSlot != nil {
		r.OnSlot(CookieSlot(tokenCookie))
	}
	return u, nil
}

func (r *Resolver) user(ctx context.Context, id int) (*SessionUser, error) {
	timeout := r.SessionReadTimeout
	if timeout == 0 {
		timeout = 400 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	got := r.Sessions.Get(ctx, "session:data2", []int{id}, 0)
	e, ok := got[id]
	if !ok || e.NotFound {
		// The Node path fetches the user from the auth hub here; not ported.
		return nil, fallback.New("session-cache-miss")
	}
	return SessionUserFrom(id, e.Value)
}

// SessionUserFrom reads a cached session user. An entry carrying `clearedAt` is a cleared session the
// Node path ignores (and refetches): a fallback here.
func SessionUserFrom(id int, m map[string]any) (*SessionUser, error) {
	if _, cleared := m["clearedAt"]; cleared {
		return nil, fallback.New("session-cache-cleared")
	}
	if v, ok := m["id"]; ok {
		if n, ok := hydrate.Int(v); !ok || n != id {
			// Never serve one user's session data as another's.
			return nil, fallback.Newf("session-id-mismatch", "%s", strconv.Itoa(id))
		}
	}
	u := &SessionUser{ID: id, raw: m}
	u.Username, _ = m["username"].(string)
	u.IsModerator, _ = m["isModerator"].(bool)
	if t, ok := m["tier"].(string); ok {
		u.Tier = &t
	}
	u.IsEarlyAdopter, _ = m["isEarlyAdopter"].(bool)
	u.AppBuilderApproved, _ = m["appBuilderApproved"].(bool)
	// A number only: hydrate.Int also reads a numeric string, which Node's bitwise test never matches.
	if v, ok := m["onboarding"]; ok {
		if _, isStr := v.(string); !isStr {
			u.Onboarding, _ = hydrate.Int(v)
		}
	}
	if b, ok := m["bannedAt"]; ok && b != nil {
		u.Banned = true
	}
	return u, nil
}

// FixedCookieNames is a CookieNames that gives the same names for every host.
func FixedCookieNames(names ...string) func(string) []string {
	return func(string) []string { return names }
}

// CookieSlot is the slot a session cookie name belongs to: "host" for the host-only `__Host-` name, else
// "shared". Without the secure prefixes (dev) both slots share one name, which counts as "shared".
func CookieSlot(name string) string {
	if strings.HasPrefix(name, "__Host-") {
		return "host"
	}
	return "shared"
}
