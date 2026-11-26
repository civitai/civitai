package auth

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// WithResolveObserver sees every Resolve's answer, whichever way it was reached: a recorded answer
// (WithResolved), a request with no credential (signed out), and an API credential the resolver
// cannot decide (the bearer-token fallback). Without an observer, Resolve answers the same.
func TestResolveObserver(t *testing.T) {
	r := &Resolver{}
	plain, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	keyed, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	keyed.Header.Set("Authorization", "Bearer k")
	user := &SessionUser{ID: 7, Username: "u"}
	for _, c := range []struct {
		name     string
		ctx      context.Context
		req      *http.Request
		wantUser *SessionUser
		wantFB   string
	}{
		{"recorded", WithResolved(context.Background(), user, nil), plain, user, ""},
		{"signed out", context.Background(), plain, nil, ""},
		{"api key undecided", context.Background(), keyed, nil, "bearer-token"},
	} {
		t.Run(c.name, func(t *testing.T) {
			calls := 0
			var seenUser *SessionUser
			var seenErr error
			ctx := WithResolveObserver(c.ctx, func(u *SessionUser, err error) { calls++; seenUser, seenErr = u, err })
			u, err := r.Resolve(ctx, c.req)
			if calls != 1 || seenUser != u || !errors.Is(seenErr, err) {
				t.Fatalf("observer called %d times with (%v, %v), Resolve returned (%v, %v)", calls, seenUser, seenErr, u, err)
			}
			if u != c.wantUser || fallback.Reason(err) != c.wantFB {
				t.Errorf("Resolve = (%v, %v), want (%v, fallback %q)", u, err, c.wantUser, c.wantFB)
			}
			u2, err2 := r.Resolve(c.ctx, c.req)
			if u2 != u || fallback.Reason(err2) != fallback.Reason(err) {
				t.Errorf("without the observer: (%v, %v), with it (%v, %v)", u2, err2, u, err)
			}
		})
	}
}
