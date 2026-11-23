// Package config reads the service's environment. Variable names reuse the main app's where the value
// is the same thing (DATABASE_REPLICA_URL, REDIS_URL, AUTH_JWKS_URI, …) so a deployment can be fed
// from the same secret keys.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Config is the parsed environment.
type Config struct {
	Addr         string // public listener (the tRPC path), e.g. :8080
	InternalAddr string // /metrics, /healthz, /internal/shadow — never exposed publicly

	// DatabaseURL is the replica the Node path reads for this procedure (its `datapacket` read target):
	// DATAPACKET_DATABASE_RO_URL, else DATABASE_REPLICA_URL.
	DatabaseURL string

	RedisURL         string            // cache cluster (REDIS_URL)
	RedisSysURL      string            // system redis (REDIS_SYS_URL): revocation registry, browsing addons
	RedisCluster     bool              // REDIS_URL is a cluster
	CacheKeyPrefix   string            // CACHE_KEY_NAMESPACE + ":" outside production
	ImageQueryCache  bool              // IMAGE_QUERY_CACHING
	AuthIssuer       string            // AUTH_JWT_ISSUER
	AuthJWKSURI      string            // AUTH_JWKS_URI
	AuthRequireIat0  bool              // AUTH_REQUIRE_IAT0
	AuthCookieMode   string            // AUTH_SESSION_COOKIE_MODE: host | shared (default)
	AuthLegacyRead   bool              // AUTH_LEGACY_READ (see LegacyRead): read the shared-slot cookie
	AuthSiteModes    map[string]string // AUTH_SESSION_COOKIE_MODE_BY_SITE: registrable domain -> host | shared
	SysReadTimeout   time.Duration
	FallbackURL      string // FEED_GO_FALLBACK_URL: the Node app, for everything not served here
	Hosts            browsing.HostColors
	HostPrimaries    map[string]string // each color's SERVER_DOMAIN_<COLOR> (unset colors absent)
	RegionRules      []browsing.RegionRule
	RegionBlockRules []browsing.RegionRule
	CreatorPromotion string          // FEED_GO_CREATOR_PROMOTIONS: the `creator-promotions` flag's audience (feed.ParsePromotionAudience)
	LazyPostImages   bool            // FEED_GO_LAZY_POST_IMAGES: mirrors `gallery-lazy-post-images`
	ImageIndexFeed   bool            // FEED_GO_IMAGE_INDEX_FEED: mirrors `image-index-feed`
	FeedServiceURL   string          // FEED_SERVICE_URL: the image feed service (same var as the Node app)
	DecorationEvents map[string]bool // FEED_GO_DECORATION_EVENTS: events whose hats every viewer sees (started, flag base on; DESIGN.md §8)
	ShadowWorkers    int             // FEED_GO_SHADOW_WORKERS: concurrent shadow comparisons
	// PrioritizedVersionCache is FEED_GO_PRIORITIZED_VERSION_CACHE (default off, as in production):
	// mirrors `use-model-version-cache-for-images`. On, image.getInfinite's prioritizedUserIds requests
	// on the Postgres path fall back (the cache-ordered branch is not ported).
	PrioritizedVersionCache bool
	// The flags model.getAll reads (DESIGN.md §15.3), each defaulting to its production value. Only
	// that state is ported: any of them off makes every model.getAll sample the flag-off-state fallback.
	BaseModelFeedMetrics bool // FEED_GO_BASE_MODEL_FEED_METRICS: mirrors `base-model-feed-metrics`
	ModelImagesSlim      bool // FEED_GO_MODEL_IMAGES_SLIM: mirrors the getAllModelImagesSlim feature
	CoverageNext         bool // FEED_GO_GENERATION_COVERAGE_NEXT: mirrors `generation-coverage-next`
	LoadingOpenToAll     bool // FEED_GO_GENERATION_LOADING_OPEN_TO_ALL: mirrors `generation-loading-open-to-all`
	// ImageLocation is NEXT_PUBLIC_IMAGE_LOCATION (same var as the Node app): the edge URL prefix the
	// REST images endpoint publishes. Unset = that endpoint falls back.
	ImageLocation string
	// Pprof is FEED_GO_PPROF (default off): serve net/http/pprof under /debug/pprof/ on the internal
	// listener only (never the public one).
	Pprof bool
	// ServeModelGetAll is FEED_GO_SERVE_MODEL_GETALL (default off): compute `model.getAll` on the public
	// route (`/api/trpc/model.getAll`). Off, every request there is the `model-getall-off` fallback,
	// proxied to the Node app unchanged.
	ServeModelGetAll bool
	// ServeInfinite is FEED_GO_SERVE_INFINITE (default off): compute `image.getInfinite` on the public
	// route (`/api/trpc/image.getInfinite`). Off, every request there is the `infinite-off` fallback,
	// proxied to the Node app unchanged.
	ServeInfinite bool
	// WriteDevalue is TRPC_WRITE_DEVALUE, the main app's own switch, read as the app reads it (exactly
	// "true" is on; default off): write a public tRPC answer as devalue where the app would
	// (server.Server.WriteDevalue). Off, every answer is superjson.
	WriteDevalue bool

	// BearerAuth is FEED_GO_BEARER_AUTH (default off): resolve API keys (an `Authorization` header) as
	// the app does, from its principal cache (DESIGN.md §4.2). Off, every API credential is the
	// `bearer-token` fallback.
	BearerAuth bool
	// APIKeySecret is NEXTAUTH_SECRET (same var as the Node app): the salt of the API-key hash. Read
	// only with BearerAuth; unset, every key falls back (`bearer-unconfigured`).
	APIKeySecret string
	// OrchestratorServiceToken is ORCHESTRATOR_SERVICE_TOKEN (same var as the Node app), which the app
	// answers as an unknown key without a lookup. Read only with BearerAuth.
	OrchestratorServiceToken string

	// RevocationMarkerCache is SESSION_REVOCATION_CACHE (default on; off|0|false turns it off, as
	// isEnvSwitchOn): a failed revocation read still denies a revocation this process has already read.
	RevocationMarkerCache bool

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
	// RequestBudget is FEED_GO_REQUEST_BUDGET_MS: the deadline of one computation, served
	// or shadow. Past it the request falls back (reason `deadline`); a partial answer is never sent.
	RequestBudget time.Duration
	// MaxInFlight is FEED_GO_MAX_IN_FLIGHT: the public requests one pod computes at once. Past it a
	// request is not computed but proxied to the Node app (fallback reason `bulkhead`). 0 = not set
	// explicitly (unset, zero, negative or junk): the cap is then the replica pool's connection ceiling
	// (server.ResolveMaxInFlight). There is no unlimited setting.
	MaxInFlight int
	// CompletionConcurrency is FEED_GO_COMPLETION_CONCURRENCY: the lazy-post-images completion
	// fetches one request runs at once. The default is sized for shadow load; serving may want more.
	CompletionConcurrency int
	// JWKSRefresh is FEED_GO_JWKS_REFRESH_MS: how often the signing keys are
	// refetched, so a key the auth hub removed stops verifying without a restart.
	JWKSRefresh time.Duration
	// JWKSMaxStaleness is FEED_GO_JWKS_MAX_STALENESS_MS (default 3 × JWKSRefresh): how long the last
	// good key set is kept while refreshes fail; past it sessions verify as signed out.
	JWKSMaxStaleness time.Duration

	// ComputeMisses is FEED_GO_COMPUTE_MISSES (default on): answer the misses of the per-entity caches
	// Node fills on read (user cosmetics, image frames, event decorations) with the Node
	// lookup's own query instead of falling back. Off restores the fallbacks.
	ComputeMisses bool
	// CacheWriteBack is FEED_GO_CACHE_WRITEBACK (default none): the caches whose computed misses are
	// written back to the cache cluster exactly as the Node lookup writes them, as a comma-separated
	// list of hydrate.WriteCaches names (hydrate.ParseWriteBack; an unknown name, the old true/false
	// included, fails Load). A cache not listed is never written by this service.
	CacheWriteBack hydrate.WriteSet
	// CacheWriteLogPerMinute is FEED_GO_CACHE_WRITE_LOG_PER_MIN (default 0 = off): `cache write` log
	// lines per (cache, result) per minute (hydrate.WriteLog).
	CacheWriteLogPerMinute int
	// FrameCacheNegative is FEED_GO_FRAME_CACHE_NEGATIVE: the `frame-cache-negative` flag's value
	// (default off, as Node reads an unknown flag): whether the frame cache's notFound markers are live.
	FrameCacheNegative bool
	// PrimaryDatabaseURL is DATABASE_URL, the primary (Node's dbWrite), read only when CacheWriteBack
	// holds a cache whose lookup reads it (hydrate.PrimaryCaches: the frame, event-decoration,
	// version-images and model-data lookups then read it as Node's do; DESIGN.md §3.1).
	PrimaryDatabaseURL string

	// The ClickHouse reader the image metric-hash misses are computed with (DESIGN.md §3.1), from this
	// service's OWN variables only: FEED_GO_CLICKHOUSE_HOST (the HTTP(S) endpoint),
	// FEED_GO_CLICKHOUSE_USERNAME, FEED_GO_CLICKHOUSE_PASSWORD, for a dedicated SELECT-only login. Read
	// only with ComputeMisses, and only when the host and the username are both set (Node's
	// shouldConnect, over these names); otherwise those misses fall back (`metrics-miss`). The app's
	// CLICKHOUSE_HOST / CLICKHOUSE_USERNAME / CLICKHOUSE_PASSWORD are deliberately never read: the
	// shared app config carries them (the app's read-write login) into this service's environment, and
	// they must not switch the reader on.
	ClickHouseURL, ClickHouseUsername, ClickHousePassword string
	// ClickHouseTimeout is FEED_GO_CLICKHOUSE_TIMEOUT_MS (default 2000): the bound of one page's
	// metrics lookup, at most half of RequestBudget. Past it the page falls back. The lookup also holds
	// it under Node's own budget (hydrate's metricsTimeoutMax), whatever this says.
	ClickHouseTimeout time.Duration
	// MetricsLockWait is FEED_GO_METRICS_LOCK_WAIT_MS (default 500): how long the metrics lookup waits
	// on a populate lock another process holds before the page falls back (`metrics-miss-failed`). It
	// bounds only that wait, not this service's own ClickHouse read (ClickHouseTimeout). Unset, zero,
	// negative or not an integer is the default, as for every FEED_GO_*_MS variable.
	MetricsLockWait time.Duration
	// ClickHouseMaxInFlight is FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT (default 4): the ClickHouse reads one
	// pod sends at once; a read past it falls back at once (`metrics-miss-failed`).
	ClickHouseMaxInFlight int

	// The dedicated ClickHouse for entity metrics, which the image metric-hash populate reads instead
	// of the reader above only while the `image-metrics-dedicated-clickhouse` Flipt flag is on
	// (hydrate.MissCompute.MetricsClickHouse). The same variables as the Node app's (#9780), so one
	// secret feeds both runtimes: CLICKHOUSE_METRICS_HOST (the full URL, protocol and port included),
	// CLICKHOUSE_METRICS_USERNAME, CLICKHOUSE_METRICS_PASSWORD. Read only with ComputeMisses, and only
	// when the host and the username are both set; the password is this server's alone (unset is
	// empty, never another login's). Unset: no second reader, and every populate reads the reader above.
	MetricsClickHouseURL, MetricsClickHouseUsername, MetricsClickHousePassword string
	// MetricsClickHouseRequestTimeout is CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS (default 10000): the
	// bound of one request to the dedicated server, so a hung one releases its read slot and the
	// populate locks within seconds (a write-back populate is otherwise bounded only by its own minute).
	MetricsClickHouseRequestTimeout time.Duration

	// The Flipt server the `image-metrics-dedicated-clickhouse` flag is read from, under the Node
	// app's names (packages/civitai-flipt/src/env.ts): FLIPT_URL, FLIPT_FETCHER_SECRET,
	// FLIPT_ENVIRONMENT (default civitai-app). Read only when the dedicated reader is configured; with
	// FLIPT_URL unset the flag reads off.
	FliptURL, FliptClientToken, FliptEnvironment string

	// AllowedOriginHosts is the app's allowedOriginHosts (src/server/utils/origin-helpers.ts): every
	// SERVER_DOMAIN_* host and alias, each TRPC_ORIGINS entry's host, and NEXTAUTH_URL's host.
	AllowedOriginHosts map[string]bool

	// Tracing is the OpenTelemetry tracing environment (tracing.FromEnv: FEED_GO_OTEL_ENABLED,
	// OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLE_RATIO). Off by default.
	Tracing tracing.Config
	// FallbackLogPerMinute is FEED_GO_FALLBACK_LOG_PER_MIN (default 0 = off): fallback log lines per
	// (mode, endpoint, reason) per minute (server.EventLog; DESIGN.md §10.3).
	FallbackLogPerMinute int
	// ErrorLogPerMinute is FEED_GO_ERROR_LOG_PER_MIN (default 60): compute-error and proxy-error log
	// lines per (mode, endpoint) per minute.
	ErrorLogPerMinute int
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
		AuthLegacyRead:   LegacyRead(os.Getenv("AUTH_LEGACY_READ")),
		AuthSiteModes:    SiteModes(os.Getenv("AUTH_SESSION_COOKIE_MODE_BY_SITE")),
		FallbackURL:      os.Getenv("FEED_GO_FALLBACK_URL"),
		CreatorPromotion: os.Getenv("FEED_GO_CREATOR_PROMOTIONS"),
		LazyPostImages:   boolEnv("FEED_GO_LAZY_POST_IMAGES", true),
		ImageIndexFeed:   boolEnv("FEED_GO_IMAGE_INDEX_FEED", true),
		FeedServiceURL:   os.Getenv("FEED_SERVICE_URL"),
		DecorationEvents: setEnv("FEED_GO_DECORATION_EVENTS"),
		ShadowWorkers:    intEnv("FEED_GO_SHADOW_WORKERS", 8),

		PrioritizedVersionCache: boolEnv("FEED_GO_PRIORITIZED_VERSION_CACHE", false),

		BaseModelFeedMetrics: boolEnv("FEED_GO_BASE_MODEL_FEED_METRICS", true),
		ModelImagesSlim:      boolEnv("FEED_GO_MODEL_IMAGES_SLIM", true),
		CoverageNext:         boolEnv("FEED_GO_GENERATION_COVERAGE_NEXT", true),
		LoadingOpenToAll:     boolEnv("FEED_GO_GENERATION_LOADING_OPEN_TO_ALL", true),
		Pprof:                boolEnv("FEED_GO_PPROF", false),
		ServeModelGetAll:     boolEnv("FEED_GO_SERVE_MODEL_GETALL", false),
		ServeInfinite:        boolEnv("FEED_GO_SERVE_INFINITE", false),
		WriteDevalue:         trpc.WriteDevalueOn(os.Getenv(trpc.WriteDevalueEnv)),
		ImageLocation:        os.Getenv("NEXT_PUBLIC_IMAGE_LOCATION"),

		RedisSysSentinels:        os.Getenv("REDIS_SYS_SENTINELS"),
		RedisSysSentinelName:     os.Getenv("REDIS_SYS_SENTINEL_NAME"),
		RedisSysSentinelPassword: os.Getenv("REDIS_SYS_SENTINEL_PASSWORD"),
	}
	if ns := os.Getenv("CACHE_KEY_NAMESPACE"); ns != "" {
		c.CacheKeyPrefix = ns + ":"
	}
	ms := intEnv("REDIS_SYS_READ_TIMEOUT_MS", 1000)
	c.SysReadTimeout = time.Duration(ms) * time.Millisecond
	c.RevocationMarkerCache = envSwitchOn(os.Getenv("SESSION_REVOCATION_CACHE"))
	if c.BearerAuth = boolEnv("FEED_GO_BEARER_AUTH", false); c.BearerAuth {
		c.APIKeySecret = os.Getenv("NEXTAUTH_SECRET")
		c.OrchestratorServiceToken = os.Getenv("ORCHESTRATOR_SERVICE_TOKEN")
	}
	c.Hosts = browsing.HostColors{}
	c.HostPrimaries = map[string]string{}
	for _, color := range []string{"green", "blue", "red"} {
		up := strings.ToUpper(color)
		var hosts []string
		if h := os.Getenv("SERVER_DOMAIN_" + up); h != "" {
			hosts = append(hosts, h)
			c.HostPrimaries[color] = strings.ToLower(h)
		}
		hosts = append(hosts, list(os.Getenv("SERVER_DOMAIN_"+up+"_ALIASES"))...)
		c.Hosts[color] = hosts
	}
	c.DBMaxConns = intEnv("FEED_GO_DB_MAX_CONNS", 0)
	c.RequestBudget = time.Duration(positiveIntEnv("FEED_GO_REQUEST_BUDGET_MS", 6000)) * time.Millisecond
	c.MaxInFlight = positiveIntEnv("FEED_GO_MAX_IN_FLIGHT", 0)
	c.CompletionConcurrency = positiveIntEnv("FEED_GO_COMPLETION_CONCURRENCY", 4)
	c.JWKSRefresh = time.Duration(positiveIntEnv("FEED_GO_JWKS_REFRESH_MS", 600_000)) * time.Millisecond
	c.JWKSMaxStaleness = time.Duration(positiveIntEnv("FEED_GO_JWKS_MAX_STALENESS_MS", 3*int(c.JWKSRefresh/time.Millisecond))) * time.Millisecond
	if n := intEnv("CIVITAI_MODERATION_USER_ID", 0); n > 0 {
		c.ModerationAccountID = n
	}
	c.ComputeMisses = boolEnv("FEED_GO_COMPUTE_MISSES", true)
	writeBack, err := hydrate.ParseWriteBack(os.Getenv("FEED_GO_CACHE_WRITEBACK"))
	if err != nil {
		return nil, err
	}
	c.CacheWriteBack = writeBack
	c.CacheWriteLogPerMinute = max(intEnv("FEED_GO_CACHE_WRITE_LOG_PER_MIN", 0), 0)
	c.FrameCacheNegative = boolEnv("FEED_GO_FRAME_CACHE_NEGATIVE", false)
	if c.CacheWriteBack.NeedsPrimary() {
		c.PrimaryDatabaseURL = os.Getenv("DATABASE_URL")
	}
	if c.ComputeMisses && os.Getenv("FEED_GO_CLICKHOUSE_HOST") != "" && os.Getenv("FEED_GO_CLICKHOUSE_USERNAME") != "" {
		c.ClickHouseURL = os.Getenv("FEED_GO_CLICKHOUSE_HOST")
		c.ClickHouseUsername = os.Getenv("FEED_GO_CLICKHOUSE_USERNAME")
		c.ClickHousePassword = os.Getenv("FEED_GO_CLICKHOUSE_PASSWORD")
	}
	c.ClickHouseTimeout = min(time.Duration(positiveIntEnv("FEED_GO_CLICKHOUSE_TIMEOUT_MS", 2000))*time.Millisecond, c.RequestBudget/2)
	c.MetricsLockWait = time.Duration(positiveIntEnv("FEED_GO_METRICS_LOCK_WAIT_MS", 500)) * time.Millisecond
	c.ClickHouseMaxInFlight = positiveIntEnv("FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT", 4)
	if c.ComputeMisses && os.Getenv("CLICKHOUSE_METRICS_HOST") != "" && os.Getenv("CLICKHOUSE_METRICS_USERNAME") != "" {
		c.MetricsClickHouseURL = os.Getenv("CLICKHOUSE_METRICS_HOST")
		c.MetricsClickHouseUsername = os.Getenv("CLICKHOUSE_METRICS_USERNAME")
		c.MetricsClickHousePassword = os.Getenv("CLICKHOUSE_METRICS_PASSWORD")
		c.FliptURL = os.Getenv("FLIPT_URL")
		c.FliptClientToken = os.Getenv("FLIPT_FETCHER_SECRET")
		c.FliptEnvironment = env("FLIPT_ENVIRONMENT", "civitai-app")
	}
	c.MetricsClickHouseRequestTimeout = time.Duration(positiveIntEnv("CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS", 10_000)) * time.Millisecond
	c.AllowedOriginHosts = AllowedOriginHosts(c.Hosts, list(os.Getenv("TRPC_ORIGINS")), os.Getenv("NEXTAUTH_URL"))
	c.Tracing = tracing.FromEnv(os.Getenv)
	c.FallbackLogPerMinute = max(intEnv("FEED_GO_FALLBACK_LOG_PER_MIN", 0), 0)
	c.ErrorLogPerMinute = positiveIntEnv("FEED_GO_ERROR_LOG_PER_MIN", 60)
	rules, err := ParseRegionRules(os.Getenv("REGION_RESTRICTION_CONFIG"))
	if err != nil {
		return nil, err
	}
	c.RegionRules = rules
	if c.RegionBlockRules, err = RegionBlockRules(os.Getenv("REGION_BLOCK_CONFIG")); err != nil {
		return nil, err
	}
	if c.DatabaseURL == "" {
		return nil, errors.New("DATAPACKET_DATABASE_RO_URL, DATABASE_REPLICA_URL or DATABASE_URL is required")
	}
	if c.CacheWriteBack.NeedsPrimary() && c.PrimaryDatabaseURL == "" {
		return nil, errors.New("FEED_GO_CACHE_WRITEBACK needs DATABASE_URL for " + strings.Join(primaryWrites(c.CacheWriteBack), ",") +
			" (the primary those lookups read)")
	}
	if c.RedisURL == "" || c.RedisSysURL == "" {
		return nil, errors.New("REDIS_URL and REDIS_SYS_URL are both required")
	}
	if c.AuthJWKSURI == "" || c.AuthIssuer == "" {
		return nil, errors.New("AUTH_JWKS_URI and AUTH_JWT_ISSUER are required")
	}
	return c, nil
}

