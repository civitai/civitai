package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/cache"
	"github.com/civitai/civitai/apps/app-data-go/internal/config"
	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
)

// THE CACHE as main wires it: none, and no series, when unset; set, every hook in front of the router.
func TestNoCacheIsNoHookAndNoSeries(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := metrics.New(reg, func() (int, int, int, int) { return 0, 0, 0, 0 })
	store, err := openCache(&config.Config{}, m, reg)
	if err != nil || store != nil || m.CacheOps != nil {
		t.Fatalf("%v %v", store, err)
	}
}

func TestTheCacheIsWiredInFrontOfTheRouter(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := metrics.New(reg, func() (int, int, int, int) { return 0, 0, 0, 0 })
	// A closed port: the first operation fails, and the start never waited on it.
	cfg := &config.Config{Writes: true, MaxRecords: 7, Cache: &config.Cache{URL: "redis://127.0.0.1:1",
		Key: []byte(strings.Repeat("k", 32)), Timeout: 50 * time.Millisecond}}
	start := time.Now()
	store, err := openCache(cfg, m, reg)
	if err != nil || store == nil || time.Since(start) > time.Second {
		t.Fatalf("%v %v", store, err)
	}
	router := &exchange.Router{User: func(context.Context, string) (exchange.Token, error) {
		return exchange.Token{Access: "x", Expires: time.Now().Add(time.Hour)}, nil
	}, Blocks: &exchange.BlockCache{}}
	h := withCache(store, router, cfg, m)
	if h.exchange == nil || h.fresh == nil || h.forget == nil || h.snapshots == nil || h.overlays == nil || h.resumed == nil {
		t.Fatalf("a hook is missing: %+v", h)
	}
	if _, ok := router.Blocks.Shared.(*cache.Blocks); !ok {
		t.Fatal("the block cache has no shared store")
	}
	// 🔴 FAIL OPEN: valkey unreachable, the exchange is the router's.
	if tok, err := h.exchange(context.Background(), "civitai_tok"); err != nil || tok.Access != "x" {
		t.Fatalf("%+v %v", tok, err)
	}
	if v := testutil.ToFloat64(m.CacheOps.WithLabelValues("user", "get", "error")); v != 1 {
		t.Fatalf("the failed get was not counted: %v", v)
	}
	// Writes off: no overlays.
	cfg.Writes = false
	if withCache(store, &exchange.Router{}, cfg, m).overlays != nil {
		t.Fatal("overlays without the writes")
	}
}
