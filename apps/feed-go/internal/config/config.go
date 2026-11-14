// Package config reads the service's environment. Variable names reuse the main app's where the value
// is the same thing (DATABASE_REPLICA_URL, REDIS_URL, AUTH_JWKS_URI, …) so a deployment can be fed
// from the same secret keys.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

// Config is the parsed environment.
type Config struct {
	Addr         string // public listener (the tRPC path), e.g. :8080
	InternalAddr string // /metrics, /healthz, /internal/shadow — never exposed publicly

	// DatabaseURL is the replica the Node path reads for this procedure (its `datapacket` read target):
	// DATAPACKET_DATABASE_RO_URL, else DATABASE_REPLICA_URL.
	DatabaseURL string

	RedisURL         string // cache cluster (REDIS_URL)
	RedisSysURL      string // system redis (REDIS_SYS_URL): revocation registry, browsing addons
	RedisCluster     bool   // REDIS_URL is a cluster
	CacheKeyPrefix   string // CACHE_KEY_NAMESPACE + ":" outside production
	ImageQueryCache  bool   // IMAGE_QUERY_CACHING
	AuthIssuer       string // AUTH_JWT_ISSUER
	AuthJWKSURI      string // AUTH_JWKS_URI
	AuthRequireIat0  bool   // AUTH_REQUIRE_IAT0
	AuthCookieMode   string // AUTH_SESSION_COOKIE_MODE: host | shared (default)
	AuthLegacyRead   bool   // AUTH_LEGACY_READ (default true): read the shared-slot cookie
	SysReadTimeout   time.Duration
	FallbackURL      string // FEED_GO_FALLBACK_URL: the Node app, for everything not served here
	Hosts            browsing.HostColors
	RegionRules      []browsing.RegionRule
	CreatorPromotion string          // FEED_GO_CREATOR_PROMOTIONS: the `creator-promotions` flag's audience (feed.ParsePromotionAudience)
	LazyPostImages   bool            // FEED_GO_LAZY_POST_IMAGES: mirrors `gallery-lazy-post-images`
	ImageIndexFeed   bool            // FEED_GO_IMAGE_INDEX_FEED: mirrors `image-index-feed`
	FeedServiceURL   string          // FEED_SERVICE_URL: the image feed service (same var as the Node app)
	DecorationEvents map[string]bool // FEED_GO_DECORATION_EVENTS: event decorations visible to everyone
	ShadowWorkers    int             // FEED_GO_SHADOW_WORKERS: concurrent shadow comparisons
	// Pprof is FEED_GO_PPROF (default off): serve net/http/pprof under /debug/pprof/ on the internal
	// listener only (never the public one).
	Pprof bool

	// System redis through its Sentinels (internal/sysredis). Same names and precedence as the
	// Node app: a non-empty REDIS_SYS_SENTINELS selects Sentinel mode, else REDIS_SYS_URL is used.
	RedisSysSentinels        string // REDIS_SYS_SENTINELS: comma-separated host[:port]
	RedisSysSentinelName     string // REDIS_SYS_SENTINEL_NAME: master group, required with SENTINELS
	RedisSysSentinelPassword string // REDIS_SYS_SENTINEL_PASSWORD: only if Sentinel auth is on

	// DBMaxConns is FEED_GO_DB_MAX_CONNS: the replica pool's connection ceiling (0 = dbpool default).
	// A pool_max_conns in the database URL wins (internal/dbpool).
	DBMaxConns int

	// ModerationAccountID is CIVITAI_MODERATION_USER_ID: the shared moderation account, refused as a
	// session (0 when unset or not a positive integer; the reserved username is refused regardless).
	ModerationAccountID int
	// AllowedOriginHosts is the app's allowedOriginHosts (src/server/utils/origin-helpers.ts): every
	// SERVER_DOMAIN_* host and alias, each TRPC_ORIGINS entry's host, and NEXTAUTH_URL's host.
	AllowedOriginHosts map[string]bool
}

