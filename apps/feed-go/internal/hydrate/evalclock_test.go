package hydrate

import (
	"context"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// FEED_GO_EVAL_NOW reaches cache-entry staleness: with no Now of its own, a PackedReader reads an
// entry's age against clock.Now, so the same entry is fresh at one frozen instant and stale at a later
// one (both far from the wall clock, so the wall clock cannot pass this test).
func TestEvalClockReachesOrderedStaleness(t *testing.T) {
	t.Cleanup(clock.Reset)
	cachedAt := time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC)
	r := testkit.NewRedis()
	r.SetString("k:1", packMap(t, "id", int64(1), "cachedAt", cachedAt))
	p := &PackedReader{Redis: r}
	for _, tc := range []struct {
		at    time.Time
		stale bool
	}{
		{cachedAt.Add(time.Hour), false},
		{cachedAt.Add(48 * time.Hour), true},
	} {
		clock.Freeze(tc.at)
		b := NewBatch()
		read := p.QueueOrdered(b, "k", []int{1}, 24*time.Hour)
		b.Exec(context.Background())
		e, ok := read.Entries()[1]
		if !ok || e.Stale != tc.stale {
			t.Fatalf("at %v: entry %+v (found %v), want stale=%v", tc.at, e, ok, tc.stale)
		}
	}
}
