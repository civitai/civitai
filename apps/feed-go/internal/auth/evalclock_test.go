package auth

import (
	"context"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
)

// FEED_GO_EVAL_NOW reaches a session token's times: with no Now of its own, a Verifier reads exp
// against clock.Now, so a token minted for 2030 verifies at a frozen instant inside its hour and is
// expired at one past it (the wall clock is years before both).
func TestEvalClockReachesTokenExpiry(t *testing.T) {
	t.Cleanup(clock.Reset)
	minted := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	k := newKey(t, "k1")
	var fetches int32
	srv := jwksServer(t, &fetches, k)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL}
	token := sign(t, k, "ES256", baseClaims(minted))

	clock.Freeze(minted.Add(time.Minute))
	if c, err := v.Verify(context.Background(), token); err != nil || c.UserID() != 42 {
		t.Fatalf("inside the token's hour: %+v, %v; want user 42", c, err)
	}
	clock.Freeze(minted.Add(2 * time.Hour))
	if _, err := v.Verify(context.Background(), token); err == nil {
		t.Fatal("past exp: verified, want ErrInvalid")
	}
}
