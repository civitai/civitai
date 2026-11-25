package token

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// TokenExpiring answers the token and its expiry: the hub's expires_in from when it was fetched, so a
// stream opened with it can close before it runs out; a failure answers no token. Fails on the
// app-index-go original: there is no TokenExpiring (the test does not compile).
func TestTokenExpiringAnswersTheExpiry(t *testing.T) {
	h := newHub(t)
	s, now := source(h, Config{})
	tok, expires, err := s.TokenExpiring(context.Background())
	if err != nil || tok != "jwt-1" || !expires.Equal(now.Add(900*time.Second)) {
		t.Fatalf("%q %v %v; want jwt-1 at %v", tok, expires, err, now.Add(900*time.Second))
	}
	s.Invalidate()
	h.mu.Lock()
	h.status = http.StatusUnauthorized
	h.mu.Unlock()
	if tok, expires, err := s.TokenExpiring(context.Background()); err == nil || tok != "" || !expires.IsZero() {
		t.Fatalf("a failed fetch: %q %v %v", tok, expires, err)
	}
}
