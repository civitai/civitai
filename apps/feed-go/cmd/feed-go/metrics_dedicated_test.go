package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

type chLogin struct{ user, pass string }

// chServer is a ClickHouse HTTP endpoint that records the login of every query (after delay).
func chServer(t *testing.T, delay time.Duration) (*httptest.Server, func() []chLogin) {
	var mu sync.Mutex
	var hits []chLogin
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, _ := r.BasicAuth()
		mu.Lock()
		hits = append(hits, chLogin{u, p})
		mu.Unlock()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-release:
				return
			}
		}
		_, _ = w.Write([]byte("{\"entityId\":32,\"metricType\":\"Like\",\"value\":4}\n"))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	return srv, func() []chLogin {
		mu.Lock()
		defer mu.Unlock()
		return append([]chLogin(nil), hits...)
	}
}

func dedicatedCompute(t *testing.T, cfg *config.Config) *hydrate.MissCompute {
	t.Helper()
	c := missCompute(cfg, &testkit.DB{}, nil, &feed.BlockedTags{Cache: testkit.NewRedis()}, nil)
	if c == nil {
		t.Fatal("no miss computation")
	}
	return c
}

// Credential isolation: the dedicated reader reads the dedicated endpoint with the dedicated login
// only (an unset password is sent empty, never feed-go's or the app's), and the shared reader keeps
// feed-go's own endpoint and login. Without CLICKHOUSE_METRICS_* there is no dedicated reader, and
// without feed-go's own reader the dedicated one is not attached (it never turns the computation on).
func TestAttachDedicatedMetricsReader(t *testing.T) {
	appSrv, appHits := chServer(t, 0)
	ownSrv, ownHits := chServer(t, 0)
	metricsSrv, metricsHits := chServer(t, 0)
	app := map[string]string{"CLICKHOUSE_HOST": appSrv.URL, "CLICKHOUSE_USERNAME": "app-writer", "CLICKHOUSE_PASSWORD": "app-pw"}
	own := map[string]string{"FEED_GO_CLICKHOUSE_HOST": ownSrv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader", "FEED_GO_CLICKHOUSE_PASSWORD": "feed-go-pw"}
	dedicated := map[string]string{"CLICKHOUSE_METRICS_HOST": metricsSrv.URL, "CLICKHOUSE_METRICS_USERNAME": "metrics-reader"}
	merge := func(ms ...map[string]string) map[string]string {
		out := map[string]string{}
		for _, m := range ms {
			for k, v := range m {
				out[k] = v
			}
		}
		return out
	}

	cfg := loadConfig(t, merge(app, own))
	c := dedicatedCompute(t, cfg)
	if err := attachMetricsReader(cfg, c, nil); err != nil || c.ClickHouse == nil || c.MetricsClickHouse != nil {
		t.Fatalf("no CLICKHOUSE_METRICS_*: shared %v dedicated %v, %v; want only the shared reader", c.ClickHouse, c.MetricsClickHouse, err)
	}

	cfg = loadConfig(t, merge(app, dedicated))
	c = dedicatedCompute(t, cfg)
	if err := attachMetricsReader(cfg, c, nil); err != nil || c.ClickHouse != nil || c.MetricsClickHouse != nil {
		t.Fatalf("dedicated without feed-go's reader: shared %v dedicated %v, %v; want neither", c.ClickHouse, c.MetricsClickHouse, err)
	}

	for _, pass := range []string{"", "metrics-pw"} {
		env := merge(app, own, dedicated)
		env["CLICKHOUSE_METRICS_PASSWORD"] = pass
		cfg = loadConfig(t, env)
		c = dedicatedCompute(t, cfg)
		if err := attachMetricsReader(cfg, c, nil); err != nil || c.ClickHouse == nil || c.MetricsClickHouse == nil {
			t.Fatalf("both configured: shared %v dedicated %v, %v; want both", c.ClickHouse, c.MetricsClickHouse, err)
		}
		before, ownBefore := len(metricsHits()), len(ownHits())
		if _, err := c.MetricsClickHouse.Query(context.Background(), "SELECT 1", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := c.ClickHouse.Query(context.Background(), "SELECT 1", nil); err != nil {
			t.Fatal(err)
		}
		if got := metricsHits()[before:]; !reflect.DeepEqual(got, []chLogin{{"metrics-reader", pass}}) {
			t.Fatalf("password %q: dedicated endpoint saw %v, want only the dedicated login", pass, got)
		}
		if got := ownHits()[ownBefore:]; !reflect.DeepEqual(got, []chLogin{{"feed-go-reader", "feed-go-pw"}}) {
			t.Fatalf("shared endpoint saw %v, want feed-go's login", got)
		}
	}
	if n := len(appHits()); n != 0 {
		t.Fatalf("the app's endpoint got %d queries, want none", n)
	}
}

// A bad CLICKHOUSE_METRICS_HOST (here: a login in the URL) is reported as the DEDICATED reader's
// error, naming the dedicated reader's variables; the shared reader is still attached and serves.
func TestDedicatedMetricsReaderBadURL(t *testing.T) {
	ownSrv, _ := chServer(t, 0)
	withLogin := (&url.URL{Scheme: "https", User: url.UserPassword("u", "p"), Host: "metrics-ch.example.test:8443"}).String()
	cfg := loadConfig(t, map[string]string{"FEED_GO_CLICKHOUSE_HOST": ownSrv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader",
		"CLICKHOUSE_METRICS_HOST": withLogin, "CLICKHOUSE_METRICS_USERNAME": "metrics-reader"})
	c := dedicatedCompute(t, cfg)
	err := attachMetricsReader(cfg, c, nil)
	var dedicated errDedicatedReader
	if !errors.As(err, &dedicated) {
		t.Fatalf("err %v, want the dedicated reader's error", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "CLICKHOUSE_METRICS_USERNAME / CLICKHOUSE_METRICS_PASSWORD") || strings.Contains(msg, "FEED_GO_") {
		t.Fatalf("message %q, want the dedicated reader's variables named, not feed-go's", msg)
	}
	if c.ClickHouse == nil || c.MetricsClickHouse != nil {
		t.Fatalf("shared %v dedicated %v; want the shared reader only", c.ClickHouse, c.MetricsClickHouse)
	}
}

// CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS bounds each request to the dedicated server, whatever the
// caller's context allows (a write-back populate's own bound is a minute).
func TestDedicatedMetricsReaderRequestTimeout(t *testing.T) {
	ownSrv, _ := chServer(t, 0)
	metricsSrv, _ := chServer(t, time.Minute)
	cfg := loadConfig(t, map[string]string{"FEED_GO_CLICKHOUSE_HOST": ownSrv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader",
		"CLICKHOUSE_METRICS_HOST": metricsSrv.URL, "CLICKHOUSE_METRICS_USERNAME": "metrics-reader",
		"CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS": "150"})
	c := dedicatedCompute(t, cfg)
	if err := attachMetricsReader(cfg, c, nil); err != nil || c.MetricsClickHouse == nil {
		t.Fatalf("dedicated %v, %v", c.MetricsClickHouse, err)
	}
	start := time.Now()
	_, err := c.MetricsClickHouse.Query(context.Background(), "SELECT 1", nil)
	if el := time.Since(start); err == nil || el > 5*time.Second {
		t.Fatalf("hung dedicated server: err %v after %v; want an error near 150ms", err, el)
	}
}

// fliptServer answers /evaluate/v1/boolean for one flag, whose value the test sets, and records the
// flag keys and environments it was asked for.
func fliptServer(t *testing.T) (*httptest.Server, func(bool), func() []string) {
	var mu sync.Mutex
	on := false
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			FlagKey  string `json:"flagKey"`
			EntityID string `json:"entityId"`
		}
		_ = json.Unmarshal(body, &req)
		mu.Lock()
		asked = append(asked, r.URL.Path+" "+req.FlagKey+" "+req.EntityID+" "+r.Header.Get("X-Flipt-Environment")+" "+r.Header.Get("Authorization"))
		v := on
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"enabled": v})
	}))
	t.Cleanup(srv.Close)
	return srv, func(v bool) {
			mu.Lock()
			on = v
			mu.Unlock()
		}, func() []string {
			mu.Lock()
			defer mu.Unlock()
			return append([]string(nil), asked...)
		}
}

