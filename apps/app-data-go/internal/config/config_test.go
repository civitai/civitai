package config

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func env(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }

// files is the secret files the tests can read.
func files(path string) ([]byte, error) {
	if path == "/run/secrets/app-data-client" {
		return []byte("FILE-SECRET-91c2\n"), nil
	}
	return nil, errors.New("no such file")
}

func load(kv map[string]string) (*Config, error) { return FromEnv(env(kv), files) }

// relayEnv is a complete relay client, by env secret.
func relayEnv() map[string]string {
	return map[string]string{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		"APP_DATA_REST_URL":          "https://site.invalid",
		"APP_DATA_REGISTRY_URL":      "https://adapter.invalid",
		"APP_DATA_HUB_TOKEN_URL":     "https://hub.invalid/api/auth/oauth/token",
		"APP_DATA_CLIENT_ID":         "relay-client",
		"APP_DATA_CLIENT_SECRET":     "ENV-SECRET-4d7e",
		"APP_DATA_EXCHANGE_RESOURCE": "https://apps.invalid",
	}
}

func TestDefaults(t *testing.T) {
	c, err := load(map[string]string{"APP_DATA_REST_URL": "https://site.invalid"})
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":8080", RESTURL: "https://site.invalid", MaxStreams: 100, MaxStreamsPerToken: 4,
		IdleTTL: 5 * time.Minute, MaxAge: 14 * time.Minute, LiveWait: 1500 * time.Millisecond,
		RequestDeadline: 4 * time.Second, MaxRecords: 1000, MaxBytes: 2 << 20, RESTMaxInFlight: 64}
	if *c != want {
		t.Fatalf("got %+v\nwant %+v", *c, want)
	}
	if c.RegistryURL != "" || c.Relay != nil {
		t.Fatal("the registry path must default to off")
	}
}