// CookieNames returns the session cookie names to read on a request to reqHost, in the order the main app
// reads them.
func (c *Config) CookieNames(reqHost string) []string {
	secure := strings.HasPrefix(c.AuthIssuer, "https://")
	if !secure {
		return []string{"civ-token"}
	}
	mode, legacyRead := c.ModeFor(reqHost)
	shared, host := "__Secure-civ-token", "__Host-civ-token"
	var names []string
	if mode == "host" {
		names = append(names, host)
		if legacyRead {
			names = append(names, shared)
		}
		return names
	}
	if legacyRead {
		names = append(names, shared)
	}
	return append(names, host)
}

// LegacyRead parses AUTH_LEGACY_READ as legacyCookieReadEnabled (packages/civitai-auth) does: false only for
// `false`, `0`, `off` or `no` (any case, surrounding whitespace ignored); unset or any other value is true.
func LegacyRead(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "false", "0", "off", "no":
		return false
	}
	return true
}

// SiteModes parses AUTH_SESSION_COOKIE_MODE_BY_SITE as siteCookieMode (packages/civitai-auth) does: comma-separated
// `<registrable domain>:<host|shared>` entries; an entry with any other mode is ignored.
func SiteModes(v string) map[string]string {
	out := map[string]string{}
	if v == "" {
		return out
	}
	for _, entry := range strings.Split(v, ",") {
		parts := strings.Split(entry, ":")
		if len(parts) < 2 {
			continue
		}
		site, mode := strings.ToLower(strings.TrimSpace(parts[0])), strings.TrimSpace(parts[1])
		if site != "" && (mode == "host" || mode == "shared") {
			out[site] = mode
		}
	}
	return out
}