// The flag the populate's reader choice follows is read from Flipt (FLIPT_URL, FLIPT_FETCHER_SECRET,
// FLIPT_ENVIRONMENT) under the Node app's key, and a flip reaches MetricsClickHouseOn without a
// restart. Without a dedicated reader, or without FLIPT_URL, nothing is read and the choice stays
// shared.
func TestAttachMetricsSwitch(t *testing.T) {
	ownSrv, _ := chServer(t, 0)
	metricsSrv, _ := chServer(t, 0)
	fsrv, setFlag, asked := fliptServer(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	base := map[string]string{"FEED_GO_CLICKHOUSE_HOST": ownSrv.URL, "FEED_GO_CLICKHOUSE_USERNAME": "feed-go-reader",
		"FLIPT_URL": fsrv.URL, "FLIPT_FETCHER_SECRET": "flipt-tok"}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	cfg := loadConfig(t, base)
	c := dedicatedCompute(t, cfg)
	_ = attachMetricsReader(cfg, c, nil)
	if sw, err := attachMetricsSwitch(ctx, cfg, c, log); sw != nil || err != nil || c.MetricsClickHouseOn != nil {
		t.Fatalf("no dedicated reader: switch %v, %v; want none", sw, err)
	}

	env := map[string]string{"CLICKHOUSE_METRICS_HOST": metricsSrv.URL, "CLICKHOUSE_METRICS_USERNAME": "metrics-reader"}
	for k, v := range base {
		env[k] = v
	}
	env["FLIPT_URL"] = ""
	cfg = loadConfig(t, env)
	c = dedicatedCompute(t, cfg)
	_ = attachMetricsReader(cfg, c, nil)
	if sw, err := attachMetricsSwitch(ctx, cfg, c, log); sw != nil || err != nil || c.MetricsClickHouseOn != nil {
		t.Fatalf("no FLIPT_URL: switch %v, %v; want none", sw, err)
	}
	if n := len(asked()); n != 0 {
		t.Fatalf("Flipt asked %d times, want none", n)
	}

	env["FLIPT_URL"] = fsrv.URL
	cfg = loadConfig(t, env)
	c = dedicatedCompute(t, cfg)
	_ = attachMetricsReader(cfg, c, nil)
	sw, err := attachMetricsSwitch(ctx, cfg, c, log)
	if sw == nil || err != nil || c.MetricsClickHouseOn == nil {
		t.Fatalf("switch %v, %v; want one", sw, err)
	}
	// The first read runs in the background; refresh by hand for each step.
	for _, v := range []bool{false, true, false} {
		setFlag(v)
		sw.Refresh(ctx)
		if got := c.MetricsClickHouseOn(); got != v {
			t.Fatalf("flag %v: MetricsClickHouseOn %v", v, got)
		}
	}
	if got := asked(); len(got) == 0 || got[0] != "/evaluate/v1/boolean image-metrics-dedicated-clickhouse global civitai-app Bearer flipt-tok" {
		t.Fatalf("Flipt asked %v, want the flag image-metrics-dedicated-clickhouse for the global entity", got)
	}
}
