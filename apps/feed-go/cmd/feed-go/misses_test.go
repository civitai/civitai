package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The deployment's miss computation follows the config: none with FEED_GO_COMPUTE_MISSES off; write-back
// and the frame mirror as set; the primary handed to the lookups only with write-back on; the tag-ids
// gate over the blocked-tag list and addons it is handed.
func TestMissCompute(t *testing.T) {
	primary := &testkit.DB{}
	r := testkit.NewRedis()
	r.SetString("ns:"+feed.BlockedTagsKey, []byte(`[{"id":9101,"name":"blocked"}]`))
	blocked := &feed.BlockedTags{Cache: r, Prefix: "ns:"}
	addons := func(context.Context) []browsing.Addon {
		return []browsing.Addon{{Type: "all", ExcludedTagIDs: []int{9102}}}
	}
	if c := missCompute(&config.Config{ComputeMisses: false, CacheWriteBack: true}, primary, nil, blocked, addons); c != nil {
		t.Fatalf("compute off = %+v, want nil (misses fall back)", c)
	}
	n := 0
	c := missCompute(&config.Config{ComputeMisses: true, FrameCacheNegative: true}, primary, func(string, string, int) { n++ }, blocked, addons)
	if c == nil || c.WriteBack || !c.FrameNegative || c.Primary != nil || c.Observe == nil || c.TagGate == nil {
		t.Fatalf("defaults = %+v, want no write-back, the frame mirror, no primary, an observer, a tag gate", c)
	}
	c.Observe("x", "computed", 1)
	if n != 1 {
		t.Fatal("observer not wired")
	}
	gate, err := c.TagGate(context.Background())
	if err != nil {
		t.Fatalf("tag gate: %v", err)
	}
	if !gate[9101] || !gate[9102] {
		t.Fatalf("tag gate %v, want the blocked tag 9101 and the addon's 9102", gate)
	}
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: true}, primary, nil, blocked, addons)
	if !c.WriteBack || c.Primary != primary {
		t.Fatalf("write-back = %+v, want the primary handed over", c)
	}
}

// The metric-hash misses get a ClickHouse reader only when one is configured; a URL the reader
// refuses is an error that names neither the URL nor the credentials, and no reader (feed-go still
// starts and those misses fall back).
func TestMetricsReader(t *testing.T) {
	if r, err := metricsReader(&config.Config{}, nil); r != nil || err != nil {
		t.Fatalf("unconfigured = %v, %v; want no reader, no error", r, err)
	}
	r, err := metricsReader(&config.Config{ClickHouseURL: "https://ch.example.test:8443", ClickHouseUsername: "u", ClickHouseMaxInFlight: 2}, nil)
	if err != nil || r == nil {
		t.Fatalf("configured = %v, %v; want a reader", r, err)
	}
	for _, bad := range []string{"ch.example.test:8443", "https://user:secret-pw@ch.example.test", "ftp://ch.example.test", "http://%zz"} {
		r, err := metricsReader(&config.Config{ClickHouseURL: bad, ClickHouseUsername: "u"}, nil)
		if r != nil || err == nil {
			t.Fatalf("%q = %v, %v; want no reader and an error", bad, r, err)
		}
		if msg := err.Error(); strings.Contains(msg, "secret-pw") || strings.Contains(msg, "ch.example.test") {
			t.Fatalf("%q: the error %q names the URL", bad, msg)
		}
	}
}

