package index

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// scenarios run against every store: the Memory fake here, Postgres in the integration tier.
func runScenarios(t *testing.T, newStore func(t *testing.T) store.Store) {
	t.Run("SnapshotThenLive", func(t *testing.T) { testSnapshotThenLive(t, newStore(t)) })
	t.Run("ResumeFromStoredCursor", func(t *testing.T) { testResumeFromStoredCursor(t, newStore(t)) })
	t.Run("CrashMidSnapshotStartsOver", func(t *testing.T) { testCrashMidSnapshotStartsOver(t, newStore(t)) })
	t.Run("End", func(t *testing.T) { testEnd(t, newStore(t)) })
	t.Run("CursorExpiredRebuildsBeside", func(t *testing.T) { testCursorExpiredRebuildsBeside(t, newStore(t)) })
	t.Run("CursorExpiredDuringBuild", func(t *testing.T) { testCursorExpiredDuringBuild(t, newStore(t)) })
	t.Run("LayoutBumpRebuildsBeside", func(t *testing.T) { testLayoutBumpRebuildsBeside(t, newStore(t)) })
	t.Run("ReconnectBackoff", func(t *testing.T) { testReconnectBackoff(t, newStore(t)) })
	t.Run("InvalidBodyIsDeleted", func(t *testing.T) { testInvalidBodyIsDeleted(t, newStore(t)) })
}

func TestScenariosMemory(t *testing.T) {
	runScenarios(t, func(*testing.T) store.Store { return store.NewMemory() })
}

// The index answers nothing until the first Live: /readyz and /search are 503 while the snapshot
// streams in, then serve exactly the snapshot.
func testSnapshotThenLive(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	if c.cursor != "" {
		t.Fatalf("first start subscribed with cursor %q, want none", c.cursor)
	}
	c.upsert(t, "alpha", "Alpha", "")
	c.upsert(t, "beta", "Beta", "")
	c.upsert(t, "gamma", "Gamma", "")
	c.progress(t, "") // a registry may send an empty cursor anywhere before Live
	eventually(t, "the snapshot to be applied", func() bool {
		return testutil.ToFloat64(h.m.Applied.WithLabelValues("upsert")) == 3 &&
			testutil.ToFloat64(h.m.Applied.WithLabelValues("progress")) == 1
	})
	if code := h.readyz(t); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz before Live = %d, want 503", code)
	}
	if code, _ := h.search(t, "q=alpha"); code != http.StatusServiceUnavailable {
		t.Fatalf("search before Live = %d, want 503", code)
	}
	if v := testutil.ToFloat64(h.m.Ready); v != 0 {
		t.Fatalf("ready gauge before Live = %v", v)
	}
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	if code := h.readyz(t); code != http.StatusOK {
		t.Fatalf("readyz after Live = %d, want 200", code)
	}
	if code, names := h.search(t, "sort=name"); code != http.StatusOK || !slices.Equal(names, []string{"Alpha", "Beta", "Gamma"}) {
		t.Fatalf("search after Live = %d %v", code, names)
	}
	if testutil.ToFloat64(h.m.Ready) != 1 || testutil.ToFloat64(h.m.Generation) == 0 {
		t.Fatal("ready / generation gauges not set at Live")
	}
	if got := h.counter(h.m.Rebuilds, "first_start"); got != 1 {
		t.Fatalf("first_start rebuilds = %v", got)
	}
}

