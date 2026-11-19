package config

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

func TestParseRegionRulesEndOfDay(t *testing.T) {
	rules, err := ParseRegionRules("gb:2026-03-15, US:TX:2026-04-02")
	if err != nil {
		t.Fatal(err)
	}
	want := []browsing.RegionRule{
		{Region: "GB", Effective: time.Date(2026, 3, 15, 23, 59, 59, int(999*time.Millisecond), time.UTC)},
		{Region: "US:TX", Effective: time.Date(2026, 4, 2, 23, 59, 59, int(999*time.Millisecond), time.UTC)},
	}
	if !reflect.DeepEqual(rules, want) {
		t.Fatalf("rules = %+v, want %+v", rules, want)
	}
	// Mid-day on the effective date is NOT yet restricted (Node: `${date}T23:59:59.999Z`).
	midday := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	if browsing.IsRegionRestricted(rules, "GB", "", midday) {
		t.Fatal("restricted before the end of the effective day")
	}
	if !browsing.IsRegionRestricted(rules, "GB", "", time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)) {
		t.Fatal("not restricted after the effective day")
	}
	if _, err := ParseRegionRules("GB"); err == nil {
		t.Fatal("an entry without a date must fail")
	}
}

// REGION_BLOCK_CONFIG: the variable wins when set (the app's `process.env.REGION_BLOCK_CONFIG ? … :
// DEFAULT_REGION_BLOCK_CONFIG`); unset or empty is the app's default list from apipolicy.json.
func TestRegionBlockRules(t *testing.T) {
	set, err := RegionBlockRules("FR:2026-08-01")
	if err != nil {
		t.Fatal(err)
	}
	want := []browsing.RegionRule{{Region: "FR", Effective: time.Date(2026, 8, 1, 23, 59, 59, int(999*time.Millisecond), time.UTC)}}
	if !reflect.DeepEqual(set, want) {
		t.Fatalf("set: rules = %+v, want %+v", set, want)
	}
	def, err := RegionBlockRules("")
	if err != nil {
		t.Fatal(err)
	}
	gb := browsing.RegionRule{Region: "GB", Effective: time.Date(2025, 7, 24, 23, 59, 59, int(999*time.Millisecond), time.UTC)}
	found := false
	for _, r := range def {
		found = found || r == gb
	}
	if !found {
		t.Fatalf("default: rules = %+v, want GB:2025-07-24 in them", def)
	}
	if _, err := RegionBlockRules("GB"); err == nil {
		t.Fatal("an entry without a date must fail, as the app throws")
	}
	// Load reads it.
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	t.Setenv("REGION_BLOCK_CONFIG", "FR:2026-08-01")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.RegionBlockRules, want) {
		t.Fatalf("Load: RegionBlockRules = %+v, want %+v", c.RegionBlockRules, want)
	}
}

