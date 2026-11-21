// Package config reads the service's environment. There is no .env loading: every value comes
// from the process environment (see ../../.env.example).
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the service's settings.
type Config struct {
	// RegistryURL is the registry the index subscribes to (APP_INDEX_REGISTRY_URL, required).
	RegistryURL string
	// RegistryToken is sent as a bearer token when set (APP_INDEX_REGISTRY_TOKEN). Unset, and no
	// client below, the subscription is anonymous: the registry serves the audience anyone may read.
	RegistryToken string
	// Client is the index's own OAuth client, whose client-credentials token every subscription
	// carries (APP_INDEX_CLIENT_ID, APP_INDEX_CLIENT_SECRET, APP_INDEX_TOKEN_URL,
	// APP_INDEX_TOKEN_RESOURCE, and optionally APP_INDEX_TOKEN_SCOPE). Nil when APP_INDEX_CLIENT_ID
	// is unset.
	Client *Client
	// Schema is the subscribed schema (APP_INDEX_SCHEMA, default the app entity schema).
	Schema string
	// DatabaseURL is the index's own Postgres database (APP_INDEX_DATABASE_URL, required).
	DatabaseURL string
	// DBMaxConns bounds the pool (APP_INDEX_DB_MAX_CONNS, default 4, at least 2: the consumer lock
	// holds one connection).
	DBMaxConns int32
	// Addr is the HTTP listen address (APP_INDEX_ADDR, default :8080).
	Addr string
	// BackoffBase and BackoffMax bound the reconnect backoff (APP_INDEX_BACKOFF_BASE_MS default
	// 500, APP_INDEX_BACKOFF_MAX_MS default 60000).
	BackoffBase, BackoffMax time.Duration
	// SearchTimeout bounds one search query (APP_INDEX_SEARCH_TIMEOUT_MS, default 2000).
	SearchTimeout time.Duration
	// Listings switches on the second consumer, of the store listing schema into the listings read
	// model (APP_INDEX_LISTINGS: on/true/1, or off/false/0; unset is off). Off, nothing changes: no
	// subscription, no tables, no series. It holds a second consumer lock, so it needs
	// APP_INDEX_DB_MAX_CONNS of at least 3.
	Listings bool
	// ListingsInvalid is a value of APP_INDEX_LISTINGS that is neither on nor off. It is read as
	// off, never as a reason to refuse to start: a typo in a dark feature's switch must not take
	// down the search the process already serves. The process logs it as an error at start.
	ListingsInvalid string
	// ViewerKey verifies the viewer token the web tier signs on every listing API request
	// (APP_INDEX_VIEWER_KEY, at least 32 bytes; internal/listingread ParseViewer). Read only with
	// listings on. Unset or short, the process still starts and the listing routes answer 503:
	// like APP_INDEX_LISTINGS itself, a dark feature's setting never takes /search down.
	ViewerKey string
}

// Client is the index's OAuth client for the client credentials grant.
type Client struct {
	ID, Secret, TokenURL, Resource, Scope string
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
		ViewerKey:     getenv("APP_INDEX_VIEWER_KEY"),
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
	client, err := clientFromEnv(getenv)
	if err != nil {
		return nil, err
	}
	if client != nil && c.RegistryToken != "" {
		return nil, errors.New("set APP_INDEX_REGISTRY_TOKEN or APP_INDEX_CLIENT_ID, not both")
	}
	c.Client = client
	if c.Schema == "" {
		c.Schema = DefaultSchema
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	ms := func(name string, def int) time.Duration {
		if err != nil {
			return 0
		}
		v, e := intEnv(getenv, name, def, 1, 3_600_000)
		err = e
		return time.Duration(v) * time.Millisecond
	}
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
	switch raw := getenv("APP_INDEX_LISTINGS"); strings.ToLower(strings.TrimSpace(raw)) {
	case "", "off", "false", "0":
	case "on", "true", "1":
		c.Listings = true
	default:
		c.ListingsInvalid = raw
	}
	// Only when listings are actually on: off (or an invalid value, read as off) runs one consumer.
	if c.Listings && conns < 3 {
		// Each consumer holds one connection for its lock; searches and writes need another.
		return nil, errors.New("APP_INDEX_DB_MAX_CONNS must be at least 3 with APP_INDEX_LISTINGS on")
	}
	c.DBMaxConns = int32(conns) //nolint:gosec // bounded to [2, 64] above
	return c, nil
}

// clientFromEnv reads the client credentials settings: all unset is nil; APP_INDEX_CLIENT_ID set
// needs the secret, a token URL (https, or http only to a cluster-local host) and the resource the
// token is for (the hub issues a service token only for a named resource: without one every fetch
// would be refused and the index would retry forever instead of failing at start); any of the
// others without the id is an error, so a half-configured client never silently falls back to an
// anonymous subscription.
func clientFromEnv(getenv func(string) string) (*Client, error) {
	cl := &Client{
		ID:       getenv("APP_INDEX_CLIENT_ID"),
		Secret:   getenv("APP_INDEX_CLIENT_SECRET"),
		TokenURL: getenv("APP_INDEX_TOKEN_URL"),
		Resource: getenv("APP_INDEX_TOKEN_RESOURCE"),
		Scope:    getenv("APP_INDEX_TOKEN_SCOPE"),
	}
	if cl.ID == "" {
		if cl.Secret != "" || cl.TokenURL != "" || cl.Resource != "" || cl.Scope != "" {
			return nil, errors.New("APP_INDEX_CLIENT_ID is required with any other APP_INDEX_CLIENT_* or APP_INDEX_TOKEN_* setting")
		}
		return nil, nil
	}
	if cl.Secret == "" {
		return nil, errors.New("APP_INDEX_CLIENT_SECRET is required with APP_INDEX_CLIENT_ID")
	}
	u, err := url.Parse(cl.TokenURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && (u.Scheme != "http" || !clusterLocal(u.Hostname()))) {
		return nil, errors.New("APP_INDEX_TOKEN_URL must be an https URL (http only to a cluster-local *.svc host) with APP_INDEX_CLIENT_ID")
	}
	if cl.Resource == "" {
		return nil, errors.New("APP_INDEX_TOKEN_RESOURCE is required with APP_INDEX_CLIENT_ID")
	}
	return cl, nil
}

// clusterLocal reports whether host is a Kubernetes service name: `*.svc` or `*.svc.cluster.local`.
// The client secret crosses this hop, so plain http is allowed only inside the cluster.
func clusterLocal(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return strings.HasSuffix(host, ".svc") || strings.HasSuffix(host, ".svc.cluster.local")
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