// loadConfig is config.Load over the required variables plus env (every ClickHouse variable, the
// app's and feed-go's, unset unless env sets it).
func loadConfig(t *testing.T, env map[string]string) *config.Config {
	t.Helper()
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for _, k := range []string{"FEED_GO_COMPUTE_MISSES", "FEED_GO_CACHE_WRITEBACK", "FEED_GO_CLICKHOUSE_TIMEOUT_MS",
		"FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT", "FEED_GO_REQUEST_BUDGET_MS", "CLICKHOUSE_HOST", "CLICKHOUSE_USERNAME",
		"CLICKHOUSE_PASSWORD", "FEED_GO_CLICKHOUSE_HOST", "FEED_GO_CLICKHOUSE_USERNAME", "FEED_GO_CLICKHOUSE_PASSWORD"} {
		t.Setenv(k, env[k])
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// The app's ClickHouse login, which the shared app config puts in this service's environment, never
// builds a reader; feed-go's own variables do.
func TestMetricsReaderIgnoresTheAppLogin(t *testing.T) {
	app := map[string]string{"CLICKHOUSE_HOST": "https://app-ch.example.test:8443", "CLICKHOUSE_USERNAME": "app-writer", "CLICKHOUSE_PASSWORD": "app-pw"}
	if r, err := metricsReader(loadConfig(t, app), nil); r != nil || err != nil {
		t.Fatalf("the app's variables only = %v, %v; want no reader", r, err)
	}
	own := map[string]string{"FEED_GO_CLICKHOUSE_HOST": "https://ch.example.test:8443", "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader", "FEED_GO_CLICKHOUSE_PASSWORD": "feed-go-pw"}
	if r, err := metricsReader(loadConfig(t, own), nil); r == nil || err != nil {
		t.Fatalf("feed-go's variables = %v, %v; want a reader", r, err)
	}
}

// What run() wires (attachMetricsReader over config.Load): with only the app's ClickHouse variables
// the miss computation gets no reader (metric-hash misses then fall back `metrics-miss`,
// hydrate.TestMetricsMissOnlyTheMisses); with feed-go's own, its reader reads feed-go's endpoint with
// feed-go's login and never the app's, under a bound held below Node's 3 s budget (hydrate's
// metricsTimeout) even when FEED_GO_CLICKHOUSE_TIMEOUT_MS and FEED_GO_REQUEST_BUDGET_MS are far above
// it.
func TestAttachMetricsReader(t *testing.T) {
	type seen struct{ user, pass string }
	var mu sync.Mutex
	server := func(hits *[]seen) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, p, _ := r.BasicAuth()
			mu.Lock()
			*hits = append(*hits, seen{u, p})
			mu.Unlock()
			_, _ = w.Write([]byte("{\"entityId\":32,\"metricType\":\"Like\",\"value\":4}\n"))
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	var appHits, ownHits []seen
	appSrv, ownSrv := server(&appHits), server(&ownHits)
	app := map[string]string{"CLICKHOUSE_HOST": appSrv.URL, "CLICKHOUSE_USERNAME": "app-writer", "CLICKHOUSE_PASSWORD": "app-pw"}
	compute := func(cfg *config.Config) *hydrate.MissCompute {
		c := missCompute(cfg, &testkit.DB{}, nil, &feed.BlockedTags{Cache: testkit.NewRedis()}, nil)
		if c == nil {
			t.Fatal("no miss computation")
		}
		return c
	}

	cfg := loadConfig(t, app)
	c := compute(cfg)
	if err := attachMetricsReader(cfg, c, nil); err != nil || c.ClickHouse != nil {
		t.Fatalf("the app's variables only: reader %v, %v; want none", c.ClickHouse, err)
	}

	env := map[string]string{"FEED_GO_CLICKHOUSE_HOST": ownSrv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader",
		"FEED_GO_CLICKHOUSE_PASSWORD": "feed-go-pw", "FEED_GO_CLICKHOUSE_TIMEOUT_MS": "10000", "FEED_GO_REQUEST_BUDGET_MS": "60000"}
	for k, v := range app {
		env[k] = v
	}
	cfg = loadConfig(t, env)
	c = compute(cfg)
	if err := attachMetricsReader(cfg, c, nil); err != nil || c.ClickHouse == nil {
		t.Fatalf("feed-go's variables: reader %v, %v; want one", c.ClickHouse, err)
	}
	if c.MetricsTimeout != 10*time.Second {
		t.Fatalf("MetricsTimeout %v, want FEED_GO_CLICKHOUSE_TIMEOUT_MS (10s; the lookup holds it under Node's budget)", c.MetricsTimeout)
	}
	if _, err := c.ClickHouse.Query(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(appHits) != 0 || !reflect.DeepEqual(ownHits, []seen{{"feed-go-reader", "feed-go-pw"}}) {
		t.Fatalf("app endpoint hit %v, own endpoint hit %v; want only the own endpoint, with feed-go's login", appHits, ownHits)
	}
}

// countingTracer is a chread.Tracer that counts the calls it sees.
type countingTracer struct {
	mu           sync.Mutex
	starts, ends int
	rows         int
}

func (c *countingTracer) QueryStart(ctx context.Context, _ string) context.Context {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.starts++
	return ctx
}

func (c *countingTracer) QueryEnd(_ context.Context, rows int, _ error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ends++
	c.rows += rows
}

var _ chread.Tracer = (*countingTracer)(nil)

// The tracer run() hands attachMetricsReader (tracing.ClickHouseTracer when tracing is on) is the one
// the miss computation's reader calls on every read.
func TestAttachMetricsReaderTracesItsReads(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{\"entityId\":32,\"metricType\":\"Like\",\"value\":4}\n{\"entityId\":33,\"metricType\":\"Cry\",\"value\":2}\n"))
	}))
	t.Cleanup(srv.Close)
	cfg := loadConfig(t, map[string]string{"FEED_GO_CLICKHOUSE_HOST": srv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader"})
	c := missCompute(cfg, &testkit.DB{}, nil, &feed.BlockedTags{Cache: testkit.NewRedis()}, nil)
	if c == nil {
		t.Fatal("no miss computation")
	}
	tr := &countingTracer{}
	if err := attachMetricsReader(cfg, c, tr); err != nil || c.ClickHouse == nil {
		t.Fatalf("reader %v, %v; want one", c.ClickHouse, err)
	}
	if _, err := c.ClickHouse.Query(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatal(err)
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if tr.starts != 1 || tr.ends != 1 || tr.rows != 2 {
		t.Fatalf("tracer saw %d starts, %d ends, %d rows; want 1, 1, 2", tr.starts, tr.ends, tr.rows)
	}
}
