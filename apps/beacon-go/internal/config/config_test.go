package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func base() map[string]string {
	return map[string]string{
		"REDIS_URL": "redis://cache:6379", "REDIS_SYS_URL": "redis://sys:6379",
		"AUTH_JWKS_URI": "https://auth.example.test/.well-known/jwks.json", "AUTH_JWT_ISSUER": "https://auth.example.test",
	}
}

func TestDefaults(t *testing.T) {
	c, err := Load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != "shadow" || c.Addr != ":8080" || c.InternalAddr != ":9090" || !c.RedisCluster || c.SysReadTimeout != time.Second ||
		c.AuthCookieMode != "shared" || !c.AuthLegacyRead || c.UpdateAgeMs != 86_400_000 || !c.OutwardTraffic ||
		c.TrackerWorkers != 16 || c.TrackerQueue != 10000 || c.ShadowWorkers != 8 || c.ComputeBudget != 2*time.Second ||
		c.JWKSRefresh != 10*time.Minute || c.JWKSMaxStaleness != 30*time.Minute || c.CacheKeyPrefix != "" {
		t.Fatalf("defaults: %+v", c)
	}
	if got := strings.Join(c.CookieNames(""), ","); got != "__Secure-civ-token,__Host-civ-token" {
		t.Fatalf("cookie names %s", got)
	}
}

func TestRequiredAndServeMode(t *testing.T) {
	for _, k := range []string{"REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		m := base()
		delete(m, k)
		if _, err := Load(env(m)); err == nil {
			t.Errorf("missing %s accepted", k)
		}
	}
	m := base()
	m["BEACON_GO_MODE"] = "write"
	if _, err := Load(env(m)); err == nil {
		t.Error("an unknown mode was accepted")
	}
	m["BEACON_GO_MODE"] = "serve"
	if _, err := Load(env(m)); err == nil {
		t.Error("serve without a fallback or tracker URL was accepted")
	}
	m["BEACON_GO_FALLBACK_URL"] = "http://node:3000"
	if _, err := Load(env(m)); err == nil {
		t.Error("serve without a tracker URL was accepted")
	}
	m["CLICKHOUSE_TRACKER_URL"] = "tracker:8080"
	if _, err := Load(env(m)); err == nil {
		t.Error("a tracker URL without a scheme was accepted")
	}
	m["CLICKHOUSE_TRACKER_URL"] = "http://tracker:8080"
	if c, err := Load(env(m)); err != nil || c.Mode != "serve" {
		t.Fatalf("serve: %v", err)
	}
}

func TestOverrides(t *testing.T) {
	m := base()
	m["AUTH_SESSION_COOKIE_MODE"] = "host"
	m["AUTH_LEGACY_READ"] = " OFF "
	m["AUTH_SESSION_UPDATE_AGE"] = "3600"
	m["CACHE_KEY_NAMESPACE"] = "dev"
	m["REDIS_CLUSTER"] = "false"
	m["CIVITAI_MODERATION_USER_ID"] = "-3"
	m["BEACON_GO_JWKS_REFRESH_MS"] = "1000"
	c, err := Load(env(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.AuthCookieMode != "host" || c.AuthLegacyRead || c.UpdateAgeMs != 3_600_000 || c.CacheKeyPrefix != "dev:" ||
		c.RedisCluster || c.ModerationAccountID != 0 || c.JWKSMaxStaleness != 3*time.Second {
		t.Fatalf("%+v", c)
	}
	if got := strings.Join(c.CookieNames(""), ","); got != "__Host-civ-token" {
		t.Fatalf("cookie names %s", got)
	}
	c.AuthIssuer = "http://localhost:5173"
	if got := strings.Join(c.CookieNames(""), ","); got != "civ-token" {
		t.Fatalf("insecure cookie names %s", got)
	}
}

// Node's rules, written from session-client.ts / cookies.ts / local-origin.ts.
func TestNodeRules(t *testing.T) {
	ages := []struct {
		in   string
		want float64
	}{{"", 86_400_000}, {"abc", 86_400_000}, {"0", 86_400_000}, {" 60 ", 60_000}, {"-5", -5000}, {"1e3", 1_000_000}}
	for _, c := range ages {
		if got := UpdateAgeMs(c.in); got != c.want {
			t.Errorf("UpdateAgeMs(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	reads := []struct {
		in   string
		want bool
	}{{"", true}, {"false", false}, {"FALSE", false}, {" 0 ", false}, {"off", false}, {"No", false}, {"nope", true}, {"true", true}}
	for _, c := range reads {
		if got := LegacyReadEnabled(c.in); got != c.want {
			t.Errorf("LegacyReadEnabled(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	cases := []struct {
		link, optIn string
		want        bool
	}{
		{"", "", true}, {"https://civitai.example.test", "", true}, {"http://localhost:3000", "", false},
		{"http://app.localhost", "", false}, {"http://127.0.0.1", "", false}, {"http://[::1]:3000", "", false},
		{"http://localhost:3000", "true", true}, {"http://localhost:3000", "TRUE", false}, {"::bad", "", true},
	}
	for _, c := range cases {
		if got := OutwardTrafficAllowed(c.link, c.optIn); got != c.want {
			t.Errorf("OutwardTrafficAllowed(%q, %q) = %v, want %v", c.link, c.optIn, got, c.want)
		}
	}
}

// AUTH_SESSION_COOKIE_MODE_BY_SITE: a site listed host reads only the host-only slot; every other site keeps the
// global mode (shared here), and an entry with a mistyped mode leaves its site unlisted.
func TestCookieNamesPerSite(t *testing.T) {
	m := base()
	m["AUTH_SESSION_COOKIE_MODE_BY_SITE"] = "civitai.red:host, civitai.example:Host"
	c, err := Load(env(m))
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
