//go:build integration

package hydrate

// Sources.Presence (the Go-first probe's cache check) against the real Redis Cluster, over the same
// page integPage seeds for Sources.Page (page_integration_test.go): the keys span every shard, and
// EXISTS on the metric hashes goes out in the same cluster pipeline as the GETs.

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// snapshot is every seeded key's value (GET for packed entries, HGETALL for the metric hashes).
func snapshot(t *testing.T, e *integEnv, keys []string) map[string]any {
	t.Helper()
	ctx := integtest.Ctx(t)
	out := map[string]any{}
	for _, k := range keys {
		typ, err := e.c.Type(ctx, k).Result()
		if err != nil {
			t.Fatal(err)
		}
		switch typ {
		case "hash":
			out[k] = e.c.HGetAll(ctx, k).Val()
		default:
			out[k] = e.c.Get(ctx, k).Val()
		}
	}
	return out
}

func TestIntegrationPresence(t *testing.T) {
	e := integSetup(t, true)
	req, keys := integPage(t, e)
	before := snapshot(t, e, keys)

	cluster, _, _ := countPipelines(t, e.c)
	got, err := e.src.Presence(integtest.Ctx(t), req)
	if err != nil {
		t.Fatal(err)
	}
	// integPage's doc: U2's basic user is a debounce marker, U2's profile picture and I4's thumbnail
	// are absent, and of the five cosmetics the entries name C2 and C5 are absent. Every other cache
	// answers every id (notFound markers and stale entries are answers).
	want := map[string]int{CacheBasicUsers: 1, CacheProfilePictures: 1, CacheThumbnails: 1, CacheCosmetics: 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if n := cluster.n.Load(); n != 2 {
		t.Errorf("%d cluster pipelines, want 2 (stage 1, stage 2)", n)
	}
	if after := snapshot(t, e, keys); !reflect.DeepEqual(after, before) {
		t.Fatalf("Presence changed the cache:\n before %v\n after  %v", before, after)
	}

	// Positive control for EXISTS on the cluster: one metric hash gone is one metrics miss, and a
	// debounce marker on a tag-ids key is a tag-ids miss.
	integtest.Del(t, e.c, metricHashKey(ipI3))
	e.put(t, KeyTagIDs, ipI1, integtest.O("debounce", true))
	got, err = e.src.Presence(integtest.Ctx(t), req)
	if err != nil {
		t.Fatal(err)
	}
	want[CacheMetrics], want[CacheTagIDs] = 1, 1
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after removing a hash: misses %v, want %v", got, want)
	}
}
