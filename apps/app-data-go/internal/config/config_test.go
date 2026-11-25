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
		RequestDeadline: 4 * time.Second, MaxRecords: 1000, MaxBytes: 2 << 20, RESTMaxInFlight: 64,
		LevelMaxStreams: 50, LevelMaxRecords: 3000, LevelMaxBytes: 16 << 20}
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
		"APP_DATA_LEVEL_MAX_STREAMS": "6", "APP_DATA_LEVEL_MAX_RECORDS": "2501", "APP_DATA_LEVEL_MAX_BYTES": "3000000",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":9", RESTURL: "http://site.ns.svc.cluster.local:3000", RegistryURL: "https://registry.invalid",
		MaxStreams: 7, MaxStreamsPerToken: 3, IdleTTL: 2 * time.Second, MaxAge: 9 * time.Second,
		LiveWait: 11 * time.Millisecond, RequestDeadline: 130 * time.Millisecond, MaxRecords: 17, MaxBytes: 70000,
		RESTMaxInFlight: 5, LevelMaxStreams: 6, LevelMaxRecords: 2501, LevelMaxBytes: 3_000_000}
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
		// A level stream's bound must exceed the app's own 2,000-row read, as the adapter's does.
		"level records at the app's read": {map[string]string{"APP_DATA_LEVEL_MAX_RECORDS": "2000"}, "APP_DATA_LEVEL_MAX_RECORDS must be an integer"},
		"level bytes under 1 MiB":         {map[string]string{"APP_DATA_LEVEL_MAX_BYTES": "1048575"}, "APP_DATA_LEVEL_MAX_BYTES must be an integer"},
		"no level streams":                {map[string]string{"APP_DATA_LEVEL_MAX_STREAMS": "0"}, "APP_DATA_LEVEL_MAX_STREAMS must be an integer"},
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

// signingKey is a synthetic key over the 32-byte minimum, distinct from every URL fixture.
const signingKey = "WRITES-KEY-5b0e-0123456789abcdefXYZ" //nolint:gosec // G101: a synthetic test fixture, not a credential

// writesEnv is the writes on with everything they need, and neither the registry path nor the hub.
func writesEnv() map[string]string {
	return map[string]string{
		"APP_DATA_REST_URL":           "https://rest-site.invalid",
		"APP_DATA_WRITES":             "true",
		"APP_DATA_WRITES_SIGNING_KEY": signingKey,
		"APP_DATA_BLOCK_JWKS_URL":     "https://site.invalid/api/v1/block-tokens/jwks",
	}
}

// Off by default: TestDefaults' whole-struct comparison pins Writes false and every write setting
// empty. On, the site defaults to the REST site and the timeout to 10 s; no registry is needed.
func TestTheWritesFlag(t *testing.T) {
	for _, v := range []string{"true", "1"} {
		kv := writesEnv()
		kv["APP_DATA_WRITES"] = v
		c, err := load(kv)
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if !c.Writes || c.WritesSigningKey != signingKey || c.WritesSiteURL != "https://rest-site.invalid" ||
			c.WritesTimeout != 10*time.Second || c.BlockJWKSURL != "https://site.invalid/api/v1/block-tokens/jwks" || c.RegistryURL != "" ||
			c.AdapterPoll != time.Minute {
			t.Fatalf("%q: %+v", v, c)
		}
	}
	for _, v := range []string{"", "false", "0"} {
		kv := map[string]string{"APP_DATA_REST_URL": "https://rest-site.invalid", "APP_DATA_WRITES": v}
		if c, err := load(kv); err != nil || c.Writes || c.WritesTimeout != 0 || c.WritesSiteURL != "" || c.AdapterPoll != 0 {
			t.Fatalf("%q: %+v, %v; want writes off", v, c, err)
		}
	}
	kv := writesEnv()
	kv["APP_DATA_WRITES_SITE_URL"] = "http://web.ns.svc.cluster.local:3000/prefix"
	kv["APP_DATA_WRITES_TIMEOUT_MS"] = "2500"
	kv["APP_DATA_WRITES_ADAPTER_POLL_SECONDS"] = "17"
	c, err := load(kv)
	if err != nil || c.WritesSiteURL != "http://web.ns.svc.cluster.local:3000/prefix" || c.WritesTimeout != 2500*time.Millisecond ||
		c.AdapterPoll != 17*time.Second {
		t.Fatalf("%+v, %v", c, err)
	}
}

