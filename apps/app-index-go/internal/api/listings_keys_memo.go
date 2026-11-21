package api

import (
	"context"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// maxKeysLoad bounds one Keys load when the server has no SearchTimeout. The load runs detached
// from the request that started it (keysMemo.keys), so without a bound of its own a stuck read
// would hold every later request of the same generation and cursor until it returned.
const maxKeysLoad = 10 * time.Second

// keysMemo holds the serving generation's Keys (every listing's columns, which each GET /listings
// ranks or filters) for the generation and cursor it was read at, so that a page costs one store
// read of its own rows (GetMany) instead of a scan of every listing as well.
//
// Why a memo rather than the sort and limit pushed into SQL: Rank and BySlugs are the one port of
// the store's sort keys, its keyset paging and the viewer gate (internal/listingread), and they
// compare keys as bytes, where Postgres compares under its collation. A SQL ranking would be a
// second copy of those rules for the shadow diff to measure as well, and the in-memory store would
// need a third. The scan this saves is the whole cost: the catalog is small enough to hold.
//
// The memo is keyed on (generation, cursor). Every change the consumer commits stores its cursor
// in the same transaction (store.Generations Apply and Live), so a generation's rows cannot change
// without its cursor moving: a new cursor or a new generation misses, and is read again. State is
// read before the load, so the rows held are never older than the cursor they are filed under;
// they may be newer, which a later request at that newer cursor reads again.
//
// Concurrent misses for one key share one load (singleflight). The load runs with the first
// caller's values but not its cancellation, bounded by timeout: a client that gives up does not
// fail the others waiting on the same load, and each waiter still leaves at its own deadline.
//
// Loads for two keys can finish out of order: a load for an older (generation, cursor) that
// returns after the load for a newer one must not replace it, or every request at the newer key
// would miss and load again. So the memo tracks the latest key a request asked for (a later
// generation always wins, since generation ids only grow; within one generation, the cursor is
// opaque, so the most recent request's key), and a finished load is stored only if its key is
// still that one. A load that is not stored still answers the requests that waited on it.
//
// The slice returned is shared by every request at that key: callers read it and never write it
// (listingread's Rank, BySlugs and Filter build new slices).
type keysMemo struct {
	mu   sync.Mutex
	at   string
	val  []store.Listing
	have bool
	sf   singleflight.Group

	// latest is the key of the newest generation, and within it the most recent request, that asked
	// for keys; latestGen is its generation. Only a load for latest is stored.
	latest    string
	latestGen int64
	seen      bool
}

func memoKey(g store.Generation) string {
	return strconv.FormatInt(g.ID, 10) + "\x00" + g.Cursor
}

// keys is g's Keys from src, read at most once per (generation, cursor).
func (m *keysMemo) keys(ctx context.Context, src store.Listings, g store.Generation, timeout time.Duration) ([]store.Listing, error) {
	k := memoKey(g)
	m.mu.Lock()
	if !m.seen || g.ID >= m.latestGen {
		m.latest, m.latestGen, m.seen = k, g.ID, true
	}
	if m.have && m.at == k {
		keys := m.val
		m.mu.Unlock()
		return keys, nil
	}
	m.mu.Unlock()
	if timeout <= 0 {
		timeout = maxKeysLoad
	}
	ch := m.sf.DoChan(k, func() (any, error) {
		lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
		defer cancel()
		keys, err := src.Keys(lctx, g.ID)
		if err != nil {
			return nil, err
		}
		m.mu.Lock()
		// A newer key has been asked for since: leave its stored keys (or its load) alone.
		if m.latest == k {
			m.at, m.val, m.have = k, keys, true
		}
		m.mu.Unlock()
		return keys, nil
	})
	select {
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		return r.Val.([]store.Listing), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
