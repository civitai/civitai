// Package config reads the service's environment. There is no .env loading: every value comes
// from the process environment (see ../../.env.example).
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
)

// Config is the service's settings.
type Config struct {
	// RegistryURL is the registry the index subscribes to (APP_INDEX_REGISTRY_URL, required).
	RegistryURL string
	// RegistryToken is sent as a bearer token when set (APP_INDEX_REGISTRY_TOKEN). Unset, the
	// subscription is anonymous: the registry serves the audience anyone may read.
	RegistryToken string
	// Schema is the subscribed schema (APP_INDEX_SCHEMA, default the app entity schema).
	Schema string
	// DatabaseURL is the index's own Postgres database (APP_INDEX_DATABASE_URL, required).
	DatabaseURL string
	// DBMaxConns bounds the pool (APP_INDEX_DB_MAX_CONNS, default 4, at least 2: the consumer lock
	// holds one connection).
	DBMaxConns int32
	// Addr is the HTTP listen address (APP_INDEX_ADDR, default :8080).
	Addr string
	// IdleTimeout ends a stream with no traffic, heartbeats included (APP_INDEX_IDLE_TIMEOUT_MS,
	// default 60000).
	IdleTimeout time.Duration
	// BackoffBase and BackoffMax bound the reconnect backoff (APP_INDEX_BACKOFF_BASE_MS default
	// 500, APP_INDEX_BACKOFF_MAX_MS default 60000).
	BackoffBase, BackoffMax time.Duration
	// SearchTimeout bounds one search query (APP_INDEX_SEARCH_TIMEOUT_MS, default 2000).
	SearchTimeout time.Duration
}

// DefaultSchema is the app entity schema of the civitai registry adapter
// (src/server/registry-adapter/urn.ts APP_SCHEMA).
const DefaultSchema = "urn:schema:apps.civitai.com:app@v1"

// Load reads the environment.
func Load() (*Config, error) { return FromEnv(os.Getenv) }

// FromEnv reads settings through getenv.
func FromEnv(getenv func(string) string) (*Config, error) {
	c := &Config{
		RegistryURL:   getenv("APP_INDEX_REGISTRY_URL"),
		RegistryToken: getenv("APP_INDEX_REGISTRY_TOKEN"),
		Schema:        getenv("APP_INDEX_SCHEMA"),
		DatabaseURL:   getenv("APP_INDEX_DATABASE_URL"),
		Addr:          getenv("APP_INDEX_ADDR"),
	}
	if c.RegistryURL == "" {
		return nil, errors.New("APP_INDEX_REGISTRY_URL is required")
	}
	if u, err := url.Parse(c.RegistryURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("APP_INDEX_REGISTRY_URL must be an http(s) URL")
	}
	if c.DatabaseURL == "" {
		return nil, errors.New("APP_INDEX_DATABASE_URL is required")
	}
	if c.Schema == "" {
		c.Schema = DefaultSchema
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	var err error
	ms := func(name string, def int) time.Duration {
		if err != nil {
			return 0
		}
		v, e := intEnv(getenv, name, def, 1, 3_600_000)
		err = e
		return time.Duration(v) * time.Millisecond
	}
	c.IdleTimeout = ms("APP_INDEX_IDLE_TIMEOUT_MS", 60_000)
	c.BackoffBase = ms("APP_INDEX_BACKOFF_BASE_MS", 500)
	c.BackoffMax = ms("APP_INDEX_BACKOFF_MAX_MS", 60_000)
	c.SearchTimeout = ms("APP_INDEX_SEARCH_TIMEOUT_MS", 2_000)
	if err != nil {
		return nil, err
	}
	if c.BackoffMax < c.BackoffBase {
		return nil, errors.New("APP_INDEX_BACKOFF_MAX_MS must be at least APP_INDEX_BACKOFF_BASE_MS")
	}
	conns, err := intEnv(getenv, "APP_INDEX_DB_MAX_CONNS", 4, 2, 64)
	if err != nil {
		return nil, err
	}
	c.DBMaxConns = int32(conns) //nolint:gosec // bounded to [2, 64] above
	return c, nil
}

func intEnv(getenv func(string) string, name string, def, lo, hi int) (int, error) {
	raw := getenv(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < lo || v > hi {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, lo, hi)
	}
	return v, nil
}
