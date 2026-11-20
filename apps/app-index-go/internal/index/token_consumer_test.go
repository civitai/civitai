package index

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// fakeTokens is a TokenSource: the n-th token handed out after n invalidations, failing the next
// `fails` calls first.
type fakeTokens struct {
	mu          sync.Mutex
	fails       int
	calls       int
	invalidated int
}

func (f *fakeTokens) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fails > 0 {
		f.fails--
		return "", errors.New("token endpoint answered HTTP 503 (error none)")
	}
	return []string{"tok-a1", "tok-b2", "tok-c3"}[min(f.invalidated, 2)], nil
}

func (f *fakeTokens) Invalidate() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invalidated++
}

func (f *fakeTokens) snapshot() (calls, invalidated int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, f.invalidated
}

// servingAt brings a fresh consumer to a serving generation whose stored cursor is p7, an app
// indexed, and returns the open subscription.
func servingAt(t *testing.T, h *harness) *fakeConn {
	t.Helper()
	h.start(t, LayoutVersion)
	c := h.reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.live(t, "L1")
	c.progress(t, "p7")
	h.cursorIs(t, store.StateServing, "p7")
	return c
}

// Invariant: with no client configured (no token source, no static token) a subscription carries
// no Authorization header at all.
func TestNoClientSendsNoAuthorization(t *testing.T) {
	reg := newFakeRegistry(t)
	h := newHarness(t, store.NewMemory(), reg)
	c := servingAt(t, h)
	if c.auth != "" {
		t.Fatalf("Authorization = %q, want none", c.auth)
	}
	c.drop()
	if c = reg.next(t); c.auth != "" {
		t.Fatalf("reconnect Authorization = %q, want none", c.auth)
	}
}

// Every subscription, the first and each reconnect, carries the source's token.
func TestTokenSentOnEverySubscription(t *testing.T) {
	reg := newFakeRegistry(t)
	h := newHarness(t, store.NewMemory(), reg)
	h.tokens = &fakeTokens{}
	c := servingAt(t, h)
	if c.auth != "Bearer tok-a1" {
		t.Fatalf("Authorization = %q, want Bearer tok-a1", c.auth)
	}
	c.drop()
	if c = reg.next(t); c.auth != "Bearer tok-a1" || c.cursor != "p7" {
		t.Fatalf("reconnect auth %q cursor %q, want Bearer tok-a1 and p7", c.auth, c.cursor)
	}
}

// invalid_token mid-stream (the token expired): the token is dropped, a new one fetched, and the
// subscription resumes from the stored cursor, never an empty one, after the ordinary backoff.
func TestInvalidTokenRefreshesAndResumesFromStoredCursor(t *testing.T) {
	reg := newFakeRegistry(t)
	h := newHarness(t, store.NewMemory(), reg)
	tokens := &fakeTokens{}
	h.tokens = tokens
	c := servingAt(t, h)
	c.errorEvent(t, "invalid_token")
	c = reg.next(t)
	if c.cursor != "p7" {
		t.Fatalf("resumed from cursor %q, want p7 (the stored cursor)", c.cursor)
	}
	if c.auth != "Bearer tok-b2" {
		t.Fatalf("Authorization = %q, want the new token Bearer tok-b2", c.auth)
	}
	if _, inv := tokens.snapshot(); inv != 1 {
		t.Fatalf("invalidated %d times, want 1", inv)
	}
	// The stream had reached Live: the first backoff step, not the longest.
	if got := h.waitDelays(); !slices.Equal(got, []time.Duration{75 * time.Millisecond}) {
		t.Fatalf("delays = %v, want [75ms]", got)
	}
	if got := h.counter(h.m.Reconnects, "auth"); got != 1 {
		t.Fatalf("auth reconnects = %v, want 1", got)
	}
	// Still the same generation: no rebuild.
	if got := h.counter(h.m.Rebuilds, "first_start"); got != 1 {
		t.Fatalf("first_start rebuilds = %v, want 1", got)
	}
	// A registry that keeps refusing new tokens is backed off further each time.
	c.fail(http.StatusUnauthorized, "invalid_token")
	c = reg.next(t)
	c.fail(http.StatusUnauthorized, "invalid_token")
	c = reg.next(t)
	if c.cursor != "p7" {
		t.Fatalf("cursor %q after repeated refusals, want p7", c.cursor)
	}
	ms := time.Millisecond
	if got := h.waitDelays(); !slices.Equal(got, []time.Duration{75 * ms, 150 * ms, 300 * ms}) {
		t.Fatalf("delays = %v, want [75ms 150ms 300ms]", got)
	}
}

// A token that cannot be fetched opens no subscription and is retried with a growing backoff;
// the stored cursor is kept and no generation is rebuilt.
func TestTokenFetchFailureBacksOffWithoutCursorReset(t *testing.T) {
	reg := newFakeRegistry(t)
	h := newHarness(t, store.NewMemory(), reg)
	tokens := &fakeTokens{}
	h.tokens = tokens
	c := servingAt(t, h)
	tokens.mu.Lock()
	tokens.fails = 3
	tokens.mu.Unlock()
	c.drop()
	c = reg.next(t)
	if c.cursor != "p7" {
		t.Fatalf("subscribed with cursor %q after the token came back, want p7", c.cursor)
	}
	if c.auth != "Bearer tok-a1" {
		t.Fatalf("Authorization = %q", c.auth)
	}
	ms := time.Millisecond
	// The drop after Live waits the first step; each failed fetch the next one up.
	if got := h.waitDelays(); !slices.Equal(got, []time.Duration{75 * ms, 150 * ms, 300 * ms, 600 * ms}) {
		t.Fatalf("delays = %v, want [75ms 150ms 300ms 600ms]", got)
	}
	if got := h.counter(h.m.Reconnects, "token"); got != 3 {
		t.Fatalf("token reconnects = %v, want 3", got)
	}
	if got := h.counter(h.m.Rebuilds, "first_start"); got != 1 {
		t.Fatalf("first_start rebuilds = %v, want 1", got)
	}
	st := h.state(t)
	if st.Serving == nil || st.Serving.Cursor != "p7" || st.Building != nil {
		t.Fatalf("state %+v, want serving at p7 and nothing building", st)
	}
}
