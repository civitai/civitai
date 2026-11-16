package main

import (
	"context"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
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
