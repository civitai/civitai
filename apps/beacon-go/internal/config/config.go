// Package config reads the environment. Names reuse the main app's where the value is the same thing
// (REDIS_URL, AUTH_JWKS_URI, CLICKHOUSE_TRACKER_URL, ...), so a deployment can be fed from the same
// secret keys; the service's own settings are BEACON_GO_*.
package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// Config is the parsed environment.
type Config struct {
	// Mode is BEACON_GO_MODE: shadow (default) computes and compares and writes nothing; serve
	// answers the beacons and writes their rows.
	Mode         string
	Addr         string // BEACON_GO_ADDR: public listener (serve mode only), default :8080
	InternalAddr string // BEACON_GO_INTERNAL_ADDR: /metrics, /healthz, /internal/shadow/..., default :9090
	FallbackURL  string // BEACON_GO_FALLBACK_URL: the Node app (required in serve mode)

	// TrackerURL is CLICKHOUSE_TRACKER_URL (required in serve mode).
	TrackerURL string
	// OutwardTraffic is outwardTrafficAllowed(NEXT_PUBLIC_CIVITAI_LINK, NEXT_PUBLIC_LOCAL_TRACKER_ENABLED)
	// under NODE_ENV=production: false only for a loopback public origin without the opt-in.
	OutwardTraffic bool
	TrackerWorkers int // BEACON_GO_TRACKER_WORKERS (default 16)
	TrackerQueue   int // BEACON_GO_TRACKER_QUEUE (default 10000)

	RedisURL       string // REDIS_URL: the cache cluster (session:data2)
	RedisCluster   bool   // REDIS_CLUSTER (default true)
	CacheKeyPrefix string // CACHE_KEY_NAMESPACE + ":" outside production
	RedisSysURL    string // REDIS_SYS_URL: the revocation registry
	SysReadTimeout time.Duration
	// Sentinel mode for the system redis (internal/sysredis), as the Node app.
	RedisSysSentinels        string
	RedisSysSentinelName     string
	RedisSysSentinelPassword string

	AuthIssuer          string            // AUTH_JWT_ISSUER (also the rolling refresh's HUB_ORIGIN)
	AuthJWKSURI         string            // AUTH_JWKS_URI
	AuthRequireIat0     bool              // AUTH_REQUIRE_IAT0
	AuthCookieMode      string            // AUTH_SESSION_COOKIE_MODE: host | shared
	AuthLegacyRead      bool              // AUTH_LEGACY_READ
	AuthSiteModes       map[string]string // AUTH_SESSION_COOKIE_MODE_BY_SITE: registrable domain -> host | shared
	UpdateAgeMs         float64
	ModerationAccountID int // CIVITAI_MODERATION_USER_ID

	ShadowWorkers    int           // BEACON_GO_SHADOW_WORKERS (default 8)
	ComputeBudget    time.Duration // BEACON_GO_COMPUTE_BUDGET_MS (default 2000)
	JWKSRefresh      time.Duration // BEACON_GO_JWKS_REFRESH_MS (default 10 min)
	JWKSMaxStaleness time.Duration // BEACON_GO_JWKS_MAX_STALENESS_MS (default 3 × refresh)
}

