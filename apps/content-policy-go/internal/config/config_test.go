package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

const dsn = "postgres://u:p@db.invalid:5432/app" //nolint:gosec // G101: a fake DSN

func TestDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"DATABASE_URL": dsn}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.MetricsAddr != ":9090" || c.DatabaseURL != dsn || c.DBMaxConns != 0 || c.LookupTimeout != 250*time.Millisecond ||
		c.CacheTTL != 30*time.Second || c.CacheMax != 100_000 {
		t.Fatalf("defaults: %+v", c)
	}
	// The site's own defaults: GB and AU blocked, nothing restricted.
	if len(c.Blocked) != 2 || c.Blocked[0].Region != "GB" || c.Blocked[1].Region != "AU" || len(c.Restricted) != 0 {
		t.Fatalf("region defaults: blocked %+v restricted %+v", c.Blocked, c.Restricted)
	}
}

func TestDatabaseURLOrder(t *testing.T) {
	ro, replica := "postgres://ro@db.invalid/app", "postgres://replica@db.invalid/app"
	c, _ := Load(env(map[string]string{"DATAPACKET_DATABASE_RO_URL": ro, "DATABASE_REPLICA_URL": replica, "DATABASE_URL": dsn}))
	if c.DatabaseURL != ro {
		t.Fatalf("got %q, want DATAPACKET_DATABASE_RO_URL first", c.DatabaseURL)
	}
	c, _ = Load(env(map[string]string{"DATABASE_REPLICA_URL": replica, "DATABASE_URL": dsn}))
	if c.DatabaseURL != replica {
		t.Fatalf("got %q, want DATABASE_REPLICA_URL before DATABASE_URL", c.DatabaseURL)
	}
	if _, err := Load(env(nil)); err == nil {
		t.Fatal("no database URL must be an error")
	}
}

func TestSettings(t *testing.T) {
	c, err := Load(env(map[string]string{
		"DATABASE_URL":                     dsn,
		"CONTENT_POLICY_ADDR":              ":9999",
		"CONTENT_POLICY_METRICS_ADDR":      ":9998",
		"CONTENT_POLICY_DB_MAX_CONNS":      "6",
		"CONTENT_POLICY_LOOKUP_TIMEOUT_MS": "75",
		"CONTENT_POLICY_CACHE_TTL_MS":      "0",
		"CONTENT_POLICY_CACHE_MAX_ENTRIES": "17",
		"REGION_RESTRICTION_CONFIG":        "FR:2025-08-01,US:NY:2025-07-24",
		"REGION_BLOCK_CONFIG":              "IT:2026-01-01",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":9999" || c.MetricsAddr != ":9998" || c.DBMaxConns != 6 || c.LookupTimeout != 75*time.Millisecond || c.CacheTTL != 0 || c.CacheMax != 17 {
		t.Fatalf("settings: %+v", c)
	}
	if len(c.Restricted) != 2 || c.Restricted[1].Region != "US:NY" || len(c.Blocked) != 1 || c.Blocked[0].Region != "IT" {
		t.Fatalf("lists: %+v %+v", c.Restricted, c.Blocked)
	}
}

func TestInvalid(t *testing.T) {
	for k, v := range map[string]string{
		"CONTENT_POLICY_DB_MAX_CONNS":      "-1",
		"CONTENT_POLICY_LOOKUP_TIMEOUT_MS": "0",
		"CONTENT_POLICY_CACHE_TTL_MS":      "soon",
		"CONTENT_POLICY_CACHE_MAX_ENTRIES": "0",
		"REGION_RESTRICTION_CONFIG":        "FR",
		"REGION_BLOCK_CONFIG":              "GB:2025-02-30",
	} {
		_, err := Load(env(map[string]string{"DATABASE_URL": dsn, k: v}))
		if err == nil || !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%q: err %v, want one naming %s", k, v, err, k)
		}
	}
}

// /metrics has its own listener; one address for both would fail to listen, or (were it allowed)
// put /metrics back beside /v1/decide.
func TestMetricsAddrMustDiffer(t *testing.T) {
	for _, m := range []map[string]string{
		{"CONTENT_POLICY_METRICS_ADDR": ":8080"},
		{"CONTENT_POLICY_ADDR": ":9090"},
		{"CONTENT_POLICY_ADDR": ":7000", "CONTENT_POLICY_METRICS_ADDR": ":7000"},
	} {
		m["DATABASE_URL"] = dsn
		if _, err := Load(env(m)); err == nil || !strings.Contains(err.Error(), "CONTENT_POLICY_METRICS_ADDR") {
			t.Errorf("%v: err %v, want one naming CONTENT_POLICY_METRICS_ADDR", m, err)
		}
	}
}