// Load reads the environment.
func Load() (*Config, error) {
	c := &Config{
		Addr:             env("FEED_GO_ADDR", ":8080"),
		InternalAddr:     env("FEED_GO_INTERNAL_ADDR", ":9090"),
		DatabaseURL:      firstNonEmpty(os.Getenv("DATAPACKET_DATABASE_RO_URL"), os.Getenv("DATABASE_REPLICA_URL"), os.Getenv("DATABASE_URL")),
		RedisURL:         os.Getenv("REDIS_URL"),
		RedisSysURL:      os.Getenv("REDIS_SYS_URL"),
		RedisCluster:     boolEnv("REDIS_CLUSTER", true),
		ImageQueryCache:  boolEnv("IMAGE_QUERY_CACHING", false),
		AuthIssuer:       os.Getenv("AUTH_JWT_ISSUER"),
		AuthJWKSURI:      os.Getenv("AUTH_JWKS_URI"),
		AuthRequireIat0:  boolEnv("AUTH_REQUIRE_IAT0", false),
		AuthCookieMode:   env("AUTH_SESSION_COOKIE_MODE", "shared"),
		AuthLegacyRead:   boolEnv("AUTH_LEGACY_READ", true),
		FallbackURL:      os.Getenv("FEED_GO_FALLBACK_URL"),
		CreatorPromotion: os.Getenv("FEED_GO_CREATOR_PROMOTIONS"),
		LazyPostImages:   boolEnv("FEED_GO_LAZY_POST_IMAGES", true),
		ImageIndexFeed:   boolEnv("FEED_GO_IMAGE_INDEX_FEED", true),
		FeedServiceURL:   os.Getenv("FEED_SERVICE_URL"),
		DecorationEvents: setEnv("FEED_GO_DECORATION_EVENTS"),
		ShadowWorkers:    intEnv("FEED_GO_SHADOW_WORKERS", 8),
		Pprof:            boolEnv("FEED_GO_PPROF", false),

		RedisSysSentinels:        os.Getenv("REDIS_SYS_SENTINELS"),
		RedisSysSentinelName:     os.Getenv("REDIS_SYS_SENTINEL_NAME"),
		RedisSysSentinelPassword: os.Getenv("REDIS_SYS_SENTINEL_PASSWORD"),
	}
	if ns := os.Getenv("CACHE_KEY_NAMESPACE"); ns != "" {
		c.CacheKeyPrefix = ns + ":"
	}
	ms := intEnv("REDIS_SYS_READ_TIMEOUT_MS", 1000)
	c.SysReadTimeout = time.Duration(ms) * time.Millisecond
	c.Hosts = browsing.HostColors{}
	for _, color := range []string{"green", "blue", "red"} {
		up := strings.ToUpper(color)
		var hosts []string
		if h := os.Getenv("SERVER_DOMAIN_" + up); h != "" {
			hosts = append(hosts, h)
		}
		hosts = append(hosts, list(os.Getenv("SERVER_DOMAIN_"+up+"_ALIASES"))...)
		c.Hosts[color] = hosts
	}
	c.DBMaxConns = intEnv("FEED_GO_DB_MAX_CONNS", 0)
	if n := intEnv("CIVITAI_MODERATION_USER_ID", 0); n > 0 {
		c.ModerationAccountID = n
	}
	c.AllowedOriginHosts = AllowedOriginHosts(c.Hosts, list(os.Getenv("TRPC_ORIGINS")), os.Getenv("NEXTAUTH_URL"))
	rules, err := ParseRegionRules(os.Getenv("REGION_RESTRICTION_CONFIG"))
	if err != nil {
		return nil, err
	}
	c.RegionRules = rules
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATAPACKET_DATABASE_RO_URL, DATABASE_REPLICA_URL or DATABASE_URL is required")
	}
	if c.RedisURL == "" || c.RedisSysURL == "" {
		return nil, fmt.Errorf("REDIS_URL and REDIS_SYS_URL are both required")
	}
	if c.AuthJWKSURI == "" || c.AuthIssuer == "" {
		return nil, fmt.Errorf("AUTH_JWKS_URI and AUTH_JWT_ISSUER are required")
	}
	return c, nil
}

// CookieNames returns the session cookie names to read, in the order getHubSession reads them.
func (c *Config) CookieNames() []string {
	secure := strings.HasPrefix(c.AuthIssuer, "https://")
	if !secure {
		return []string{"civ-token"}
	}
	shared, host := "__Secure-civ-token", "__Host-civ-token"
	var names []string
	if c.AuthCookieMode == "host" {
		names = append(names, host)
		if c.AuthLegacyRead {
			names = append(names, shared)
		}
		return names
	}
	if c.AuthLegacyRead {
		names = append(names, shared)
	}
	return append(names, host)
}

// AllowedOriginHosts builds the origin allow-list the app's isAcceptableOrigin checks: the server
// hosts (as configured, lowercased), plus the host of each TRPC_ORIGINS URL and of NEXTAUTH_URL.
func AllowedOriginHosts(hosts browsing.HostColors, trpcOrigins []string, nextAuthURL string) map[string]bool {
	out := map[string]bool{}
	for _, hs := range hosts {
		for _, h := range hs {
			if h != "" {
				out[strings.ToLower(h)] = true
			}
		}
	}
	urls := append([]string{nextAuthURL}, trpcOrigins...)
	for _, u := range urls {
		if h := HostFromURL(u); h != "" {
			out[h] = true
		}
	}
	return out
}

// HostFromURL is hostFromUrl (origin-helpers.ts): the lowercased host[:port] of an absolute URL, or ""
// when the value is empty or not an absolute URL.
func HostFromURL(v string) string {
	if v == "" {
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	// WHATWG URL drops a scheme's default port from `host`.
	if p := u.Port(); (u.Scheme == "https" && p == "443") || (u.Scheme == "http" && p == "80") {
		return strings.ToLower(u.Hostname())
	}
	return strings.ToLower(u.Host)
}

// ParseRegionRules parses REGION_RESTRICTION_CONFIG: `REGION:YYYY-MM-DD,...` (the last colon splits,
// so `US:TX:2026-01-01` is region `US:TX`).
func ParseRegionRules(s string) ([]browsing.RegionRule, error) {
	var out []browsing.RegionRule
	for _, part := range list(s) {
		i := strings.LastIndex(part, ":")
		if i < 0 {
			return nil, fmt.Errorf("invalid region restriction config %q", part)
		}
		t, err := time.Parse("2006-01-02", part[i+1:])
		if err != nil {
			return nil, fmt.Errorf("invalid region restriction date %q: %w", part, err)
		}
		// region-blocking.ts reads the date as its END of day, UTC (`${date}T23:59:59.999Z`): the
		// restriction starts once that instant is reached, not at the start of the day.
		eff := t.Add(24*time.Hour - time.Millisecond)
		out = append(out, browsing.RegionRule{Region: strings.ToUpper(part[:i]), Effective: eff})
	}
	return out, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func boolEnv(k string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	switch v {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	return def
}

func intEnv(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return def
}

func list(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func setEnv(k string) map[string]bool {
	out := map[string]bool{}
	for _, v := range list(os.Getenv(k)) {
		out[v] = true
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
