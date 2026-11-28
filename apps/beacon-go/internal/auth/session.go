package auth

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/hydrate"
)

// SessionUser is the part of the hydrated session user the beacons read, plus where the session
// came from (the verified claims and the cookie that carried them), which the rolling-refresh check
// needs.
type SessionUser struct {
	ID          int
	Username    string
	IsModerator bool
	Banned      bool
	// Memorialized is `memorialized === true`: the account's holder has died (refusesMemorializedSession).
	Memorialized bool
	// Tier is `session.user.tier` when it is a string; TierSet is false when the cached user has no
	// tier or a null one (the page-view row then carries the literal 'undefined').
	Tier    string
	TierSet bool

	Claims *Claims
	// CookieName is the cookie the session token was read from.
	CookieName string
}

// Resolver turns a request into a viewer. It is deliberately narrow: any credential shape it does not
// handle exactly as the main app does (bearer/API keys, an uncached session user) is a fallback, never a
// guess. Session cookies are read as getHubSession reads them (readSessionToken in
// packages/civitai-auth/src/cookies.ts): see Resolve.
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
// The session token is the value of the first name in CookieNames(req.Host) that the request carries
// with a non-empty value, as readSessionToken does: presence alone picks the cookie, its validity is
// never consulted. When that token does not verify, is revoked, or names the moderation account, the
// request is signed out; the other slot's cookie is not tried, as getHubSession does not try it.
func (r *Resolver) Resolve(ctx context.Context, req *http.Request) (*SessionUser, error) {
	if req.Header.Get("Authorization") != "" || req.URL.Query().Get("token") != "" {
		// API keys and OAuth tokens carry scopes and a different moderator rule (moderatorView).
		return nil, fallback.New("bearer-token")
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
	if errors.Is(err, ErrNoKeys) {
		// No key set to verify with (cold start, or dropped as stale): the token may well be valid, and
		// writing the request as signed out would record a wrong userId. Node verifies it instead.
		return nil, fallback.New("jwks-unavailable")
	}
	if err != nil {
		return nil, nil // not a valid session: signed out, as getHubSession treats it
	}
	// session-verifier.ts isRevoked: the moderation account's token is revoked by its sub alone.
	if IsModerationAccount(claims.UserID(), "", r.ModerationAccountID) {
		return nil, nil
	}
	if r.Revocation != nil {
		revoked, err := r.Revocation.IsRevoked(ctx, claims)
		if err != nil {
			return nil, fallback.Newf("revocation-unavailable", "%v", err)
		}
		if revoked {
			return nil, nil
		}
	}
	u, err := r.user(ctx, claims.UserID())
	if err != nil {
		return nil, err
	}
	// getHubSession: refused by the resolved user's id or username.
	if IsModerationAccount(u.ID, u.Username, r.ModerationAccountID) {
		return nil, nil
	}
	// refusesMemorializedSession: a moderator's impersonation of a memorialized account still resolves.
	if u.Memorialized && claims.ImpersonatedBy == nil {
		return nil, nil
	}
	if r.OnSlot != nil {
		r.OnSlot(CookieSlot(tokenCookie))
	}
	u.Claims, u.CookieName = claims, tokenCookie
	return u, nil
}

func (r *Resolver) user(ctx context.Context, id int) (*SessionUser, error) {
	timeout := r.SessionReadTimeout
	if timeout == 0 {
		timeout = 400 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	e, ok := r.Sessions.Session(ctx, id)
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
	v, ok := m["id"]
	if !ok {
		// The Node Tracker stamps `session.user.id ?? 0`: a cached user without an id writes userId 0,
		// which is not something to reproduce by guessing.
		return nil, fallback.New("session-no-id")
	}
	if n, ok := hydrate.Int(v); !ok || n != id {
		// Never serve one user's session data as another's.
		return nil, fallback.Newf("session-id-mismatch", "%s", strconv.Itoa(id))
	}
	u := &SessionUser{ID: id}
	u.Username, _ = m["username"].(string)
	u.IsModerator, _ = m["isModerator"].(bool)
	if b, ok := m["bannedAt"]; ok && b != nil {
		u.Banned = true
	}
	u.Memorialized, _ = m["memorialized"].(bool)
	switch t := m["tier"].(type) {
	case nil:
	case string:
		u.Tier, u.TierSet = t, true
	default:
		// `memberType` is `tier ?? 'undefined'`: a non-string tier would be written as itself.
		return nil, fallback.New("session-tier-type")
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
