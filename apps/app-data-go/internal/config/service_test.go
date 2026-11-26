package config

import (
	"slices"
	"strings"
	"testing"
)

// THE SERVICE CLIENT and the region flag. Fails on the commit before them: there is no
// Config.Service, ForwardRegion nor NoServiceClientWarning (the test does not compile); there, the
// level streams' token was minted as the relay client, which the hub refuses.

// sharedEnv is relayEnv with the writes on, so shared reads are on.
func sharedEnv() map[string]string {
	kv := relayEnv()
	kv["APP_DATA_WRITES"] = "true"
	kv["APP_DATA_WRITES_SIGNING_KEY"] = strings.Repeat("k", 32)
	kv["APP_DATA_BLOCK_JWKS_URL"] = "https://site.invalid/api/v1/block-tokens/jwks"
	return kv
}

func serviceFiles(path string) ([]byte, error) {
	if path == "/run/secrets/app-data-service" {
		return []byte("SVC-FILE-SECRET-e05b\r\n"), nil
	}
	return files(path)
}

func loadWith(kv map[string]string, extra map[string]string) (*Config, error) {
	all := map[string]string{}
	for k, v := range kv {
		all[k] = v
	}
	for k, v := range extra {
		all[k] = v
	}
	return FromEnv(env(all), serviceFiles)
}

func TestTheServiceClientIsItsOwn(t *testing.T) {
	c, err := loadWith(sharedEnv(), map[string]string{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		"APP_DATA_SERVICE_CLIENT_ID":          "svc-client-7a",
		"APP_DATA_SERVICE_CLIENT_SECRET_FILE": "/run/secrets/app-data-service",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Service == nil || *c.Service != (ServiceClient{ClientID: "svc-client-7a", ClientSecret: "SVC-FILE-SECRET-e05b"}) { //nolint:gosec // G101: a synthetic test fixture, not a credential
		t.Fatalf("service client: %+v", c.Service)
	}
	if c.Relay.ClientID != "relay-client" || c.Relay.ClientSecret != "ENV-SECRET-4d7e" {
		t.Fatalf("the relay client changed: %+v", c.Relay)
	}
	if w := c.Warnings(); len(w) != 0 {
		t.Fatalf("warnings with a service client: %v", w)
	}

	c, err = loadWith(sharedEnv(), map[string]string{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a", "APP_DATA_SERVICE_CLIENT_SECRET": "SVC-ENV-SECRET-31f0",
	})
	if err != nil || c.Service == nil || c.Service.ClientSecret != "SVC-ENV-SECRET-31f0" {
		t.Fatalf("by env secret: %+v %v", c, err)
	}
}

// 🔴 Shared reads with no service client start, warn, and never borrow the relay client.
func TestSharedReadsWithoutAServiceClientWarn(t *testing.T) {
	c, err := loadWith(sharedEnv(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !c.SharedReads || c.Service != nil {
		t.Fatalf("shared %v, service %+v", c.SharedReads, c.Service)
	}
	if w := c.Warnings(); !slices.Contains(w, NoServiceClientWarning) {
		t.Fatalf("warnings: %v; want %q", w, NoServiceClientWarning)
	}
	// Shared reads off (the writes off): no warning about a client nothing would use.
	c, err = loadWith(relayEnv(), nil)
	if err != nil || len(c.Warnings()) != 0 {
		t.Fatalf("shared off: %v %v", c.Warnings(), err)
	}
	// A service client set with shared reads off is named as ignored.
	c, err = loadWith(relayEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a", "APP_DATA_SERVICE_CLIENT_SECRET": "x"})
	if err != nil || len(c.Warnings()) != 1 || !strings.Contains(c.Warnings()[0], "APP_DATA_SERVICE_CLIENT_ID set without shared reads") {
		t.Fatalf("service client, shared off: %v %v", c.Warnings(), err)
	}
}

func TestABadServiceClientFailsTheStart(t *testing.T) {
	cases := []struct {
		name  string
		base  map[string]string
		extra map[string]string
		want  string
	}{
		{"the relay client", sharedEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "relay-client", "APP_DATA_SERVICE_CLIENT_SECRET": "x"},
			"must be a service client of its own"},
		{"no secret", sharedEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a"}, "needs a secret"},
		{"both secrets", sharedEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a", //nolint:gosec // G101: a synthetic test fixture, not a credential
			"APP_DATA_SERVICE_CLIENT_SECRET": "x", "APP_DATA_SERVICE_CLIENT_SECRET_FILE": "/run/secrets/app-data-service"}, "not both"},
		{"a secret without an id", sharedEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_SECRET_FILE": "/run/secrets/app-data-service"}, //nolint:gosec // G101: a synthetic test fixture, not a credential
			"APP_DATA_SERVICE_CLIENT_ID is required"},
		{"an unreadable file", sharedEnv(), map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a",
			"APP_DATA_SERVICE_CLIENT_SECRET_FILE": "/run/secrets/missing"}, "could not be read"},
		{"no registry path", map[string]string{"APP_DATA_REST_URL": "https://site.invalid"},
			map[string]string{"APP_DATA_SERVICE_CLIENT_ID": "svc-client-7a", "APP_DATA_SERVICE_CLIENT_SECRET": "x"}, "needs the registry path"},
	}
	for _, c := range cases {
		_, err := loadWith(c.base, c.extra)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v; want an error naming %q", c.name, err, c.want)
		}
		if err != nil && (strings.Contains(err.Error(), "SVC-FILE-SECRET") || strings.Contains(err.Error(), "ENV-SECRET")) {
			t.Errorf("🔴 %s: the error carries a secret: %v", c.name, err)
		}
	}
}

func TestTheRegionFlag(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "true": true, "1": true} {
		c, err := loadWith(relayEnv(), map[string]string{"APP_DATA_FORWARD_REGION": v})
		if err != nil || c.ForwardRegion != want {
			t.Errorf("%q: %v %v; want %v", v, c.ForwardRegion, err, want)
		}
	}
	if _, err := loadWith(relayEnv(), map[string]string{"APP_DATA_FORWARD_REGION": "yes"}); err == nil {
		t.Error("APP_DATA_FORWARD_REGION=yes was accepted")
	}
	_, err := loadWith(map[string]string{"APP_DATA_REST_URL": "https://site.invalid"}, map[string]string{"APP_DATA_FORWARD_REGION": "1"})
	if err == nil || !strings.Contains(err.Error(), "needs the registry path") {
		t.Errorf("without the registry path: %v", err)
	}
}