func TestEverySettingIsRead(t *testing.T) {
	c, err := load(map[string]string{ //nolint:gosec // G101: a synthetic test fixture, not a credential
		"APP_DATA_ADDR": ":9", "APP_DATA_REST_URL": "http://site.ns.svc.cluster.local:3000",
		"APP_DATA_REGISTRY_URL": "https://registry.invalid", "APP_DATA_MAX_STREAMS": "7",
		"APP_DATA_HUB_TOKEN_URL": "http://hub.ns.svc:8080/token", "APP_DATA_CLIENT_ID": "relay-client",
		"APP_DATA_CLIENT_SECRET_FILE":    "/run/secrets/app-data-client",
		"APP_DATA_EXCHANGE_RESOURCE":     "https://apps.invalid",
		"APP_DATA_MAX_STREAMS_PER_TOKEN": "3", "APP_DATA_STREAM_IDLE_TTL_MS": "2000",
		"APP_DATA_STREAM_MAX_AGE_MS": "9000", "APP_DATA_LIVE_WAIT_MS": "11",
		"APP_DATA_REQUEST_DEADLINE_MS": "130", "APP_DATA_MAX_RECORDS_PER_STREAM": "17",
		"APP_DATA_MAX_BYTES_PER_STREAM": "70000", "APP_DATA_REST_MAX_INFLIGHT": "5",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":9", RESTURL: "http://site.ns.svc.cluster.local:3000", RegistryURL: "https://registry.invalid",
		MaxStreams: 7, MaxStreamsPerToken: 3, IdleTTL: 2 * time.Second, MaxAge: 9 * time.Second,
		LiveWait: 11 * time.Millisecond, RequestDeadline: 130 * time.Millisecond, MaxRecords: 17, MaxBytes: 70000,
		RESTMaxInFlight: 5}
	wantRelay := Relay{TokenURL: "http://hub.ns.svc:8080/token", ClientID: "relay-client", //nolint:gosec // G101: a synthetic test fixture, not a credential
		ClientSecret: "FILE-SECRET-91c2", Resource: "https://apps.invalid"}
	if c.Relay == nil || *c.Relay != wantRelay {
		t.Fatalf("relay %+v\nwant %+v", c.Relay, wantRelay)
	}
	c.Relay = nil
	if *c != want {
		t.Fatalf("got %+v\nwant %+v", *c, want)
	}
}

func TestInvalidSettingsFailTheStart(t *testing.T) {
	base := relayEnv()
	cases := map[string]struct {
		set  map[string]string
		want string
	}{
		"no REST url":               {map[string]string{"APP_DATA_REST_URL": ""}, "APP_DATA_REST_URL is required"},
		"plain http REST":           {map[string]string{"APP_DATA_REST_URL": "http://site.invalid"}, "APP_DATA_REST_URL must be"},
		"REST url with a query":     {map[string]string{"APP_DATA_REST_URL": "https://site.invalid?x=1"}, "APP_DATA_REST_URL must be"},
		"REST url with userinfo":    {map[string]string{"APP_DATA_REST_URL": "https://user@site.invalid"}, "APP_DATA_REST_URL must be"},
		"plain http registry":       {map[string]string{"APP_DATA_REGISTRY_URL": "http://registry.invalid"}, "APP_DATA_REGISTRY_URL must be"},
		"registry not a url":        {map[string]string{"APP_DATA_REGISTRY_URL": "registry"}, "APP_DATA_REGISTRY_URL must be"},
		"registry without relay":    {map[string]string{"APP_DATA_CLIENT_ID": "", "APP_DATA_CLIENT_SECRET": "", "APP_DATA_HUB_TOKEN_URL": "", "APP_DATA_EXCHANGE_RESOURCE": ""}, "needs the relay client"},
		"relay without registry":    {map[string]string{"APP_DATA_REGISTRY_URL": ""}, "without APP_DATA_REGISTRY_URL"},
		"relay setting without id":  {map[string]string{"APP_DATA_CLIENT_ID": ""}, "APP_DATA_CLIENT_ID is required"},
		"two secrets":               {map[string]string{"APP_DATA_CLIENT_SECRET_FILE": "/run/secrets/app-data-client"}, "not both"}, //nolint:gosec // G101: a synthetic test fixture, not a credential
		"no secret":                 {map[string]string{"APP_DATA_CLIENT_SECRET": ""}, "needs a secret"},
		"unreadable secret file":    {map[string]string{"APP_DATA_CLIENT_SECRET": "", "APP_DATA_CLIENT_SECRET_FILE": "/nope"}, "could not be read"},
		"plain http hub":            {map[string]string{"APP_DATA_HUB_TOKEN_URL": "http://hub.invalid/token"}, "APP_DATA_HUB_TOKEN_URL must be"}, //nolint:gosec // G101: a synthetic test fixture, not a credential
		"no resource":               {map[string]string{"APP_DATA_EXCHANGE_RESOURCE": ""}, "APP_DATA_EXCHANGE_RESOURCE must be"},
		"a scope setting":           {map[string]string{"APP_DATA_EXCHANGE_SCOPE": "AppDataRead AppsRead"}, "not a setting"},
		"max age over token life":   {map[string]string{"APP_DATA_STREAM_MAX_AGE_MS": "900001"}, "APP_DATA_STREAM_MAX_AGE_MS must be an integer"},
		"not a number":              {map[string]string{"APP_DATA_MAX_STREAMS": "many"}, "APP_DATA_MAX_STREAMS must be an integer"},
		"zero streams":              {map[string]string{"APP_DATA_MAX_STREAMS": "0"}, "APP_DATA_MAX_STREAMS must be an integer"},
		"over the adapter's token":  {map[string]string{"APP_DATA_MAX_STREAMS_PER_TOKEN": "51"}, "APP_DATA_MAX_STREAMS_PER_TOKEN must be an integer"},
		"per token over total":      {map[string]string{"APP_DATA_MAX_STREAMS": "2", "APP_DATA_MAX_STREAMS_PER_TOKEN": "3"}, "at most APP_DATA_MAX_STREAMS"},
		"age under idle":            {map[string]string{"APP_DATA_STREAM_IDLE_TTL_MS": "600000", "APP_DATA_STREAM_MAX_AGE_MS": "599999"}, "at least APP_DATA_STREAM_IDLE_TTL_MS"},
		"wait not under deadline":   {map[string]string{"APP_DATA_LIVE_WAIT_MS": "4000", "APP_DATA_REQUEST_DEADLINE_MS": "4000"}, "less than APP_DATA_REQUEST_DEADLINE_MS"},
		"tiny byte bound":           {map[string]string{"APP_DATA_MAX_BYTES_PER_STREAM": "100"}, "APP_DATA_MAX_BYTES_PER_STREAM must be"},
		"block exchange not a bool": {map[string]string{"APP_DATA_BLOCK_EXCHANGE": "yes"}, "APP_DATA_BLOCK_EXCHANGE must be true, 1, false or 0"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			kv := map[string]string{}
			for k, v := range base {
				kv[k] = v
			}
			for k, v := range tc.set {
				kv[k] = v
			}
			c, err := load(kv)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %+v, %v; want an error containing %q", c, err, tc.want)
			}
			// No error ever carries a secret.
			if strings.Contains(err.Error(), "SECRET-") {
				t.Fatalf("an error carries the secret: %v", err)
			}
		})
	}
}

