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
// ranks or filters), read once per (generation, cursor). Three invariants:
//
//   - The cursor is the cache key: every committed change moves its generation's cursor, so a
//     change is a miss.
//   - State is read before the load, so held rows are never older than their key.
//   - A load for a stale key (a newer generation or cursor was asked for since) answers its
//     waiters but is not stored.
//
// The returned slice is shared: callers never write it.
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