// A restart resumes from the stored cursor: only the changes after it arrive, none is applied
// twice and none is missed.
func testResumeFromStoredCursor(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.upsert(t, "beta", "Beta", "")
	c.live(t, "L1")
	c.upsert(t, "gamma", "Gamma", "c2")
	c.del(t, "alpha", "c3")
	h.cursorIs(t, store.StateServing, "c3")
	h.stop() // the process stops; the registry keeps its history

	h.start(t, LayoutVersion)
	c = reg.next(t)
	if c.cursor != "c3" {
		t.Fatalf("restart subscribed with cursor %q, want c3", c.cursor)
	}
	c.live(t, "c3")
	c.upsert(t, "beta", "Beta Two", "c4")
	c.upsert(t, "delta", "Delta", "c5")
	h.cursorIs(t, store.StateServing, "c5")
	if _, names := h.search(t, "sort=name"); !slices.Equal(names, []string{"Beta Two", "Delta", "Gamma"}) {
		t.Fatalf("after resume = %v, want [Beta Two Delta Gamma]", names)
	}

	// A dropped connection resumes the same way, without a restart.
	c.drop()
	c = reg.next(t)
	if c.cursor != "c5" {
		t.Fatalf("reconnect subscribed with cursor %q, want c5", c.cursor)
	}
	c.live(t, "c5")
	c.del(t, "delta", "c6")
	h.cursorIs(t, store.StateServing, "c6")
	if _, names := h.search(t, "sort=name"); !slices.Equal(names, []string{"Beta Two", "Gamma"}) {
		t.Fatalf("after reconnect = %v", names)
	}
}

// Snapshot upserts carry empty cursors, so a snapshot cut off before Live cannot be continued: the
// next subscription starts over from no cursor, and what the first one wrote is dropped.
func testCrashMidSnapshotStartsOver(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.upsert(t, "beta", "Beta", "")
	eventually(t, "two upserts", func() bool { return testutil.ToFloat64(h.m.Applied.WithLabelValues("upsert")) == 2 })
	h.stop()

	h.start(t, LayoutVersion)
	c = reg.next(t)
	if c.cursor != "" {
		t.Fatalf("resumed a snapshot from cursor %q", c.cursor)
	}
	c.upsert(t, "beta", "Beta", "") // alpha was deleted while the index was down
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	if _, names := h.search(t, "sort=name"); !slices.Equal(names, []string{"Beta"}) {
		t.Fatalf("after the restarted snapshot = %v, want [Beta] (alpha must not survive)", names)
	}
}

// End is logged and the subscription opened again after the longest backoff; the index keeps
// what it holds.
func testEnd(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	c.end(t)
	c = reg.next(t)
	if c.cursor != "L1" {
		t.Fatalf("after End subscribed with %q, want L1", c.cursor)
	}
	d := h.waitDelays()
	if len(d) != 1 || d[0] < h.backoff.Max/2 {
		t.Fatalf("delays after End = %v, want one of at least %v", d, h.backoff.Max/2)
	}
	if got := h.counter(h.m.Reconnects, "end"); got != 1 {
		t.Fatalf("end reconnects = %v", got)
	}
	if _, names := h.search(t, ""); !slices.Equal(names, []string{"Alpha"}) {
		t.Fatalf("index after End = %v", names)
	}
}

// cursor_expired starts a new generation from an empty cursor; the old one answers searches until
// the new one reaches Live, then the switch is atomic and the old one is gone.
func testCursorExpiredRebuildsBeside(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.upsert(t, "beta", "Beta", "")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	oldGen := h.state(t).Serving.ID
	c.drop()

	c = reg.next(t)
	if c.cursor != "L1" {
		t.Fatalf("reconnect cursor %q", c.cursor)
	}
	c.fail(http.StatusGone, "cursor_expired")

	c = reg.next(t)
	if c.cursor != "" {
		t.Fatalf("after cursor_expired subscribed with %q, want none", c.cursor)
	}
	c.upsert(t, "alpha", "Alpha Rebuilt", "")
	c.upsert(t, "gamma", "Gamma", "")
	h.cursorIs(t, store.StateBuilding, "")
	eventually(t, "rebuild upserts", func() bool { return testutil.ToFloat64(h.m.Applied.WithLabelValues("upsert")) == 4 })
	// The old generation still answers, and readiness holds.
	if code, names := h.search(t, "sort=name"); code != http.StatusOK || !slices.Equal(names, []string{"Alpha", "Beta"}) {
		t.Fatalf("during rebuild = %d %v, want the old generation [Alpha Beta]", code, names)
	}
	if code := h.readyz(t); code != http.StatusOK {
		t.Fatalf("readyz during rebuild = %d", code)
	}
	if st := h.state(t); st.Serving.ID != oldGen || st.Building == nil {
		t.Fatalf("during rebuild: serving %+v building %+v", st.Serving, st.Building)
	}
	c.live(t, "L2")
	h.cursorIs(t, store.StateServing, "L2")
	if _, names := h.search(t, "sort=name"); !slices.Equal(names, []string{"Alpha Rebuilt", "Gamma"}) {
		t.Fatalf("after switch = %v", names)
	}
	st2 := h.state(t)
	if st2.Serving.ID == oldGen || st2.Building != nil {
		t.Fatalf("after switch: serving %+v building %+v", st2.Serving, st2.Building)
	}
	// The gauge is set just after the switch commits.
	eventually(t, "the generation gauge to move to the new generation", func() bool {
		return testutil.ToFloat64(h.m.Generation) == float64(st2.Serving.ID)
	})
	if got := h.counter(h.m.Rebuilds, "cursor_expired"); got != 1 {
		t.Fatalf("cursor_expired rebuilds = %v", got)
	}
}

