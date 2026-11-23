package flipt

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

// BooleanFor sends the entity id and the context as given (Node's isFlipt(flag, entityId, context));
// Boolean is it for the global entity with an empty context.
func TestBooleanForRequest(t *testing.T) {
	f := &fakeFlipt{flags: map[string]bool{"lead-flag": true}}
	srv := f.serve(t)
	c, err := New(Config{URL: srv.URL, ClientToken: "tok-2", Environment: "env-y"})
	if err != nil {
		t.Fatal(err)
	}
	on, err := c.BooleanFor(context.Background(), "lead-flag", "4101", map[string]string{"userId": "4101", "tier": "gold"})
	if err != nil || !on {
		t.Fatalf("BooleanFor = %v, %v; want true", on, err)
	}
	if len(f.reqs) != 1 {
		t.Fatalf("%d requests, want 1", len(f.reqs))
	}
	want := map[string]any{"namespaceKey": "default", "flagKey": "lead-flag", "entityId": "4101",
		"context": map[string]any{"userId": "4101", "tier": "gold"}}
	if got := f.reqs[0]; !reflect.DeepEqual(got.body, want) || got.path != "/evaluate/v1/boolean" ||
		got.auth != "Bearer tok-2" || got.env != "env-y" {
		t.Fatalf("request %+v, want body %v", got, want)
	}
	if _, err := c.BooleanFor(context.Background(), "lead-flag", "4102", nil); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[1].body["context"]; !reflect.DeepEqual(got, map[string]any{}) {
		t.Fatalf("nil context sent as %#v, want {}", got)
	}
}

// userFlagHarness is a UserFlag over a scripted read, on a settable clock.
type userFlagHarness struct {
	f     *UserFlag
	now   time.Time
	reads []string // entity ids read, in order
	on    map[string]bool
	err   error
}

func newUserFlagHarness() *userFlagHarness {
	h := &userFlagHarness{now: time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC), on: map[string]bool{}}
	h.f = NewUserFlagFunc(func(_ context.Context, id string, _ map[string]string) (bool, error) {
		h.reads = append(h.reads, id)
		if h.err != nil {
			return false, h.err
		}
		return h.on[id], nil
	})
	h.f.TTL, h.f.Backoff = 30*time.Second, 7*time.Second
	h.f.Now = func() time.Time { return h.now }
	return h
}

func (h *userFlagHarness) enabled(t *testing.T, id string, ctx map[string]string) (bool, error) {
	t.Helper()
	return h.f.Enabled(context.Background(), id, ctx)
}

// An answer is reused for TTL per entity id and context, then read again; a changed context is a
// new read.
func TestUserFlagCachesPerViewer(t *testing.T) {
	h := newUserFlagHarness()
	h.on["4101"] = true
	ctxA := map[string]string{"userId": "4101", "tier": "free"}
	for i := 0; i < 3; i++ {
		if on, err := h.enabled(t, "4101", ctxA); !on || err != nil {
			t.Fatalf("read %d: %v, %v; want true", i, on, err)
		}
	}
	if on, err := h.enabled(t, "5202", map[string]string{"userId": "5202"}); on || err != nil {
		t.Fatalf("5202: %v, %v; want false", on, err)
	}
	if want := []string{"4101", "5202"}; !reflect.DeepEqual(h.reads, want) {
		t.Fatalf("reads %v, want %v (one per viewer)", h.reads, want)
	}
	// The flag flips; the cached answer holds until TTL.
	h.on["4101"] = false
	h.now = h.now.Add(29 * time.Second)
	if on, _ := h.enabled(t, "4101", ctxA); !on {
		t.Fatal("within TTL: the cached true was not reused")
	}
	h.now = h.now.Add(2 * time.Second)
	if on, _ := h.enabled(t, "4101", ctxA); on {
		t.Fatal("past TTL: still the old answer")
	}
	// Same viewer, another tier: its own read.
	n := len(h.reads)
	if _, err := h.enabled(t, "4101", map[string]string{"userId": "4101", "tier": "gold"}); err != nil || len(h.reads) != n+1 {
		t.Fatalf("changed context: %v, reads %d -> %d, want one more", err, n, len(h.reads))
	}
}

// A failure is returned (never read as off, never cached); for Backoff after it, an uncached viewer
// is ErrBackoff without a read, while a cached one keeps its answer; after Backoff reads resume.
func TestUserFlagFailureAndBackoff(t *testing.T) {
	h := newUserFlagHarness()
	h.on["4101"] = true
	if _, err := h.enabled(t, "4101", nil); err != nil {
		t.Fatal(err)
	}
	h.err = errors.New("flipt: lead-flag: http 503")
	if _, err := h.enabled(t, "5202", nil); err == nil || errors.Is(err, ErrBackoff) {
		t.Fatalf("failed read: %v, want the read's error", err)
	}
	reads := len(h.reads)
	h.now = h.now.Add(6 * time.Second)
	if _, err := h.enabled(t, "6303", nil); !errors.Is(err, ErrBackoff) || len(h.reads) != reads {
		t.Fatalf("within backoff: %v, reads %d -> %d; want ErrBackoff and no read", err, reads, len(h.reads))
	}
	if on, err := h.enabled(t, "4101", nil); !on || err != nil {
		t.Fatalf("cached viewer within backoff: %v, %v; want the cached true", on, err)
	}
	h.err = nil
	h.on["6303"] = true
	h.now = h.now.Add(2 * time.Second)
	if on, err := h.enabled(t, "6303", nil); !on || err != nil || len(h.reads) != reads+1 {
		t.Fatalf("after backoff: %v, %v, reads %d; want a read answering true", on, err, len(h.reads))
	}
}