func TestTheFullRelayConfigLoads(t *testing.T) {
	c, err := load(relayEnv())
	if err != nil {
		t.Fatal(err)
	}
	if c.Relay == nil || c.Relay.ClientSecret != "ENV-SECRET-4d7e" {
		t.Fatalf("%+v", c.Relay)
	}
}

// The block exchange is off unless set on, and on needs the registry path: a flag that could not
// take effect fails the start rather than reading as on.
func TestTheBlockExchangeFlag(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "true": true, "1": true} {
		kv := relayEnv()
		kv["APP_DATA_BLOCK_EXCHANGE"] = v
		if want {
			kv["APP_DATA_BLOCK_JWKS_URL"] = "https://site.invalid/api/v1/block-tokens/jwks"
		}
		c, err := load(kv)
		if err != nil || c.BlockExchange != want {
			t.Errorf("%q: %+v, %v; want BlockExchange %v", v, c, err, want)
		}
	}
	c, err := load(map[string]string{"APP_DATA_REST_URL": "https://site.invalid", "APP_DATA_BLOCK_EXCHANGE": "true"})
	if err == nil || !strings.Contains(err.Error(), "APP_DATA_BLOCK_EXCHANGE needs the registry path") {
		t.Fatalf("got %+v, %v; want the registry path required", c, err)
	}
}

// The block exchange needs the site's JWKS (block tokens are verified here before the hub is asked),
// and the JWKS setting means nothing without the exchange.
func TestTheBlockJWKSURL(t *testing.T) {
	on := func(jwks string) (*Config, error) {
		kv := relayEnv()
		kv["APP_DATA_BLOCK_EXCHANGE"] = "true"
		kv["APP_DATA_BLOCK_JWKS_URL"] = jwks
		return load(kv)
	}
	if c, err := on("https://site.invalid/api/v1/block-tokens/jwks"); err != nil || c.BlockJWKSURL != "https://site.invalid/api/v1/block-tokens/jwks" {
		t.Fatalf("%+v, %v", c, err)
	}
	for jwks, want := range map[string]string{
		"":                              "needs APP_DATA_BLOCK_JWKS_URL",
		"http://site.invalid/jwks":      "APP_DATA_BLOCK_JWKS_URL must be an https URL",
		"https://site.invalid/jwks?x=1": "APP_DATA_BLOCK_JWKS_URL must be an https URL",
		"http://site.example.svc/jwks":  "",
	} {
		c, err := on(jwks)
		if want == "" {
			if err != nil {
				t.Errorf("%q: %v", jwks, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %+v, %v; want %q", jwks, c, err, want)
		}
	}
	kv := relayEnv()
	kv["APP_DATA_BLOCK_JWKS_URL"] = "https://site.invalid/api/v1/block-tokens/jwks"
	if c, err := load(kv); err == nil || !strings.Contains(err.Error(), "set both or neither") {
		t.Fatalf("got %+v, %v; want the JWKS refused without the exchange", c, err)
	}
}