// The forward timeout's cap is what keeps a drain inside the pod's termination: the longest forward
// plus the drain's margin, after the preStop pause, fits the grace period. 20000 is accepted and
// 20001 refused (TestInvalidWriteSettingsFailTheStart).
// Fails before this change: MaxWritesTimeout did not exist, and with the old 60000 cap 20001 loaded
// (`err == nil`).
func TestTheWritesTimeoutCapFitsTheDrain(t *testing.T) {
	if MaxWritesTimeout != 20*time.Second {
		t.Fatalf("MaxWritesTimeout %v, want 20s", MaxWritesTimeout)
	}
	if MaxWritesTimeout+ShutdownMargin+PreStopPause > TerminationGrace {
		t.Fatalf("%v + %v + %v exceeds the %v grace period", MaxWritesTimeout, ShutdownMargin, PreStopPause, TerminationGrace)
	}
	kv := writesEnv()
	kv["APP_DATA_WRITES_TIMEOUT_MS"] = "20000"
	if c, err := load(kv); err != nil || c.WritesTimeout != MaxWritesTimeout {
		t.Fatalf("20000: %+v, %v; want accepted", c, err)
	}
	kv["APP_DATA_WRITES_TIMEOUT_MS"] = "20001"
	if _, err := load(kv); err == nil {
		t.Fatal("20001 was accepted")
	}
}

// A write setting with the writes off does nothing: the start goes on, and the setting is named in a
// warning (never its value), so turning the writes off never needs the others removed first.
// Fails on the previous commit: there this load returned an error (`err != nil`).
func TestWriteSettingsWithTheWritesOffAreAWarningNotAFailure(t *testing.T) {
	for _, off := range []string{"", "false", "0"} {
		c, err := load(map[string]string{
			"APP_DATA_REST_URL": "https://rest-site.invalid", "APP_DATA_WRITES": off,
			"APP_DATA_WRITES_SIGNING_KEY": signingKey, "APP_DATA_WRITES_SITE_URL": "not even a url",
			"APP_DATA_WRITES_TIMEOUT_MS": "99999999", "APP_DATA_WRITES_ADAPTER_POLL_SECONDS": "-4",
		})
		if err != nil {
			t.Fatalf("%q: %v; want the start to go on", off, err)
		}
		if c.Writes || c.WritesSigningKey != "" || c.WritesSiteURL != "" || c.WritesTimeout != 0 || c.AdapterPoll != 0 {
			t.Fatalf("%q: %+v; want every write setting ignored", off, c)
		}
		w := c.Warnings()
		want := "APP_DATA_WRITES_ADAPTER_POLL_SECONDS,APP_DATA_WRITES_SIGNING_KEY,APP_DATA_WRITES_SITE_URL,APP_DATA_WRITES_TIMEOUT_MS set with APP_DATA_WRITES off: ignored"
		if len(w) != 1 || w[0] != want {
			t.Fatalf("%q: warnings %q, want [%q]", off, w, want)
		}
		if strings.Contains(w[0], "WRITES-KEY-") {
			t.Fatal("the warning carries the signing key")
		}
	}
	// One setting alone is named alone; none set is no warning.
	c, err := load(map[string]string{"APP_DATA_REST_URL": "https://rest-site.invalid", "APP_DATA_WRITES_TIMEOUT_MS": "5000"})
	if err != nil || len(c.Warnings()) != 1 || c.Warnings()[0] != "APP_DATA_WRITES_TIMEOUT_MS set with APP_DATA_WRITES off: ignored" {
		t.Fatalf("%+v, %v", c, err)
	}
	if c, err := load(map[string]string{"APP_DATA_REST_URL": "https://rest-site.invalid"}); err != nil || c.Warnings() != nil {
		t.Fatalf("%v, %v; want no warning", c.Warnings(), err)
	}
}

