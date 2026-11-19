// Package dbpool builds the read-replica connection pool with explicit bounds. It is feed-go's
// internal/dbpool (apps/feed-go), copied rather than imported because each Go service under apps/ is
// its own module.
//
// pgxpool's own default ceiling is max(4, runtime.NumCPU()), and NumCPU is the NODE's core count (not
// GOMAXPROCS), so an unconfigured pool's size depends on which node the pod lands on. Config sets every
// bound explicitly instead.
//
// Precedence: a `pool_max_conns`, `pool_min_conns`, `pool_max_conn_lifetime` or
// `pool_max_conn_idle_time` setting in the connection string wins (it is an explicit, per-deployment
// choice); otherwise the value comes from Settings (MaxConns from CONTENT_POLICY_DB_MAX_CONNS).
package dbpool

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Defaults. A decision reads at most one row, by primary key, and only on a cache miss, so the pool
// is small; a burst waits for a connection, bounded by the lookup timeout, and then fails closed.
const (
	DefaultMaxConns        = 4
	DefaultMaxConnLifetime = 30 * time.Minute
	DefaultMaxConnIdleTime = 5 * time.Minute
)

// Settings are the bounds not taken from the connection string.
type Settings struct {
	MaxConns int // CONTENT_POLICY_DB_MAX_CONNS; <= 0 means DefaultMaxConns (capped at 1000)
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
		cfg.MaxConns = int32(min(n, 1000)) //nolint:gosec // G115: bounded to 1000 just above
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
