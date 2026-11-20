package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The session cookie names config.CookieNames gives, in order, per mode (pinned in
// config.TestCookieNamesPerMode).
var (
	hostMode         = []string{"__Host-civ-token", "__Secure-civ-token"} // host, legacy read on
	sharedMode       = []string{"__Secure-civ-token", "__Host-civ-token"} // shared, legacy read on
	hostModeNoLegacy = []string{"__Host-civ-token"}                       // host (or shared) with the legacy read off, or a site listed host
)

// TestResolveReadsSessionCookiesInNodesOrder mirrors readSessionToken (packages/civitai-auth/src/cookies.ts,
// pinned by its host-cookie-read.test.ts) followed by getHubSession (src/server/auth/session-client.ts):
// the first slot of the mode's order the request carries wins on presence alone; a token in that slot
// that does not verify, is revoked or is the moderation account signs the request out, and the other
// slot is never tried. Before this change every "both" row fell back with multiple-session-cookies.
func TestResolveReadsSessionCookiesInNodesOrder(t *testing.T) {
	f := newResolveFixture(t)
	f.r.ModerationAccountID = 9131
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a", "isModerator": true})
	f.session(t, 45, map[string]any{"id": 45, "username": "viewer-c"})
	f.session(t, 46, map[string]any{"id": 46, "username": "civitaimoderation"})
	a := f.token(t, nil) // user 42
	c := f.token(t, func(m map[string]any) { m["sub"] = "45"; m["jti"] = "tok-45" })
	expired := f.token(t, func(m map[string]any) { m["exp"] = f.now.Add(-time.Minute).Unix() })
	revoked := f.token(t, func(m map[string]any) { m["sub"] = "45"; m["jti"] = "tok-revoked" })
	modByID := f.token(t, func(m map[string]any) { m["sub"] = "9131"; m["jti"] = "tok-9131" })
	modByName := f.token(t, func(m map[string]any) { m["sub"] = "46"; m["jti"] = "tok-46" })
	f.sys.SetHash("session:token-state", map[string]string{"tok-revoked": "invalid"})
	const garbage = "not.a.token"

	H := func(v string) string { return "__Host-civ-token=" + v }
	S := func(v string) string { return "__Secure-civ-token=" + v }
	both := func(h, s string) []string { return []string{S(s) + "; " + H(h)} }

	type want struct {
		id     int    // 0 = signed out
		slot   string // the slot OnSlot is told; "" when signed out
		reason string // a fallback reason; "" = none
	}
	cases := []struct {
		name    string
		names   []string
		cookies []string // one Cookie header line each
		want    want
	}{
		// host mode, legacy read on
		{"host: neither", hostMode, nil, want{}},
		{"host: host only", hostMode, []string{H(a)}, want{id: 42, slot: "host"}},
		{"host: shared only", hostMode, []string{S(c)}, want{id: 45, slot: "shared"}},
		{"host: both valid, same user", hostMode, both(a, a), want{id: 42, slot: "host"}},
		{"host: both valid, different users", hostMode, both(a, c), want{id: 42, slot: "host"}},
		{"host: both valid, different users, host listed second", hostMode, []string{H(c) + "; " + S(a)}, want{id: 45, slot: "host"}},
		{"host: host garbage, shared valid", hostMode, both(garbage, c), want{}},
		{"host: host expired, shared valid", hostMode, both(expired, c), want{}},
		{"host: host revoked, shared valid", hostMode, both(revoked, a), want{}},
		{"host: host moderation account by id, shared valid", hostMode, both(modByID, c), want{}},
		{"host: host moderation account by username, shared valid", hostMode, both(modByName, c), want{}},
		{"host: host valid, shared garbage", hostMode, both(a, garbage), want{id: 42, slot: "host"}},
		{"host: host valid, shared revoked", hostMode, both(a, revoked), want{id: 42, slot: "host"}},
		{"host: host empty, shared valid", hostMode, both("", c), want{id: 45, slot: "shared"}},
		{"host: host quoted empty, shared valid", hostMode, both(`""`, c), want{id: 45, slot: "shared"}},
		{"host: shared only, revoked", hostMode, []string{S(revoked)}, want{}},
		{"host: shared only, moderation account", hostMode, []string{S(modByID)}, want{}},

		// shared mode, legacy read on
		{"shared: neither", sharedMode, []string{"other=1"}, want{}},
		{"shared: host only", sharedMode, []string{H(a)}, want{id: 42, slot: "host"}},
		{"shared: shared only", sharedMode, []string{S(c)}, want{id: 45, slot: "shared"}},
		{"shared: both valid, same user", sharedMode, both(a, a), want{id: 42, slot: "shared"}},
		{"shared: both valid, different users", sharedMode, both(a, c), want{id: 45, slot: "shared"}},
		{"shared: shared garbage, host valid", sharedMode, both(a, garbage), want{}},
		{"shared: shared revoked, host valid", sharedMode, both(a, revoked), want{}},
		{"shared: shared moderation account, host valid", sharedMode, both(a, modByName), want{}},
		{"shared: shared valid, host garbage", sharedMode, both(garbage, c), want{id: 45, slot: "shared"}},

		// legacy read off (or a site listed host): the shared slot is never read
		{"no legacy: shared only", hostModeNoLegacy, []string{S(c)}, want{}},
		{"no legacy: both valid, different users", hostModeNoLegacy, both(a, c), want{id: 42, slot: "host"}},
		{"no legacy: host garbage, shared valid", hostModeNoLegacy, both(garbage, c), want{}},

		// the Cookie header as the cookie package's parse() reads it
		{"duplicate name: the first wins", hostMode, []string{H(a) + "; " + H(c)}, want{id: 42, slot: "host"}},
		{"duplicate name: an empty first still wins, so the slot is absent", hostMode, []string{H("") + "; " + H(c) + "; " + S(a)}, want{id: 42, slot: "shared"}},
		{"quoted value", sharedMode, []string{S(`"` + c + `"`)}, want{id: 45, slot: "shared"}},
		{"two Cookie header lines are joined", hostMode, []string{S(c), H(a)}, want{id: 42, slot: "host"}},

		// dev (http): one bare name
		{"dev: bare name", []string{"civ-token"}, []string{"civ-token=" + a}, want{id: 42, slot: "shared"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var slots []string
			f.r.CookieNames = FixedCookieNames(tc.names...)
			f.r.OnSlot = func(slot string) { slots = append(slots, slot) }
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
			for _, line := range tc.cookies {
				req.Header.Add("Cookie", line)
			}
			u, err := f.r.Resolve(context.Background(), req)
			reason := fallback.Reason(err)
			if err != nil && reason == "" {
				t.Fatalf("non-fallback error %v", err)
			}
			if reason != tc.want.reason {
				t.Fatalf("fallback %q, want %q", reason, tc.want.reason)
			}
			gotID := 0
			if u != nil {
				gotID = u.ID
			}
			if gotID != tc.want.id {
				t.Fatalf("user %d, want %d (0 = signed out)", gotID, tc.want.id)
			}
			if got := strings.Join(slots, ","); got != tc.want.slot {
				t.Fatalf("OnSlot %q, want %q", got, tc.want.slot)
			}
		})
	}
	if len(f.reports) != 0 {
		t.Fatalf("revocation failed open %d times on a healthy store: %v", len(f.reports), f.reports)
	}
}