// Load reads the environment through getenv (os.Getenv in the binary).
func Load(getenv func(string) string) (*Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	env := func(k, def string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return def
	}
	c := &Config{
		Mode:           strings.ToLower(strings.TrimSpace(env("BEACON_GO_MODE", "shadow"))),
		Addr:           env("BEACON_GO_ADDR", ":8080"),
		InternalAddr:   env("BEACON_GO_INTERNAL_ADDR", ":9090"),
		FallbackURL:    getenv("BEACON_GO_FALLBACK_URL"),
		TrackerURL:     getenv("CLICKHOUSE_TRACKER_URL"),
		OutwardTraffic: OutwardTrafficAllowed(getenv("NEXT_PUBLIC_CIVITAI_LINK"), getenv("NEXT_PUBLIC_LOCAL_TRACKER_ENABLED")),
		TrackerWorkers: positiveInt(getenv("BEACON_GO_TRACKER_WORKERS"), 16),
		TrackerQueue:   positiveInt(getenv("BEACON_GO_TRACKER_QUEUE"), 10000),

		RedisURL:                 getenv("REDIS_URL"),
		RedisCluster:             boolValue(getenv("REDIS_CLUSTER"), true),
		RedisSysURL:              getenv("REDIS_SYS_URL"),
		SysReadTimeout:           time.Duration(positiveInt(getenv("REDIS_SYS_READ_TIMEOUT_MS"), 1000)) * time.Millisecond,
		RedisSysSentinels:        getenv("REDIS_SYS_SENTINELS"),
		RedisSysSentinelName:     getenv("REDIS_SYS_SENTINEL_NAME"),
		RedisSysSentinelPassword: getenv("REDIS_SYS_SENTINEL_PASSWORD"),

		AuthIssuer:      getenv("AUTH_JWT_ISSUER"),
		AuthJWKSURI:     getenv("AUTH_JWKS_URI"),
		AuthRequireIat0: boolValue(getenv("AUTH_REQUIRE_IAT0"), false),
		AuthCookieMode:  "shared",
		AuthLegacyRead:  LegacyReadEnabled(getenv("AUTH_LEGACY_READ")),
		AuthSiteModes:   SiteModes(getenv("AUTH_SESSION_COOKIE_MODE_BY_SITE")),
		UpdateAgeMs:     UpdateAgeMs(getenv("AUTH_SESSION_UPDATE_AGE")),

		ShadowWorkers: positiveInt(getenv("BEACON_GO_SHADOW_WORKERS"), 8),
		ComputeBudget: time.Duration(positiveInt(getenv("BEACON_GO_COMPUTE_BUDGET_MS"), 2000)) * time.Millisecond,
		JWKSRefresh:   time.Duration(positiveInt(getenv("BEACON_GO_JWKS_REFRESH_MS"), 600_000)) * time.Millisecond,
	}
	// sessionCookieMode(): exactly 'host' is host mode, anything else shared.
	if getenv("AUTH_SESSION_COOKIE_MODE") == "host" {
		c.AuthCookieMode = "host"
	}
	c.JWKSMaxStaleness = time.Duration(positiveInt(getenv("BEACON_GO_JWKS_MAX_STALENESS_MS"), 3*int(c.JWKSRefresh/time.Millisecond))) * time.Millisecond
	if ns := getenv("CACHE_KEY_NAMESPACE"); ns != "" {
		c.CacheKeyPrefix = ns + ":"
	}
	if n, err := strconv.Atoi(getenv("CIVITAI_MODERATION_USER_ID")); err == nil && n > 0 {
		c.ModerationAccountID = n
	}
	switch c.Mode {
	case "shadow", "serve":
	default:
		return nil, fmt.Errorf("BEACON_GO_MODE must be shadow or serve, got %q", c.Mode)
	}
	if c.RedisURL == "" || c.RedisSysURL == "" {
		return nil, errors.New("REDIS_URL and REDIS_SYS_URL are both required")
	}
	if c.AuthJWKSURI == "" || c.AuthIssuer == "" {
		return nil, errors.New("AUTH_JWKS_URI and AUTH_JWT_ISSUER are required")
	}
	if c.Mode == "serve" {
		if c.FallbackURL == "" {
			return nil, errors.New("serve mode requires BEACON_GO_FALLBACK_URL (every fallback is proxied to the Node app)")
		}
		if c.TrackerURL == "" {
			return nil, errors.New("serve mode requires CLICKHOUSE_TRACKER_URL")
		}
		for _, u := range []string{c.FallbackURL, c.TrackerURL} {
			if p, err := url.Parse(u); err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
				return nil, fmt.Errorf("not an http(s) URL: %q", u)
			}
		}
	}
	return c, nil
}

// CookieNames are the session cookie names to read on a request to reqHost, in the order the main app
// reads them. The prefixes apply only when the issuer is https.
func (c *Config) CookieNames(reqHost string) []string {
	secure := strings.HasPrefix(c.AuthIssuer, "https://")
	if !secure {
		return []string{"civ-token"}
	}
	mode, legacyRead := c.ModeFor(reqHost)
	shared, host := "__Secure-civ-token", "__Host-civ-token"
	if mode == "host" {
		if legacyRead {
			return []string{host, shared}
		}
		return []string{host}
	}
	if legacyRead {
		return []string{shared, host}
	}
	return []string{host}
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

var legacyReadOff = regexp.MustCompile(`(?i)^(false|0|off|no)$`)

// LegacyReadEnabled is legacyCookieReadEnabled(): on unless the trimmed value is false, 0, off or no
// (any case).
func LegacyReadEnabled(v string) bool {
	return !legacyReadOff.MatchString(jsvalue.Trim(v))
}

// UpdateAgeMs is UPDATE_AGE_MS in session-client.ts: (Number(AUTH_SESSION_UPDATE_AGE) || 86400) * 1000.
// Number(undefined) is NaN; Number(”) is 0; both fall to the default.
func UpdateAgeMs(v string) float64 {
	n := math.NaN()
	if v != "" {
		n = jsvalue.StringToNumber(v)
	}
	if math.IsNaN(n) || n == 0 {
		n = 86400
	}
	return n * 1000
}

// OutwardTrafficAllowed is outwardTrafficAllowed(link, optIn) with NODE_ENV=production: allowed
// unless the link's hostname is loopback (localhost, *.localhost, 127.0.0.1, [::1]) and the opt-in is
// not exactly 'true'. A missing or unparseable link is not local in production.
func OutwardTrafficAllowed(link, optIn string) bool {
	if optIn == "true" || link == "" {
		return true
	}
	u, err := url.Parse(link)
	if err != nil || u.Host == "" {
		return true
	}
	h := strings.ToLower(u.Hostname())
	local := h == "localhost" || strings.HasSuffix(h, ".localhost") || h == "127.0.0.1" || h == "::1"
	return !local
}

func boolValue(v string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	return def
}

func positiveInt(v string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
		return n
	}
	return def
}