// cursor_expired while a generation is still building restarts that build from no cursor.
func testCursorExpiredDuringBuild(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "s1") // a registry that can continue its snapshot
	h.cursorIs(t, store.StateBuilding, "s1")
	c.errorEvent(t, "cursor_expired")
	c = reg.next(t)
	if c.cursor != "" {
		t.Fatalf("subscribed with %q, want none", c.cursor)
	}
	c.upsert(t, "beta", "Beta", "s1")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	if _, names := h.search(t, ""); !slices.Equal(names, []string{"Beta"}) {
		t.Fatalf("after restarted build = %v, want [Beta]", names)
	}
}

// A new LayoutVersion builds beside the serving generation, which keeps answering until Live.
func testLayoutBumpRebuildsBeside(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, 1)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	h.stop()

	h.start(t, 2)
	c = reg.next(t)
	if c.cursor != "" {
		t.Fatalf("layout bump subscribed with %q, want none", c.cursor)
	}
	c.upsert(t, "beta", "Beta", "")
	h.cursorIs(t, store.StateBuilding, "")
	eventually(t, "upsert", func() bool { return testutil.ToFloat64(h.m.Applied.WithLabelValues("upsert")) == 2 })
	if _, names := h.search(t, ""); !slices.Equal(names, []string{"Alpha"}) {
		t.Fatalf("during layout rebuild = %v", names)
	}
	c.live(t, "L2")
	h.cursorIs(t, store.StateServing, "L2")
	if _, names := h.search(t, ""); !slices.Equal(names, []string{"Beta"}) {
		t.Fatalf("after layout switch = %v", names)
	}
	if st := h.state(t); st.Serving.Layout != 2 {
		t.Fatalf("serving layout %d", st.Serving.Layout)
	}
	if got := h.counter(h.m.Rebuilds, "layout"); got != 1 {
		t.Fatalf("layout rebuilds = %v", got)
	}
}

// Failed subscriptions are retried with the same cursor after a doubling, capped delay; a
// subscription that reached Live resets the backoff; no reconnect is immediate.
func testReconnectBackoff(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	c.errorEvent(t, "slow_consumer")
	for range 6 {
		c = reg.next(t)
		if c.cursor != "L1" {
			t.Fatalf("reconnect with cursor %q, want L1", c.cursor)
		}
		c.fail(http.StatusServiceUnavailable, "unavailable")
	}
	c = reg.next(t)
	c.live(t, "L1")
	c.progress(t, "p2")
	h.cursorIs(t, store.StateServing, "p2")
	c.drop()
	c = reg.next(t)
	if c.cursor != "p2" {
		t.Fatalf("cursor %q, want p2", c.cursor)
	}
	// Jitter 0.5 makes each delay 3/4 of its step: steps 100, 200, 400, 800, 1600, 1600, 1600ms;
	// after the slow_consumer the stream had reached Live, so it starts at the first step, and
	// the drop after the second Live starts over at the first step again.
	ms := time.Millisecond
	want := []time.Duration{75 * ms, 150 * ms, 300 * ms, 600 * ms, 1200 * ms, 1200 * ms, 1200 * ms, 75 * ms}
	if got := h.waitDelays(); !slices.Equal(got, want) {
		t.Fatalf("delays = %v, want %v", got, want)
	}
	if got := h.counter(h.m.Reconnects, "unavailable"); got != 7 {
		t.Fatalf("unavailable reconnects = %v, want 7", got)
	}
	if got := h.counter(h.m.Reconnects, "slow_consumer"); got != 1 {
		t.Fatalf("slow_consumer reconnects = %v", got)
	}
}

