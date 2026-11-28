package config

import (
	"errors"
	"maps"
	"strings"
	"testing"
	"time"
)

const cacheKey = "CACHE-KEY-0123456789abcdef-0123456789abcdef" //nolint:gosec // G101: a synthetic test fixture

func cacheFiles(path string) ([]byte, error) {
	switch path {
	case "/run/secrets/cache-key":
		return []byte(cacheKey + "\n"), nil
	case "/run/secrets/cache-password":
		return []byte("FILE-PASS-77aa\r\n"), nil
	}
	return nil, errors.New("no such file")
}

func loadCache(extra map[string]string) (*Config, error) {
	kv := relayEnv()
	maps.Copy(kv, extra)
	return FromEnv(env(kv), cacheFiles)
}

func TestTheCacheIsOffUnlessItsURLIsSet(t *testing.T) {
	c, err := loadCache(nil)
	if err != nil || c.Cache != nil {
		t.Fatalf("%+v %v", c.Cache, err)
	}
}

func TestTheCacheSettingsAreRead(t *testing.T) {
	c, err := loadCache(map[string]string{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		"APP_DATA_CACHE_URL":           "redis://valkey.cache.svc.cluster.local:6379/2",
		"APP_DATA_CACHE_KEY_FILE":      "/run/secrets/cache-key",
		"APP_DATA_CACHE_PASSWORD_FILE": "/run/secrets/cache-password",
		"APP_DATA_CACHE_OP_TIMEOUT_MS": "40",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Cache{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		URL: "redis://valkey.cache.svc.cluster.local:6379/2", Password: "FILE-PASS-77aa", Timeout: 40 * time.Millisecond}
	if c.Cache == nil || c.Cache.URL != want.URL || string(c.Cache.Key) != cacheKey || c.Cache.Password != want.Password || c.Cache.Timeout != want.Timeout {
		t.Fatalf("got %+v", c.Cache)
	}
	// From the environment, with the defaults.
	c, err = loadCache(map[string]string{"APP_DATA_CACHE_URL": "rediss://cache.example.invalid", "APP_DATA_CACHE_KEY": cacheKey,
		"APP_DATA_CACHE_PASSWORD": "ENV-PASS"})
	if err != nil || c.Cache.Timeout != 100*time.Millisecond || c.Cache.Password != "ENV-PASS" {
		t.Fatalf("%+v %v", c.Cache, err)
	}
	for _, u := range []string{"valkeys://cache.example.invalid:7000", "valkey://valkey.cache.svc", "redis://valkey.cache.svc/0"} {
		if _, err := loadCache(map[string]string{"APP_DATA_CACHE_URL": u, "APP_DATA_CACHE_KEY": cacheKey}); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
}

func TestBadCacheSettingsFailTheStart(t *testing.T) {
	ok := map[string]string{"APP_DATA_CACHE_URL": "redis://valkey.cache.svc", "APP_DATA_CACHE_KEY": cacheKey}
	with := func(kv map[string]string) map[string]string {
		out := maps.Clone(ok)
		for k, v := range kv {
			if v == "-" {
				delete(out, k)
				continue
			}
			out[k] = v
		}
		return out
	}
	for name, tc := range map[string]struct { //nolint:gosec // G101: synthetic test fixtures, not credentials
		extra map[string]string
		want  string
	}{
		"a key without a URL":     {map[string]string{"APP_DATA_CACHE_URL": "-"}, "need APP_DATA_CACHE_URL"},
		"a timeout without a URL": {map[string]string{"APP_DATA_CACHE_URL": "-", "APP_DATA_CACHE_KEY": "-", "APP_DATA_CACHE_OP_TIMEOUT_MS": "5"}, "need APP_DATA_CACHE_URL"},
		"plain to a public host":  {map[string]string{"APP_DATA_CACHE_URL": "redis://cache.example.invalid"}, "rediss://"},
		"another scheme":          {map[string]string{"APP_DATA_CACHE_URL": "https://valkey.cache.svc"}, "must be a redis://"},
		"credentials in the URL":  {map[string]string{"APP_DATA_CACHE_URL": "redis://u:p@valkey.cache.svc"}, "host only"}, //nolint:gosec // G101: a synthetic fixture
		"a query":                 {map[string]string{"APP_DATA_CACHE_URL": "redis://valkey.cache.svc?db=1"}, "host only"},
		"no host":                 {map[string]string{"APP_DATA_CACHE_URL": "redis:///1"}, "host only"},
		"a bad db":                {map[string]string{"APP_DATA_CACHE_URL": "redis://valkey.cache.svc/16"}, "database number"},
		"no key":                  {map[string]string{"APP_DATA_CACHE_KEY": "-"}, "needs APP_DATA_CACHE_KEY_FILE"},
		"a short key":             {map[string]string{"APP_DATA_CACHE_KEY": "short"}, "at least 32 bytes"},
		"both key settings":       {map[string]string{"APP_DATA_CACHE_KEY_FILE": "/run/secrets/cache-key"}, "not both"},
		"an unreadable key file":  {map[string]string{"APP_DATA_CACHE_KEY": "-", "APP_DATA_CACHE_KEY_FILE": "/nope"}, "APP_DATA_CACHE_KEY_FILE could not be read"},
		"both password settings":  {map[string]string{"APP_DATA_CACHE_PASSWORD": "a", "APP_DATA_CACHE_PASSWORD_FILE": "/run/secrets/cache-password"}, "not both"}, //nolint:gosec // G101: a synthetic fixture
		"an out-of-range timeout": {map[string]string{"APP_DATA_CACHE_OP_TIMEOUT_MS": "2001"}, "from 5 to 2000"},
		"an unparseable URL":      {map[string]string{"APP_DATA_CACHE_URL": "redis://valkey.cache.svc:port"}, "host only"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := loadCache(with(tc.extra))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
			// 🔴 No error names the key.
			if strings.Contains(err.Error(), cacheKey) {
				t.Fatal("an error carries the key")
			}
		})
	}
	// Without the registry path.
	if _, err := FromEnv(env(map[string]string{"APP_DATA_REST_URL": "https://site.invalid", "APP_DATA_CACHE_URL": "redis://valkey.cache.svc",
		"APP_DATA_CACHE_KEY": cacheKey}), cacheFiles); err == nil || !strings.Contains(err.Error(), "needs the registry path") {
		t.Fatalf("no registry: %v", err)
	}
}
