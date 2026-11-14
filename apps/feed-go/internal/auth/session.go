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
}

// Resolver turns a request into a viewer. It is deliberately narrow: any credential shape it does not
// handle exactly as the main app does (bearer/API keys, two session cookies at once, an uncached session
// user) is a fallback, never a guess.
type Resolver struct {
	Verifier   *Verifier
	Revocation *Revocation
	// Sessions reads `session:data2:<userId>` on the cache cluster (session-client.ts).
	Sessions *hydrate.PackedReader
	// CookieNames are the session cookie names to look for (e.g. `__Secure-civ-token`, `__Host-civ-token`).
	CookieNames []string
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
func (r *Resolver) Resolve(ctx context.Context, req *http.Request) (*SessionUser, error) {
	if req.Header.Get("Authorization") != "" || req.URL.Query().Get("token") != "" {
		// API keys and OAuth tokens carry scopes and a different moderator rule (moderatorView).
		return nil, fallback.New("bearer-token")
	}
	cookie := req.Header.Get("Cookie")
	var token string
	found := 0
	for _, name := range r.CookieNames {
		if t := TokenFromCookieHeader(cookie, name); t != "" {
			found++
			token = t
		}
	}
	if found > 1 {
		return nil, fallback.New("multiple-session-cookies")
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
	u := &SessionUser{ID: id}
	u.Username, _ = m["username"].(string)
	u.IsModerator, _ = m["isModerator"].(bool)
	if b, ok := m["bannedAt"]; ok && b != nil {
		u.Banned = true
	}
	return u, nil
}