// An upsert whose body the index cannot use is treated as deleted.
func testInvalidBodyIsDeleted(t *testing.T, st store.Store) {
	reg := newFakeRegistry(t)
	h := newHarness(t, st, reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.upsert(t, "beta", "Beta", "")
	c.live(t, "L1")
	c.upsertBody(t, "alpha", map[string]any{"slug": "alpha", "kind": "teleport"}, "c2")
	h.cursorIs(t, store.StateServing, "c2")
	if _, names := h.search(t, ""); !slices.Equal(names, []string{"Beta"}) {
		t.Fatalf("after invalid body = %v, want [Beta]", names)
	}
	if got := h.counter(h.m.Applied, "invalid"); got != 1 {
		t.Fatalf("invalid = %v", got)
	}
}

// bad_request and auth errors would get the same answer if retried soon: they wait the longest
// backoff, and keep the stored cursor.
func TestRefusalsWaitTheLongestBackoff(t *testing.T) {
	reg := newFakeRegistry(t)
	h := newHarness(t, store.NewMemory(), reg)
	h.start(t, LayoutVersion)
	c := reg.next(t)
	c.upsert(t, "alpha", "Alpha", "")
	c.live(t, "L1")
	h.cursorIs(t, store.StateServing, "L1")
	c.drop()
	reg.next(t).fail(http.StatusBadRequest, "bad_request")
	reg.next(t).fail(http.StatusUnauthorized, "invalid_token")
	reg.next(t).fail(http.StatusForbidden, "insufficient_scope")
	c = reg.next(t)
	if c.cursor != "L1" {
		t.Fatalf("cursor %q", c.cursor)
	}
	d := h.waitDelays()
	if len(d) != 4 || d[0] != 75*time.Millisecond {
		t.Fatalf("delays %v", d)
	}
	for _, x := range d[1:] {
		if x < h.backoff.Max/2 {
			t.Fatalf("refusal waited %v, want at least %v (delays %v)", x, h.backoff.Max/2, d)
		}
	}
	if h.counter(h.m.Reconnects, "bad_request") != 1 || h.counter(h.m.Reconnects, "auth") != 2 {
		t.Fatal("refusal reasons not counted")
	}
}

func TestBackoffDelay(t *testing.T) {
	b := Backoff{Base: 500 * time.Millisecond, Max: 60 * time.Second, Jitter: func() float64 { return 0 }}
	want := []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second}
	for i, w := range want {
		if got := b.Delay(i); got != w {
			t.Fatalf("Delay(%d) = %v, want %v", i, got, w)
		}
	}
	if got := b.Delay(maxAttempt); got != 30*time.Second {
		t.Fatalf("Delay(max) = %v, want 30s", got)
	}
	b.Jitter = func() float64 { return 0.999 }
	if got := b.Delay(maxAttempt); got >= 60*time.Second || got < 59*time.Second {
		t.Fatalf("Delay(max) with high jitter = %v", got)
	}
	b.Jitter = nil
	for i := range 40 {
		if d := b.Delay(i); d <= 0 || d > 60*time.Second {
			t.Fatalf("Delay(%d) = %v out of (0, max]", i, d)
		}
	}
}
