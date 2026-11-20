package config

import (
	"strings"
	"testing"
	"time"
)

func env(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }

func TestDefaults(t *testing.T) {
	c, err := FromEnv(env(map[string]string{"APP_DATA_REST_URL": "https://site.invalid"}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":8080", RESTURL: "https://site.invalid", MaxStreams: 100, MaxStreamsPerToken: 4,
		IdleTTL: 5 * time.Minute, MaxAge: 30 * time.Minute, LiveWait: 1500 * time.Millisecond,
		RequestDeadline: 4 * time.Second, MaxRecords: 1000, MaxBytes: 2 << 20, RESTMaxInFlight: 64}
	if *c != want {
		t.Fatalf("got %+v\nwant %+v", *c, want)
	}
	if c.RegistryURL != "" {
		t.Fatal("the registry path must default to off")
	}
}

func TestEverySettingIsRead(t *testing.T) {
	c, err := FromEnv(env(map[string]string{
		"APP_DATA_ADDR": ":9", "APP_DATA_REST_URL": "http://site.ns.svc.cluster.local:3000",
		"APP_DATA_REGISTRY_URL": "https://registry.invalid", "APP_DATA_MAX_STREAMS": "7",
		"APP_DATA_MAX_STREAMS_PER_TOKEN": "3", "APP_DATA_STREAM_IDLE_TTL_MS": "2000",
		"APP_DATA_STREAM_MAX_AGE_MS": "9000", "APP_DATA_LIVE_WAIT_MS": "11",
		"APP_DATA_REQUEST_DEADLINE_MS": "130", "APP_DATA_MAX_RECORDS_PER_STREAM": "17",
		"APP_DATA_MAX_BYTES_PER_STREAM": "70000", "APP_DATA_REST_MAX_INFLIGHT": "5",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":9", RESTURL: "http://site.ns.svc.cluster.local:3000", RegistryURL: "https://registry.invalid",
		MaxStreams: 7, MaxStreamsPerToken: 3, IdleTTL: 2 * time.Second, MaxAge: 9 * time.Second,
		LiveWait: 11 * time.Millisecond, RequestDeadline: 130 * time.Millisecond, MaxRecords: 17, MaxBytes: 70000,
		RESTMaxInFlight: 5}
	if *c != want {
		t.Fatalf("got %+v\nwant %+v", *c, want)
	}
}

func TestInvalidSettingsFailTheStart(t *testing.T) {
	base := map[string]string{"APP_DATA_REST_URL": "https://site.invalid"}
	cases := map[string]struct {
		set  map[string]string
		want string
	}{
		"no REST url":              {map[string]string{"APP_DATA_REST_URL": ""}, "APP_DATA_REST_URL is required"},
		"plain http REST":          {map[string]string{"APP_DATA_REST_URL": "http://site.invalid"}, "APP_DATA_REST_URL must be"},
		"REST url with a query":    {map[string]string{"APP_DATA_REST_URL": "https://site.invalid?x=1"}, "APP_DATA_REST_URL must be"},
		"REST url with userinfo":   {map[string]string{"APP_DATA_REST_URL": "https://user@site.invalid"}, "APP_DATA_REST_URL must be"},
		"plain http registry":      {map[string]string{"APP_DATA_REGISTRY_URL": "http://registry.invalid"}, "APP_DATA_REGISTRY_URL must be"},
		"registry not a url":       {map[string]string{"APP_DATA_REGISTRY_URL": "registry"}, "APP_DATA_REGISTRY_URL must be"},
		"not a number":             {map[string]string{"APP_DATA_MAX_STREAMS": "many"}, "APP_DATA_MAX_STREAMS must be an integer"},
		"zero streams":             {map[string]string{"APP_DATA_MAX_STREAMS": "0"}, "APP_DATA_MAX_STREAMS must be an integer"},
		"over the adapter's token": {map[string]string{"APP_DATA_MAX_STREAMS_PER_TOKEN": "51"}, "APP_DATA_MAX_STREAMS_PER_TOKEN must be an integer"},
		"per token over total":     {map[string]string{"APP_DATA_MAX_STREAMS": "2", "APP_DATA_MAX_STREAMS_PER_TOKEN": "3"}, "at most APP_DATA_MAX_STREAMS"},
		"age under idle":           {map[string]string{"APP_DATA_STREAM_IDLE_TTL_MS": "60000", "APP_DATA_STREAM_MAX_AGE_MS": "59999"}, "at least APP_DATA_STREAM_IDLE_TTL_MS"},
		"wait not under deadline":  {map[string]string{"APP_DATA_LIVE_WAIT_MS": "4000", "APP_DATA_REQUEST_DEADLINE_MS": "4000"}, "less than APP_DATA_REQUEST_DEADLINE_MS"},
		"tiny byte bound":          {map[string]string{"APP_DATA_MAX_BYTES_PER_STREAM": "100"}, "APP_DATA_MAX_BYTES_PER_STREAM must be"},
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
			c, err := FromEnv(env(kv))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %+v, %v; want an error containing %q", c, err, tc.want)
			}
		})
	}
}