var ipv4 = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

// registrableDomain is registrableDomain (packages/civitai-auth) of a Host header: its last two labels, port
// ignored; "" for localhost and IPs.
func registrableDomain(host string) string {
	h := strings.ToLower(strings.Split(host, ":")[0])
	if h == "" || h == "localhost" || ipv4.MatchString(h) {
		return ""
	}
	parts := strings.Split(h, ".")
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

// ModeFor is sessionCookieMode(host) and legacyCookieReadEnabled(host): a site listed in
// AUTH_SESSION_COOKIE_MODE_BY_SITE takes its own mode (a `host` site never reads the shared slot), any other
// AUTH_SESSION_COOKIE_MODE and AUTH_LEGACY_READ.
func (c *Config) ModeFor(host string) (mode string, legacyRead bool) {
	if site := registrableDomain(host); site != "" {
		if m, ok := c.AuthSiteModes[site]; ok {
			return m, m == "shared"
		}
	}
	return c.AuthCookieMode, c.AuthLegacyRead
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
		rule, err := regionRule(part[:i], part[i+1:])
		if err != nil {
			return nil, fmt.Errorf("invalid region restriction date %q: %w", part, err)
		}
		out = append(out, rule)
	}
	return out, nil
}

// regionRule is one `REGION` + `YYYY-MM-DD` entry. region-blocking.ts reads the date as its END of day,
// UTC (`${date}T23:59:59.999Z`): the rule applies once that instant is reached, not at the start of
// the day.
func regionRule(region, date string) (browsing.RegionRule, error) {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return browsing.RegionRule{}, err
	}
	return browsing.RegionRule{Region: strings.ToUpper(region), Effective: t.Add(24*time.Hour - time.Millisecond)}, nil
}

