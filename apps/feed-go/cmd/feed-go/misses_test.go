package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
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
	if c := missCompute(&config.Config{ComputeMisses: false, CacheWriteBack: hydrate.AllWrites()}, primary, nil, blocked, addons); c != nil {
		t.Fatalf("compute off = %+v, want nil (misses fall back)", c)
	}
	n := 0
	c := missCompute(&config.Config{ComputeMisses: true, FrameCacheNegative: true}, primary, func(string, string, int) { n++ }, blocked, addons)
	if c == nil || c.WriteBack.Any() || !c.FrameNegative || c.Primary != nil || c.Observe == nil || c.TagGate == nil {
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
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: hydrate.AllWrites()}, primary, nil, blocked, addons)
	if !c.WriteBack.Any() || c.Primary != primary {
		t.Fatalf("write-back = %+v, want the primary handed over", c)
	}
	// Only caches whose lookups read the replica: no primary handed over (none is opened either).
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: hydrate.WriteSet{hydrate.MissMetrics: true, hydrate.MissTagIDs: true}},
		primary, nil, blocked, addons)
	if !c.WriteBack[hydrate.MissMetrics] || c.WriteBack[hydrate.MissImageFrames] || c.Primary != nil {
		t.Fatalf("metrics,tag-ids = %+v, want those two written back and no primary", c)
	}
	// One that reads the primary: handed over.
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: hydrate.WriteSet{hydrate.MissModelData: true}}, primary, nil, blocked, addons)
	if c.Primary != primary {
		t.Fatalf("model-data = %+v, want the primary handed over", c)
	}
}

// run() opens the primary pool only with the miss computation on and a written-back cache whose
// lookup reads the primary: a replica-only allowlist (metrics,tag-ids, or every replica reader) never
// opens it; image-frames (or model-data) does; nothing listed, or the computation off, never.
// Fails on: the condition reverting to "any cache listed" (metrics,tag-ids would open it), or
// dropping the ComputeMisses term.
func TestOpensPrimary(t *testing.T) {
	for _, c := range []struct {
		compute bool
		set     hydrate.WriteSet
		want    bool
	}{
		{true, nil, false},
		{true, hydrate.WriteSet{hydrate.MissMetrics: true, hydrate.MissTagIDs: true}, false},
		{true, hydrate.WriteSet{hydrate.MissMetrics: true, hydrate.MissTagIDs: true, hydrate.MissUserCosmetics: true,
			hydrate.MissModelTags: true, hydrate.MissOfficialModels: true}, false},
		{true, hydrate.WriteSet{hydrate.MissImageFrames: true}, true},
		{true, hydrate.WriteSet{hydrate.MissMetrics: true, hydrate.MissModelData: true}, true},
		{false, hydrate.WriteSet{hydrate.MissImageFrames: true}, false},
	} {
		if got := opensPrimary(&config.Config{ComputeMisses: c.compute, CacheWriteBack: c.set}); got != c.want {
			t.Errorf("compute %v, %v: opens primary %v, want %v", c.compute, c.set.Names(), got, c.want)
		}
	}
}