// A flag Flipt does not know is an error (ErrFlagNotFound), not off: the caller fails closed.
func TestUserFlagNotFoundIsAnError(t *testing.T) {
	f := &fakeFlipt{flags: map[string]bool{}}
	srv := f.serve(t)
	c, err := New(Config{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if on, err := NewUserFlag(c, "missing-flag").Enabled(context.Background(), "4101", nil); on || !errors.Is(err, ErrFlagNotFound) {
		t.Fatalf("unknown flag: %v, %v; want ErrFlagNotFound", on, err)
	}
	f.setCode(http.StatusInternalServerError)
	if _, err := NewUserFlag(c, "missing-flag").Enabled(context.Background(), "4101", nil); err == nil {
		t.Fatal("a 500 answered without an error")
	}
}

// The cache never holds more than MaxEntries: expired entries go first, else all of them.
func TestUserFlagBounded(t *testing.T) {
	h := newUserFlagHarness()
	h.f.MaxEntries = 3
	for _, id := range []string{"11", "12", "13"} {
		_, _ = h.enabled(t, id, nil)
	}
	h.now = h.now.Add(31 * time.Second) // all three expired
	_, _ = h.enabled(t, "14", nil)
	if n := len(h.f.entries); n != 1 {
		t.Fatalf("after expiry: %d entries, want 1", n)
	}
	_, _ = h.enabled(t, "15", nil)
	_, _ = h.enabled(t, "16", nil)
	_, _ = h.enabled(t, "17", nil) // full, none expired: cleared, then 17
	if n := len(h.f.entries); n != 1 {
		t.Fatalf("full of live entries: %d entries, want 1", n)
	}
}

// UserContext is buildFliptContext(user): `tier ?? 'free'`, isMember only for a non-empty tier that
// is not free, every boolean as "true"/"false", deploymentId only when set.
func TestUserContext(t *testing.T) {
	gold, empty, free := "gold", "", "free"
	for _, c := range []struct {
		name string
		u    TargetUser
		dep  string
		want map[string]string
	}{
		{"no tier", TargetUser{ID: 4101}, "", map[string]string{"userId": "4101", "isModerator": "false", "tier": "free",
			"isLoggedIn": "true", "isMember": "false", "isEarlyAdopter": "false", "appBuilderApproved": "false", "isInCreatorProgram": "false"}},
		{"every property", TargetUser{ID: 5202, IsModerator: true, Tier: &gold, IsEarlyAdopter: true, AppBuilderApproved: true, InCreatorProgram: true}, "dep-9",
			map[string]string{"userId": "5202", "isModerator": "true", "tier": "gold", "isLoggedIn": "true", "isMember": "true",
				"isEarlyAdopter": "true", "appBuilderApproved": "true", "isInCreatorProgram": "true", "deploymentId": "dep-9"}},
		{"empty tier", TargetUser{ID: 6303, Tier: &empty}, "", map[string]string{"userId": "6303", "isModerator": "false", "tier": "",
			"isLoggedIn": "true", "isMember": "false", "isEarlyAdopter": "false", "appBuilderApproved": "false", "isInCreatorProgram": "false"}},
		{"free tier", TargetUser{ID: 7404, Tier: &free}, "", map[string]string{"userId": "7404", "isModerator": "false", "tier": "free",
			"isLoggedIn": "true", "isMember": "false", "isEarlyAdopter": "false", "appBuilderApproved": "false", "isInCreatorProgram": "false"}},
	} {
		if got := UserContext(c.u, c.dep); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// A read that failed because the CALLER's context ended (cancelled, or past its deadline) is returned
// but starts no backoff: the next viewer is still asked. Control: an ordinary failure does back off.
func TestUserFlagCallerContextStartsNoBackoff(t *testing.T) {
	reads := 0
	f := NewUserFlagFunc(func(ctx context.Context, _ string, _ map[string]string) (bool, error) {
		reads++
		if err := ctx.Err(); err != nil {
			return false, err
		}
		return true, nil
	})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, cancel2 := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel2()
	for name, ctx := range map[string]context.Context{"cancelled": cancelled, "past its deadline": expired} {
		if _, err := f.Enabled(ctx, "4101", nil); err == nil || errors.Is(err, ErrBackoff) {
			t.Fatalf("%s caller: %v, want the context's error", name, err)
		}
	}
	before := reads
	if on, err := f.Enabled(context.Background(), "5202", nil); !on || err != nil || reads != before+1 {
		t.Fatalf("next viewer: %v, %v, reads %d -> %d; want a read answering true (no backoff)", on, err, before, reads)
	}
	// Control: the same flag after a failure the caller did not cause backs off.
	g := NewUserFlagFunc(func(context.Context, string, map[string]string) (bool, error) {
		return false, errors.New("flipt: lead-flag: http 502")
	})
	_, _ = g.Enabled(context.Background(), "6303", nil)
	if _, err := g.Enabled(context.Background(), "7404", nil); !errors.Is(err, ErrBackoff) {
		t.Fatalf("control: %v, want ErrBackoff", err)
	}
}

// The client's own per-read timeout (Config.Timeout) is a Flipt failure, not the caller's: it backs
// off, and the next viewer within Backoff is answered without a request.
func TestUserFlagClientTimeoutBacksOff(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	t.Cleanup(srv.Close)
	c, err := New(Config{URL: srv.URL, Timeout: 30 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	f := NewUserFlag(c, "lead-flag")
	if _, err := f.Enabled(context.Background(), "4101", nil); err == nil || errors.Is(err, ErrBackoff) {
		t.Fatalf("slow server: %v, want the timeout", err)
	}
	if _, err := f.Enabled(context.Background(), "5202", nil); !errors.Is(err, ErrBackoff) {
		t.Fatalf("next viewer after the timeout: %v, want ErrBackoff", err)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("server asked %d times, want 1", n)
	}
}
