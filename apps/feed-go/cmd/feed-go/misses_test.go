package main

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The deployment's miss computation follows the config: none with FEED_GO_COMPUTE_MISSES off; write-back
// and the frame mirror as set; the primary handed to the lookups only with write-back on.
func TestMissCompute(t *testing.T) {
	primary := &testkit.DB{}
	if c := missCompute(&config.Config{ComputeMisses: false, CacheWriteBack: true}, primary, nil); c != nil {
		t.Fatalf("compute off = %+v, want nil (misses fall back)", c)
	}
	n := 0
	c := missCompute(&config.Config{ComputeMisses: true, FrameCacheNegative: true}, primary, func(string, string, int) { n++ })
	if c == nil || c.WriteBack || !c.FrameNegative || c.Primary != nil || c.Observe == nil {
		t.Fatalf("defaults = %+v, want no write-back, the frame mirror, no primary, an observer", c)
	}
	c.Observe("x", "computed", 1)
	if n != 1 {
		t.Fatal("observer not wired")
	}
	c = missCompute(&config.Config{ComputeMisses: true, CacheWriteBack: true}, primary, nil)
	if !c.WriteBack || c.Primary != primary {
		t.Fatalf("write-back = %+v, want the primary handed over", c)
	}
}
