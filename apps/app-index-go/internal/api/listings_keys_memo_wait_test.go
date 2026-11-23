package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// A request waiting on a load leaves at its own deadline with its context's error, without waiting
// for the load; the load goes on and is stored, so the next request at the same key reads the memo.
// Driven on the memo directly, so which of the two (the deadline or the load) ends the wait is
// decided by the test, not by scheduling.
func TestListingKeysWaiterLeavesAtItsOwnDeadline(t *testing.T) {
	src := &orderedLoads{
		ListingsMemory: store.NewListingsMemory(),
		release:        []chan struct{}{make(chan struct{}), make(chan struct{})},
		started:        make(chan int, 2),
	}
	var m keysMemo
	g := store.Generation{ID: 3, Cursor: "C"}

	ctx, cancel := context.WithCancel(t.Context())
	left := make(chan error, 1)
	go func() {
		_, err := m.keys(ctx, src, g, time.Minute)
		left <- err
	}()
	if n := <-src.started; n != 0 {
		t.Fatalf("load is call %d", n)
	}
	cancel()
	select {
	case err := <-left:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the waiter left with %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiter did not leave at its deadline: it is still waiting on the load")
	}

	// The load was not cancelled with its caller: let it finish, and it is the stored answer.
	close(src.release[0])
	close(src.release[1]) // a second load, if one wrongly happens, returns at once
	deadline := time.Now().Add(5 * time.Second)
	for {
		m.mu.Lock()
		stored := m.have && m.at == memoKey(g)
		m.mu.Unlock()
		if stored {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the load its caller left was never stored")
		}
		time.Sleep(time.Millisecond)
	}
	keys, err := m.keys(t.Context(), src, g, time.Minute)
	if err != nil || len(keys) != 1 || keys[0].Slug != "load-0" {
		t.Fatalf("after the waiter left: %+v %v, want load-0 from the memo", keys, err)
	}
	if calls := src.callCount(); calls != 1 {
		t.Errorf("Keys calls: %d, want 1", calls)
	}
}