func TestInvalidWriteSettingsFailTheStart(t *testing.T) {
	cases := map[string]struct {
		set  map[string]string
		want string
	}{
		"not a bool":                {map[string]string{"APP_DATA_WRITES": "on"}, "APP_DATA_WRITES must be true, 1, false or 0"},
		"no signing key":            {map[string]string{"APP_DATA_WRITES_SIGNING_KEY": ""}, "needs APP_DATA_WRITES_SIGNING_KEY"},
		"short signing key":         {map[string]string{"APP_DATA_WRITES_SIGNING_KEY": "WRITES-KEY-short"}, "at least 32 bytes"},
		"no JWKS":                   {map[string]string{"APP_DATA_BLOCK_JWKS_URL": ""}, "APP_DATA_WRITES needs APP_DATA_BLOCK_JWKS_URL"},
		"plain http site":           {map[string]string{"APP_DATA_WRITES_SITE_URL": "http://site.invalid"}, "APP_DATA_WRITES_SITE_URL must be"},
		"site with a query":         {map[string]string{"APP_DATA_WRITES_SITE_URL": "https://site.invalid?x=1"}, "APP_DATA_WRITES_SITE_URL must be"},
		"timeout under the hook's":  {map[string]string{"APP_DATA_WRITES_TIMEOUT_MS": "1999"}, "APP_DATA_WRITES_TIMEOUT_MS must be an integer from 2000 to 20000"},
		"timeout over the cap":      {map[string]string{"APP_DATA_WRITES_TIMEOUT_MS": "20001"}, "APP_DATA_WRITES_TIMEOUT_MS must be an integer from 2000 to 20000"},
		"no adapter poll":           {map[string]string{"APP_DATA_WRITES_ADAPTER_POLL_SECONDS": "0"}, "APP_DATA_WRITES_ADAPTER_POLL_SECONDS must be an integer from 1 to 600"},
		"adapter poll over 10 min":  {map[string]string{"APP_DATA_WRITES_ADAPTER_POLL_SECONDS": "601"}, "APP_DATA_WRITES_ADAPTER_POLL_SECONDS must be an integer from 1 to 600"},
		"JWKS with writes off only": {map[string]string{"APP_DATA_WRITES": "", "APP_DATA_WRITES_SIGNING_KEY": ""}, "set both or neither"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			kv := writesEnv()
			for k, v := range tc.set {
				kv[k] = v
			}
			c, err := load(kv)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %+v, %v; want an error containing %q", c, err, tc.want)
			}
			// No error ever carries the signing key.
			if strings.Contains(err.Error(), "WRITES-KEY-") {
				t.Fatalf("an error carries the signing key: %v", err)
			}
		})
	}
}

// Shared reads are on exactly when the writes and the registry path both are: the level streams need
// the relay client's service token, and the shared routes are the writes' (dark until then).
// Fails on origin/main: Config has no SharedReads (the test does not compile).
func TestSharedReadsNeedTheWritesAndTheRegistry(t *testing.T) {
	both := relayEnv()
	for k, v := range writesEnv() {
		if k != "APP_DATA_REST_URL" {
			both[k] = v
		}
	}
	writesOnly := writesEnv()
	registryOnly := relayEnv()
	for name, tc := range map[string]struct {
		kv   map[string]string
		want bool
	}{"writes and registry": {both, true}, "writes alone": {writesOnly, false}, "registry alone": {registryOnly, false}} {
		c, err := load(tc.kv)
		if err != nil || c.SharedReads != tc.want {
			t.Errorf("%s: SharedReads %v (%v), want %v", name, c != nil && c.SharedReads, err, tc.want)
		}
	}
}