func TestHostFromURL(t *testing.T) {
	cases := map[string]string{
		"https://Civitai.Example":         "civitai.example",
		"https://a.example:8443/path?q=1": "a.example:8443",
		"https://a.example:443":           "a.example",
		"http://b.example:80":             "b.example",
		"http://b.example:8080":           "b.example:8080",
		"":                                "",
		"not a url":                       "",
		"a.example":                       "",
		"//no-scheme.example":             "",
	}
	for in, want := range cases {
		if got := HostFromURL(in); got != want {
			t.Errorf("HostFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAllowedOriginHosts(t *testing.T) {
	hosts := browsing.HostColors{"green": {"Green.Example", "alias.green.example"}, "blue": {"blue.example"}, "red": nil}
	got := AllowedOriginHosts(hosts, []string{"https://studio.example", "junk"}, "https://auth-callback.example")
	want := map[string]bool{
		"green.example": true, "alias.green.example": true, "blue.example": true,
		"studio.example": true, "auth-callback.example": true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestLoadFeedServiceMirrors(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	// Unset: both mirrors default ON (the production value of both flags); no feed service.
	t.Setenv("FEED_GO_IMAGE_INDEX_FEED", "")
	t.Setenv("FEED_GO_LAZY_POST_IMAGES", "")
	t.Setenv("FEED_SERVICE_URL", "")
	// Unset: `use-model-version-cache-for-images` mirrored OFF (its production value).
	t.Setenv("FEED_GO_PRIORITIZED_VERSION_CACHE", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.ImageIndexFeed || !c.LazyPostImages || c.FeedServiceURL != "" || c.PrioritizedVersionCache {
		t.Fatalf("defaults: index=%v lazy=%v url=%q versionCache=%v", c.ImageIndexFeed, c.LazyPostImages, c.FeedServiceURL, c.PrioritizedVersionCache)
	}
	t.Setenv("FEED_GO_IMAGE_INDEX_FEED", "false")
	t.Setenv("FEED_GO_LAZY_POST_IMAGES", "false")
	t.Setenv("FEED_SERVICE_URL", "http://feed.internal")
	t.Setenv("FEED_GO_PRIORITIZED_VERSION_CACHE", "true")
	if c, err = Load(); err != nil {
		t.Fatal(err)
	}
	if c.ImageIndexFeed || c.LazyPostImages || c.FeedServiceURL != "http://feed.internal" || !c.PrioritizedVersionCache {
		t.Fatalf("set: index=%v lazy=%v url=%q versionCache=%v", c.ImageIndexFeed, c.LazyPostImages, c.FeedServiceURL, c.PrioritizedVersionCache)
	}
}

// model.getAll's flag mirrors: unset, each is its flag's production value (on); each one is read from
// its own variable, so turning one off moves that one alone.
func TestLoadModelGetAllMirrors(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	vars := []string{"FEED_GO_BASE_MODEL_FEED_METRICS", "FEED_GO_MODEL_IMAGES_SLIM", "FEED_GO_GENERATION_COVERAGE_NEXT", "FEED_GO_GENERATION_LOADING_OPEN_TO_ALL"}
	read := func(c *Config) [4]bool {
		return [4]bool{c.BaseModelFeedMetrics, c.ModelImagesSlim, c.CoverageNext, c.LoadingOpenToAll}
	}
	for _, v := range vars {
		t.Setenv(v, "")
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := read(c); got != [4]bool{true, true, true, true} {
		t.Fatalf("defaults %v, want all on", got)
	}
	for i, v := range vars {
		t.Setenv(v, "false")
		if c, err = Load(); err != nil {
			t.Fatal(err)
		}
		want := [4]bool{true, true, true, true}
		want[i] = false
		if got := read(c); got != want {
			t.Fatalf("%s=false: %v, want %v", v, got, want)
		}
		t.Setenv(v, "")
	}
}

func TestLoadPprofDefaultsOff(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "true": true, "1": true} {
		t.Setenv("FEED_GO_PPROF", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.Pprof != want {
			t.Errorf("FEED_GO_PPROF=%q -> %v, want %v", in, c.Pprof, want)
		}
	}
}

func TestLoadServeModelGetAllDefaultsOff(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "true": true, "1": true} {
		t.Setenv("FEED_GO_SERVE_MODEL_GETALL", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.ServeModelGetAll != want {
			t.Errorf("FEED_GO_SERVE_MODEL_GETALL=%q -> %v, want %v", in, c.ServeModelGetAll, want)
		}
	}
}

// SESSION_REVOCATION_CACHE is a default-on switch (isEnvSwitchOn): only off/0/false, any case and
// surrounding whitespace, turn it off; unset, empty and unknown values keep it on. The cases are the
// package's own env-switch.test.ts.
func TestLoadRevocationMarkerCacheSwitch(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	off := []string{"off", "OFF", "Off", "0", "false", "FALSE", "False", " off ", "\tfalse\n"}
	on := []string{"", " ", "on", "true", "1", "no", "offf", "disabled", "00", "false!"}
	for _, in := range append(off, on...) {
		t.Setenv("SESSION_REVOCATION_CACHE", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		want := true
		for _, o := range off {
			if in == o {
				want = false
			}
		}
		if c.RevocationMarkerCache != want {
			t.Errorf("SESSION_REVOCATION_CACHE=%q -> %v, want %v", in, c.RevocationMarkerCache, want)
		}
	}
}

func TestLoadModerationAccountID(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for in, want := range map[string]int{"9131": 9131, "": 0, "-4": 0, "abc": 0} {
		t.Setenv("CIVITAI_MODERATION_USER_ID", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.ModerationAccountID != want {
			t.Errorf("CIVITAI_MODERATION_USER_ID=%q -> %d, want %d", in, c.ModerationAccountID, want)
		}
	}
}

func TestLoadServingLimits(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	cases := []struct {
		budget, concurrency, jwks, stale string
		wantBudget                       time.Duration
		wantConcurrency                  int
		wantJWKS, wantStale              time.Duration
	}{
		{"", "", "", "", 6 * time.Second, 4, 10 * time.Minute, 30 * time.Minute},
		// The staleness default follows the refresh interval (3 ×); an explicit value wins.
		{"2500", "12", "30000", "", 2500 * time.Millisecond, 12, 30 * time.Second, 90 * time.Second},
		{"", "", "", "120000", 6 * time.Second, 4, 10 * time.Minute, 2 * time.Minute},
		// Zero, negative or junk is the default, never an unbounded or zero budget.
		{"0", "0", "0", "0", 6 * time.Second, 4, 10 * time.Minute, 30 * time.Minute},
		{"-1", "-3", "junk", "-5", 6 * time.Second, 4, 10 * time.Minute, 30 * time.Minute},
	}
	for _, c := range cases {
		t.Setenv("FEED_GO_REQUEST_BUDGET_MS", c.budget)
		t.Setenv("FEED_GO_COMPLETION_CONCURRENCY", c.concurrency)
		t.Setenv("FEED_GO_JWKS_REFRESH_MS", c.jwks)
		t.Setenv("FEED_GO_JWKS_MAX_STALENESS_MS", c.stale)
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.JWKSMaxStaleness != c.wantStale {
			t.Errorf("jwks=%q stale=%q -> staleness %v, want %v", c.jwks, c.stale, cfg.JWKSMaxStaleness, c.wantStale)
		}
		if cfg.RequestBudget != c.wantBudget || cfg.CompletionConcurrency != c.wantConcurrency || cfg.JWKSRefresh != c.wantJWKS {
			t.Errorf("budget=%q concurrency=%q jwks=%q -> %v %d %v, want %v %d %v", c.budget, c.concurrency, c.jwks,
				cfg.RequestBudget, cfg.CompletionConcurrency, cfg.JWKSRefresh, c.wantBudget, c.wantConcurrency, c.wantJWKS)
		}
	}
}

// The miss computation is on by default, write-back and the frame negative-cache mirror off; write-back
// needs the primary (DATABASE_URL), which is read only then.
func TestLoadCacheMissSettings(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for _, k := range []string{"FEED_GO_COMPUTE_MISSES", "FEED_GO_CACHE_WRITEBACK", "FEED_GO_FRAME_CACHE_NEGATIVE", "DATABASE_URL"} {
		t.Setenv(k, "")
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.ComputeMisses || c.CacheWriteBack || c.FrameCacheNegative || c.PrimaryDatabaseURL != "" {
		t.Fatalf("defaults: compute %v, writeback %v, frame negative %v, primary %q; want true, false, false, unset",
			c.ComputeMisses, c.CacheWriteBack, c.FrameCacheNegative, c.PrimaryDatabaseURL)
	}
	t.Setenv("DATABASE_URL", "x://primary")
	if c, _ = Load(); c.PrimaryDatabaseURL != "" {
		t.Fatalf("primary %q read with write-back off", c.PrimaryDatabaseURL)
	}

	t.Setenv("FEED_GO_CACHE_WRITEBACK", "true")
	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("write-back without DATABASE_URL loaded")
	}
	t.Setenv("DATABASE_URL", "x://primary")
	t.Setenv("FEED_GO_COMPUTE_MISSES", "false")
	t.Setenv("FEED_GO_FRAME_CACHE_NEGATIVE", "true")
	if c, err = Load(); err != nil {
		t.Fatal(err)
	}
	if c.ComputeMisses || !c.CacheWriteBack || !c.FrameCacheNegative || c.PrimaryDatabaseURL != "x://primary" {
		t.Fatalf("set: compute %v, writeback %v, frame negative %v, primary %q", c.ComputeMisses, c.CacheWriteBack, c.FrameCacheNegative, c.PrimaryDatabaseURL)
	}
}

// The ClickHouse reader is configured only from feed-go's own variables: the miss computation on and
// both FEED_GO_CLICKHOUSE_HOST and FEED_GO_CLICKHOUSE_USERNAME set (Node's shouldConnect over those).
// The app's own CLICKHOUSE_HOST / CLICKHOUSE_USERNAME / CLICKHOUSE_PASSWORD, which the shared app
// config carries into this service's environment with the app's read-write login, never configure
// it, alone or alongside. Its timeout defaults to 2 s and is held to half the request budget; its
// read cap defaults to 4.
func TestLoadClickHouse(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for _, k := range []string{"FEED_GO_COMPUTE_MISSES", "FEED_GO_CLICKHOUSE_TIMEOUT_MS", "FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT",
		"FEED_GO_REQUEST_BUDGET_MS", "CLICKHOUSE_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD",
		"FEED_GO_CLICKHOUSE_HOST", "FEED_GO_CLICKHOUSE_USERNAME", "FEED_GO_CLICKHOUSE_PASSWORD"} {
		t.Setenv(k, "")
	}
	load := func() *Config {
		t.Helper()
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	if c := load(); c.ClickHouseURL != "" || c.ClickHouseTimeout != 2*time.Second || c.ClickHouseMaxInFlight != 4 {
		t.Fatalf("defaults: url %q timeout %v cap %d; want unset, 2s, 4", c.ClickHouseURL, c.ClickHouseTimeout, c.ClickHouseMaxInFlight)
	}
	// The app's variables alone: no reader.
	t.Setenv("CLICKHOUSE_HOST", "https://app-ch.example.test:8443")
	t.Setenv("CLICKHOUSE_USERNAME", "app-writer")
	t.Setenv("CLICKHOUSE_PASSWORD", "app-pw")
	if c := load(); c.ClickHouseURL != "" || c.ClickHouseUsername != "" || c.ClickHousePassword != "" {
		t.Fatalf("app variables only: %q %q %q, want no reader (the app's login is never used)", c.ClickHouseURL, c.ClickHouseUsername, c.ClickHousePassword)
	}
	t.Setenv("FEED_GO_CLICKHOUSE_HOST", "https://ch.example.test:8443")
	if c := load(); c.ClickHouseURL != "" {
		t.Fatalf("host without username (the app's username set): url %q, want unset", c.ClickHouseURL)
	}
	t.Setenv("FEED_GO_CLICKHOUSE_USERNAME", "feed-go-reader")
	if c := load(); c.ClickHouseURL != "https://ch.example.test:8443" || c.ClickHouseUsername != "feed-go-reader" || c.ClickHousePassword != "" {
		t.Fatalf("own host and username, no own password: %q %q %q; want the app's password not taken", c.ClickHouseURL, c.ClickHouseUsername, c.ClickHousePassword)
	}
	t.Setenv("FEED_GO_CLICKHOUSE_PASSWORD", "feed-go-pw")
	if c := load(); c.ClickHouseURL != "https://ch.example.test:8443" || c.ClickHouseUsername != "feed-go-reader" || c.ClickHousePassword != "feed-go-pw" {
		t.Fatalf("set: %q %q %q", c.ClickHouseURL, c.ClickHouseUsername, c.ClickHousePassword)
	}
	t.Setenv("FEED_GO_COMPUTE_MISSES", "false")
	if c := load(); c.ClickHouseURL != "" {
		t.Fatalf("compute off: url %q, want unset", c.ClickHouseURL)
	}
	t.Setenv("FEED_GO_CLICKHOUSE_TIMEOUT_MS", "900")
	t.Setenv("FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT", "7")
	if c := load(); c.ClickHouseTimeout != 900*time.Millisecond || c.ClickHouseMaxInFlight != 7 {
		t.Fatalf("explicit: %v %d, want 900ms 7", c.ClickHouseTimeout, c.ClickHouseMaxInFlight)
	}
	t.Setenv("FEED_GO_CLICKHOUSE_TIMEOUT_MS", "5000")
	t.Setenv("FEED_GO_REQUEST_BUDGET_MS", "3000")
	if c := load(); c.ClickHouseTimeout != 1500*time.Millisecond {
		t.Fatalf("past half the budget: %v, want 1.5s", c.ClickHouseTimeout)
	}
}

// FEED_GO_METRICS_LOCK_WAIT_MS bounds the wait on another process's populate lock: 500 ms by default;
// a positive integer is that many ms; zero, negative or junk is the default (as every FEED_GO_*_MS),
// never a zero bound that would fall back on every held lock without a read. It is independent of
// FEED_GO_CLICKHOUSE_TIMEOUT_MS.
//
// Fails on: the default changed (500); the variable not read (250, 3000); a non-positive or junk value
// taken as is (0 / -5) or failing startup; the value read in seconds or derived from the ClickHouse
// timeout.
func TestLoadMetricsLockWait(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	t.Setenv("FEED_GO_REQUEST_BUDGET_MS", "")
	t.Setenv("FEED_GO_CLICKHOUSE_TIMEOUT_MS", "1700")
	for v, want := range map[string]time.Duration{
		"":     500 * time.Millisecond,
		"250":  250 * time.Millisecond,
		"3000": 3000 * time.Millisecond,
		"0":    500 * time.Millisecond,
		"-5":   500 * time.Millisecond,
		"abc":  500 * time.Millisecond,
		"1.5":  500 * time.Millisecond,
	} {
		t.Setenv("FEED_GO_METRICS_LOCK_WAIT_MS", v)
		c, err := Load()
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if c.MetricsLockWait != want {
			t.Errorf("FEED_GO_METRICS_LOCK_WAIT_MS=%q: %v, want %v", v, c.MetricsLockWait, want)
		}
		if c.ClickHouseTimeout != 1700*time.Millisecond {
			t.Errorf("FEED_GO_METRICS_LOCK_WAIT_MS=%q moved the ClickHouse timeout to %v", v, c.ClickHouseTimeout)
		}
	}
}

// FEED_GO_MAX_IN_FLIGHT: a positive integer is an explicit cap; anything else (unset, zero, negative,
// junk) is 0, "not set", which the server resolves to the pool's ceiling — never an unlimited pod.
func TestLoadMaxInFlight(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for in, want := range map[string]int{"": 0, "0": 0, "-3": 0, "junk": 0, "1": 1, "7": 7, "64": 64} {
		t.Setenv("FEED_GO_MAX_IN_FLIGHT", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.MaxInFlight != want {
			t.Errorf("FEED_GO_MAX_IN_FLIGHT=%q -> %d, want %d", in, c.MaxInFlight, want)
		}
	}
}

// AUTH_SESSION_COOKIE_MODE_BY_SITE: a site listed host reads only the host-only slot; every other site keeps the
// global mode (shared here), and an entry with a mistyped mode leaves its site unlisted.
func TestCookieNamesPerSite(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI"} {
		t.Setenv(k, "x://"+k)
	}
	t.Setenv("AUTH_JWT_ISSUER", "https://auth.civitai.com")
	t.Setenv("AUTH_SESSION_COOKIE_MODE_BY_SITE", "civitai.red:host, civitai.example:Host")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"civitai.red":         "__Host-civ-token",
		"www.civitai.red:443": "__Host-civ-token",
		"civitai.com":         "__Secure-civ-token,__Host-civ-token",
		"civitai.example":     "__Secure-civ-token,__Host-civ-token",
		"":                    "__Secure-civ-token,__Host-civ-token",
	}
	for host, want := range cases {
		if got := strings.Join(c.CookieNames(host), ","); got != want {
			t.Errorf("CookieNames(%q) = %s, want %s", host, got, want)
		}
	}
}
