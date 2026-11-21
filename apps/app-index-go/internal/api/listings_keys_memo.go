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
// ranks or filters) for the (generation, cursor) it was read at, so a page costs one read of its own
// rows (GetMany) rather than a scan of every listing too. Ranking stays in Go, the one port of the
// store's sort, paging and viewer gate (internal/listingread), rather than a second copy in SQL.
//
// Every committed change moves its generation's cursor in the same transaction, so a new cursor or
// generation misses and is read again; State is read before the load, so held rows are never older
// than their key. Concurrent misses share one load (singleflight), run detached from the first
// caller's cancellation and bounded by timeout; each waiter leaves at its own deadline. A load that
// finishes after a newer key was asked for (a later generation, or a later request's cursor within
// one) answers its waiters but is not stored.
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
