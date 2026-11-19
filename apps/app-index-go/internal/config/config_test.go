package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func base() map[string]string {
	return map[string]string{
		"APP_INDEX_REGISTRY_URL": "https://registry.invalid/apps",
		"APP_INDEX_DATABASE_URL": "postgres://u@db.invalid/appindex",
	}
}

func TestDefaults(t *testing.T) {
	c, err := FromEnv(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Schema != "urn:schema:apps.civitai.com:app@v1" || c.Addr != ":8080" || c.DBMaxConns != 4 || c.RegistryToken != "" ||
		c.IdleTimeout != 60*time.Second || c.BackoffBase != 500*time.Millisecond || c.BackoffMax != time.Minute ||
		c.SearchTimeout != 2*time.Second {
		t.Fatalf("defaults %+v", c)
	}
}

func TestOverrides(t *testing.T) {
	m := base()
	m["APP_INDEX_REGISTRY_TOKEN"] = "tok"
	m["APP_INDEX_SCHEMA"] = "urn:schema:example.invalid:thing@v2"
	m["APP_INDEX_ADDR"] = ":9999"
	m["APP_INDEX_DB_MAX_CONNS"] = "8"
	m["APP_INDEX_IDLE_TIMEOUT_MS"] = "45000"
	m["APP_INDEX_BACKOFF_BASE_MS"] = "250"
	m["APP_INDEX_BACKOFF_MAX_MS"] = "30000"
	m["APP_INDEX_SEARCH_TIMEOUT_MS"] = "300"
	c, err := FromEnv(env(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.RegistryToken != "tok" || c.Schema != "urn:schema:example.invalid:thing@v2" || c.Addr != ":9999" || c.DBMaxConns != 8 ||
		c.IdleTimeout != 45*time.Second || c.BackoffBase != 250*time.Millisecond || c.BackoffMax != 30*time.Second ||
		c.SearchTimeout != 300*time.Millisecond {
		t.Fatalf("overrides %+v", c)
	}
}

func TestInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"APP_INDEX_REGISTRY_URL":    {"APP_INDEX_REGISTRY_URL": ""},
		"http(s) URL":               {"APP_INDEX_REGISTRY_URL": "ftp://registry.invalid"},
		"APP_INDEX_DATABASE_URL":    {"APP_INDEX_DATABASE_URL": ""},
		"APP_INDEX_DB_MAX_CONNS":    {"APP_INDEX_DB_MAX_CONNS": "1"},
		"APP_INDEX_IDLE_TIMEOUT_MS": {"APP_INDEX_IDLE_TIMEOUT_MS": "soon"},
		"at least":                  {"APP_INDEX_BACKOFF_BASE_MS": "5000", "APP_INDEX_BACKOFF_MAX_MS": "1000"},
	}
	for want, over := range cases {
		m := base()
		for k, v := range over {
			m[k] = v
		}
		_, err := FromEnv(env(m))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%v: err %v, want one naming %q", over, err, want)
		}
	}
}
