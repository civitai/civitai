// Package dbpool builds the read-replica connection pool with explicit bounds.
//
// pgxpool's own default ceiling is max(4, runtime.NumCPU()), and NumCPU is the NODE's core count (not
// GOMAXPROCS), so an unconfigured pool's size depends on which node the pod lands on. Config sets every
// bound explicitly instead.
//
// Precedence: a `pool_max_conns`, `pool_min_conns`, `pool_max_conn_lifetime` or
// `pool_max_conn_idle_time` setting in the connection string wins (it is an explicit, per-deployment
// choice); otherwise the value comes from Settings (MaxConns from FEED_GO_DB_MAX_CONNS).
package dbpool

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Defaults.
//
// DefaultMaxConns = 8. Shadow concurrency is FEED_GO_SHADOW_WORKERS (4 in the deployment)
// comparisons; each runs its page queries one at a time, each followed by a parallel hydration of nine
// lookups of which at most five can reach Postgres at once (basic users, cosmetics and profile
// pictures on a cache miss; video thumbnails; a signed-in viewer's reactions), then a 3D-model read
// when the page has any. With lazy post images on, a comparison then runs one post-count query and up
// to completionConcurrency (4, internal/feed/pager.go) completion fetches at once, each a page query
// plus its hydration. So the worst case is ~4 × 4 × 5 = 80 concurrent reads, and the common case is
// far fewer (page queries plus the reads that always go to Postgres). 8 covers the common case with
// headroom and makes a burst wait for a connection (bounded by the request context) instead of
// opening 80 pooler connections per pod.
// Waiting adds wall time to a shadow comparison, not CPU, so it does not move the CPU-per-call read.
// Raise it for serving, where concurrency is the request rate rather than the worker count.
const (
	DefaultMaxConns        = 8
	DefaultMaxConnLifetime = 30 * time.Minute
	DefaultMaxConnIdleTime = 5 * time.Minute
)

// Settings are the bounds not taken from the connection string.
type Settings struct {
	MaxConns int // FEED_GO_DB_MAX_CONNS; <= 0 means DefaultMaxConns (capped at 1000)
}

// Config parses the connection string and applies the bounds (see the package comment for precedence).
// MinConns is 0 unless the connection string sets it: connections open lazily.
func Config(connString string, s Settings) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, fmt.Errorf("database url: %w", err)
	}
	// pgxpool removes the pool_* keys it consumed, so read which were set from a plain parse of the
	// same string (URL query or keyword/value form alike).
	raw, err := pgconn.ParseConfig(connString)
	if err != nil {
		return nil, fmt.Errorf("database url: %w", err)
	}
	has := func(key string) bool { _, ok := raw.RuntimeParams[key]; return ok }
	if !has("pool_max_conns") {
		n := s.MaxConns
		if n <= 0 {
			n = DefaultMaxConns
		}
		cfg.MaxConns = int32(min(n, 1000))
	}
	if !has("pool_min_conns") {
		cfg.MinConns = 0
	}
	if !has("pool_max_conn_lifetime") {
		cfg.MaxConnLifetime = DefaultMaxConnLifetime
	}
	if !has("pool_max_conn_idle_time") {
		cfg.MaxConnIdleTime = DefaultMaxConnIdleTime
	}
	return cfg, nil
}