// RegionBlockRules is REGION_BLOCK_CONFIG (region-blocking.ts): the variable when set (the same format
// as REGION_RESTRICTION_CONFIG), else DEFAULT_REGION_BLOCK_CONFIG, which apipolicy.json carries from
// the Node module so the list is never copied by hand.
func RegionBlockRules(env string) ([]browsing.RegionRule, error) {
	if env != "" {
		return ParseRegionRules(env)
	}
	var out []browsing.RegionRule
	for _, b := range apipolicy.RegionBlockDefault() {
		rule, err := regionRule(b.Region, b.EffectiveDate)
		if err != nil {
			return nil, fmt.Errorf("apipolicy.json region block %q: %w", b.Region, err)
		}
		out = append(out, rule)
	}
	return out, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// primaryWrites are the caches of w whose lookups read the primary (hydrate.PrimaryCaches), for the
// missing-DATABASE_URL error.
func primaryWrites(w hydrate.WriteSet) []string {
	out := make([]string, 0, len(hydrate.PrimaryCaches))
	for _, c := range hydrate.PrimaryCaches {
		if w[c] {
			out = append(out, c)
		}
	}
	return out
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

// envSwitchOn is isEnvSwitchOn (packages/civitai-shared/src/env-switch.ts): a default-ON switch that only
// `off`, `0` or `false` (any case, surrounding whitespace ignored) turns off, so a typo never disables it.
func envSwitchOn(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "off", "0", "false":
		return false
	}
	return true
}

func intEnv(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return def
}

// positiveIntEnv is intEnv where zero or a negative value also means the default.
func positiveIntEnv(k string, def int) int {
	if n := intEnv(k, def); n > 0 {
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