// What run() wires for the cache writes: the counter (feed_go_cache_writes_total) and the write log
// on the miss computation, and the counter seeded at 0 for each written-back cache and result, and
// for no other cache. Fails if attachWriteObservers drops ObserveWrite or WriteLog, seeds every
// cache, or seeds none.
func TestAttachWriteObservers(t *testing.T) {
	attachWriteObservers(&config.Config{}, nil, nil, nil) // compute off: nothing to attach, no panic
	reg := prometheus.NewRegistry()
	m := server.NewMetrics(reg)
	c := &hydrate.MissCompute{}
	cfg := &config.Config{CacheWriteBack: hydrate.WriteSet{hydrate.MissMetrics: true, hydrate.MissImageFrames: true}, CacheWriteLogPerMinute: 7}
	attachWriteObservers(cfg, c, m, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if c.ObserveWrite == nil || c.WriteLog == nil || c.WriteLog.PerMinute != 7 {
		t.Fatalf("observers = %v, %+v; want the counter and a log at 7/min", c.ObserveWrite != nil, c.WriteLog)
	}
	want := map[string]float64{"image-frames/written": 0, "image-frames/nx_lost": 0, "image-frames/error": 0,
		"metrics/written": 0, "metrics/nx_lost": 0, "metrics/error": 0}
	if got := cacheWrites(t, reg); !reflect.DeepEqual(got, want) {
		t.Fatalf("seeded %v, want %v", got, want)
	}
	c.ObserveWrite("metrics", "written", 2)
	want["metrics/written"] = 2
	if got := cacheWrites(t, reg); !reflect.DeepEqual(got, want) {
		t.Fatalf("after 2 metrics writes %v, want %v", got, want)
	}
}

// cacheWrites is feed_go_cache_writes_total on reg, as "cache/result" -> value.
func cacheWrites(t *testing.T, reg *prometheus.Registry) map[string]float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]float64{}
	for _, mf := range families {
		if mf.GetName() != "feed_go_cache_writes_total" {
			continue
		}
		for _, s := range mf.GetMetric() {
			l := map[string]string{}
			for _, p := range s.GetLabel() {
				l[p.GetName()] = p.GetValue()
			}
			out[l["cache"]+"/"+l["result"]] = s.GetCounter().GetValue()
		}
	}
	return out
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
// app's, feed-go's and the dedicated metrics server's, and every Flipt variable, unset unless env
// sets it).
func loadConfig(t *testing.T, env map[string]string) *config.Config {
	t.Helper()
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for _, k := range []string{"FEED_GO_COMPUTE_MISSES", "FEED_GO_CACHE_WRITEBACK", "FEED_GO_CLICKHOUSE_TIMEOUT_MS",
		"FEED_GO_METRICS_LOCK_WAIT_MS", "FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT", "FEED_GO_REQUEST_BUDGET_MS", "CLICKHOUSE_HOST", "CLICKHOUSE_USERNAME",
		"CLICKHOUSE_PASSWORD", "FEED_GO_CLICKHOUSE_HOST", "FEED_GO_CLICKHOUSE_USERNAME", "FEED_GO_CLICKHOUSE_PASSWORD",
		"CLICKHOUSE_METRICS_HOST", "CLICKHOUSE_METRICS_USERNAME", "CLICKHOUSE_METRICS_PASSWORD", "CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS",
		"FLIPT_URL", "FLIPT_FETCHER_SECRET", "FLIPT_ENVIRONMENT", "FLIPT_DEPLOYMENT_ID"} {
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
		"FEED_GO_CLICKHOUSE_PASSWORD": "feed-go-pw", "FEED_GO_CLICKHOUSE_TIMEOUT_MS": "10000", "FEED_GO_REQUEST_BUDGET_MS": "60000",
		"FEED_GO_METRICS_LOCK_WAIT_MS": "750"}
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
	// Fails on: the lock-wait bound not handed over (0, the hydrate default) or handed the lookup's.
	if c.MetricsLockWait != 750*time.Millisecond {
		t.Fatalf("MetricsLockWait %v, want FEED_GO_METRICS_LOCK_WAIT_MS (750ms)", c.MetricsLockWait)
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

// What run() hands attachMetricsReader decides the tracing of the miss computation: with tracing on
// (a provider) the reader's reads are `clickhouse query` spans under the request's and the
// computation carries the provider's tracer (its wait spans); with it off (nil, run()'s tp when
// FEED_GO_OTEL_ENABLED is unset) neither, even under a recording request span.
func TestAttachMetricsReaderTracing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{\"entityId\":32,\"metricType\":\"Like\",\"value\":4}\n{\"entityId\":33,\"metricType\":\"Cry\",\"value\":2}\n"))
	}))
	t.Cleanup(srv.Close)
	rec := tracetest.NewSpanRecorder()
	sdk := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	tracer := sdk.Tracer("test")
	cfg := loadConfig(t, map[string]string{"FEED_GO_CLICKHOUSE_HOST": srv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader"})
	compute := func() *hydrate.MissCompute {
		c := missCompute(cfg, &testkit.DB{}, nil, &feed.BlockedTags{Cache: testkit.NewRedis()}, nil)
		if c == nil {
			t.Fatal("no miss computation")
		}
		return c
	}

	for _, on := range []bool{true, false} {
		rec.Reset()
		var tp *tracing.Provider
		if on {
			tp = &tracing.Provider{Tracer: tracer}
		}
		c := compute()
		if err := attachMetricsReader(cfg, c, tp); err != nil || c.ClickHouse == nil {
			t.Fatalf("tracing %v: reader %v, %v; want one", on, c.ClickHouse, err)
		}
		if (c.Tracer != nil) != on || (on && c.Tracer != tracer) {
			t.Fatalf("tracing %v: the computation's tracer is %v", on, c.Tracer)
		}
		ctx, parent := tracer.Start(context.Background(), "serve as-images")
		if rows, err := c.ClickHouse.Query(ctx, "SELECT 1", nil); err != nil || len(rows) != 2 {
			t.Fatalf("tracing %v: %d rows, %v", on, len(rows), err)
		}
		parent.End()
		var reads []string
		for _, s := range rec.Ended() {
			if s.Name() == "clickhouse query" && s.Parent().SpanID() == parent.SpanContext().SpanID() {
				reads = append(reads, s.Name())
			}
		}
		if want := map[bool]int{true: 1, false: 0}[on]; len(reads) != want || len(rec.Ended()) != want+1 {
			t.Fatalf("tracing %v: %d read spans under the request (%d spans in all), want %d", on, len(reads), len(rec.Ended()), want)
		}
	}
}
