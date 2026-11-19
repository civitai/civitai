// Package config reads the service's environment. There is no .env loading: every value comes from
// the process environment (see .env.example). A name is the main app's where the value is the same
// thing (the database URLs, REGION_RESTRICTION_CONFIG, REGION_BLOCK_CONFIG), so a deployment can be
// fed the same sources the site reads.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// Config is the service's settings.
type Config struct {
	Addr string // CONTENT_POLICY_ADDR: POST /v1/decide, /healthz, /readyz, /metrics

	// DatabaseURL is the read target for user settings: DATAPACKET_DATABASE_RO_URL, else
	// DATABASE_REPLICA_URL, else DATABASE_URL (feed-go's order). Only one SELECT by primary key runs.
	DatabaseURL string
	DBMaxConns  int // CONTENT_POLICY_DB_MAX_CONNS (0: the default)

	LookupTimeout time.Duration // CONTENT_POLICY_LOOKUP_TIMEOUT_MS: one user read, then the SFW fallback
	CacheTTL      time.Duration // CONTENT_POLICY_CACHE_TTL_MS: how long a user's settings are kept (0: not kept)
	CacheMax      int           // CONTENT_POLICY_CACHE_MAX_ENTRIES

	Restricted []policy.Rule // REGION_RESTRICTION_CONFIG, else the site's default
	Blocked    []policy.Rule // REGION_BLOCK_CONFIG, else the site's default
}

// Defaults.
const (
	DefaultAddr          = ":8080"
	DefaultLookupTimeout = 250 * time.Millisecond
	DefaultCacheTTL      = 30 * time.Second
	DefaultCacheMax      = 100_000
)

// Load reads the configuration from getenv (os.Getenv in main).
func Load(getenv func(string) string) (*Config, error) {
	c := &Config{Addr: getenv("CONTENT_POLICY_ADDR")}
	if c.Addr == "" {
		c.Addr = DefaultAddr
	}
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "DATABASE_REPLICA_URL", "DATABASE_URL"} {
		if v := getenv(k); v != "" {
			c.DatabaseURL = v
			break
		}
	}
	if c.DatabaseURL == "" {
		return nil, errors.New("DATAPACKET_DATABASE_RO_URL, DATABASE_REPLICA_URL or DATABASE_URL is required")
	}
	var err error
	if c.DBMaxConns, err = intEnv(getenv, "CONTENT_POLICY_DB_MAX_CONNS", 0, 0); err != nil {
		return nil, err
	}
	ms, err := intEnv(getenv, "CONTENT_POLICY_LOOKUP_TIMEOUT_MS", int(DefaultLookupTimeout/time.Millisecond), 1)
	if err != nil {
		return nil, err
	}
	c.LookupTimeout = time.Duration(ms) * time.Millisecond
	if ms, err = intEnv(getenv, "CONTENT_POLICY_CACHE_TTL_MS", int(DefaultCacheTTL/time.Millisecond), 0); err != nil {
		return nil, err
	}
	c.CacheTTL = time.Duration(ms) * time.Millisecond
	if c.CacheMax, err = intEnv(getenv, "CONTENT_POLICY_CACHE_MAX_ENTRIES", DefaultCacheMax, 1); err != nil {
		return nil, err
	}
	if c.Restricted, err = policy.ParseRules(getenv("REGION_RESTRICTION_CONFIG"), policy.RegionRestrictionDefault()); err != nil {
		return nil, fmt.Errorf("REGION_RESTRICTION_CONFIG: %w", err)
	}
	if c.Blocked, err = policy.ParseRules(getenv("REGION_BLOCK_CONFIG"), policy.RegionBlockDefault()); err != nil {
		return nil, fmt.Errorf("REGION_BLOCK_CONFIG: %w", err)
	}
	return c, nil
}

// intEnv is k as a whole number of at least minimum, or def when unset.
func intEnv(getenv func(string) string, k string, def, minimum int) (int, error) {
	v := getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < minimum {
		return 0, fmt.Errorf("%s must be a whole number >= %d, got %q", k, minimum, v)
	}
	return n, nil
}
