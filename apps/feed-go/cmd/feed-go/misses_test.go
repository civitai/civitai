package main

import (
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// The deployment's miss computation follows the config: none with FEED_GO_COMPUTE_MISSES off, write-back
// and the frame mirror as set, and a ClickHouse populate only when ClickHouse is configured.
func TestMissCompute(t *testing.T) {
	if c := missCompute(&config.Config{ComputeMisses: false, CacheWriteBack: true}, nil); c != nil {
		t.Fatalf("compute off = %+v, want nil (misses fall back)", c)
	}
	n := 0
	c := missCompute(&config.Config{ComputeMisses: true, FrameCacheNegative: true}, func(string, string, int) { n++ })
	if c == nil || c.WriteBack || !c.FrameNegative || c.Metrics != nil || c.Observe == nil {
		t.Fatalf("defaults = %+v, want no write-back, the frame mirror, no metrics source, an observer", c)
	}
	c.Observe("x", "computed", 1)
	if n != 1 {
		t.Fatal("observer not wired")
	}
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: true, ClickHouseURL: "http://ch.example.test",
		ClickHouseUser: "u", ClickHouseTimeout: 2 * time.Second, ClickHouseMaxConcurrency: 3}, nil)
	ch, ok := c.Metrics.(*hydrate.ClickHouse)
	if !c.WriteBack || !ok || ch.URL != "http://ch.example.test" || ch.User != "u" || ch.Timeout != 2*time.Second {
		t.Fatalf("with clickhouse = %+v / %+v", c, ch)
	}
}
