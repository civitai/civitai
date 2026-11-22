package api

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// orderedLoads answers each Keys call with its own channel, in call order, so a test decides when
// each load finishes. The listing a load returns names the load (its Slug is "load-<n>").
type orderedLoads struct {
	*store.ListingsMemory
	mu      sync.Mutex
	calls   int
	release []chan struct{}
	started chan int
}

func (o *orderedLoads) Keys(ctx context.Context, _ int64) ([]store.Listing, error) {
	o.mu.Lock()
	n := o.calls
	o.calls++
	o.mu.Unlock()
	o.started <- n
	select {
	case <-o.release[n]:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return []store.Listing{{Slug: "load-" + strconv.Itoa(n)}}, nil
}

func (o *orderedLoads) callCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.calls
}

// Two loads for two keys finish out of order: the newer key's load, finished first, stays stored;
// the older one, finishing late, answers its own waiter but does not replace it, so the next
// request at the newer key reads the memo instead of loading again. Run for two cursors of one
// generation and for two generations.
func TestListingKeysLateOlderLoadDoesNotReplaceNewer(t *testing.T) {
	for _, c := range []struct {
		name         string
		older, newer store.Generation
	}{
		{"same generation, newer cursor", store.Generation{ID: 7, Cursor: "C1"}, store.Generation{ID: 7, Cursor: "C2"}},
		{"newer generation", store.Generation{ID: 7, Cursor: "C1"}, store.Generation{ID: 8, Cursor: "L"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			src := &orderedLoads{
				ListingsMemory: store.NewListingsMemory(),
				release:        []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})},
				started:        make(chan int, 3),
			}
			var m keysMemo
			ctx := t.Context()
			type result struct {
				keys []store.Listing
				err  error
			}
			get := func(g store.Generation) chan result {
				out := make(chan result, 1)
				go func() {
					keys, err := m.keys(ctx, src, g, time.Minute)
					out <- result{keys, err}
				}()
				return out
			}
			first := get(c.older)
			if n := <-src.started; n != 0 {
				t.Fatalf("first load is call %d", n)
			}
			second := get(c.newer)
			if n := <-src.started; n != 1 {
				t.Fatalf("second load is call %d", n)
			}
			close(src.release[1]) // the newer load finishes first
			if r := <-second; r.err != nil || len(r.keys) != 1 || r.keys[0].Slug != "load-1" {
				t.Fatalf("newer load: %+v", r)
			}
			close(src.release[0]) // then the older one
			if r := <-first; r.err != nil || len(r.keys) != 1 || r.keys[0].Slug != "load-0" {
				t.Fatalf("the older load answers its own waiter: %+v", r)
			}
			close(src.release[2]) // a third load, if one wrongly happens, returns at once
			keys, err := m.keys(ctx, src, c.newer, time.Minute)
			if err != nil || len(keys) != 1 || keys[0].Slug != "load-1" {
				t.Fatalf("the newer key after the late load: %+v %v, want load-1 from the memo", keys, err)
			}
			if calls := src.callCount(); calls != 2 {
				t.Errorf("Keys calls: %d, want 2 (a third means the late load replaced the newer key)", calls)
			}
		})
	}
}
