package server

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
)

// goldenImageMetricTypes is ENTITY_METRIC_TYPES.Image (event-engine-common/types/metric-types.ts): the
// metric types the ClickHouse populate selects.
var goldenImageMetricTypes = []string{"Cry", "Heart", "Laugh", "Like", "Collection", "commentCount", "tippedAmount", "tippedCount"}

// goldenClickHouse answers the metrics populate with the totals a fixture's metric hashes hold (the
// rows `sum(total) … HAVING value > 0` returns when ClickHouse's totals are what the watcher-fed hash
// shows), for the ids each query names.
type goldenClickHouse struct {
	mu      sync.Mutex
	totals  map[int]map[string]int
	queries int
}

func newGoldenClickHouse(redis map[string]goldenRedisEntry) *goldenClickHouse {
	g := &goldenClickHouse{totals: map[int]map[string]int{}}
	for k, e := range redis {
		idStr, ok := strings.CutPrefix(k, "metrics:Image:")
		if !ok || e.Hash == nil {
			continue
		}
		id, err := strconv.Atoi(idStr)
		if err != nil {
			continue
		}
		g.totals[id] = map[string]int{}
		for f, v := range e.Hash {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && slices.Contains(goldenImageMetricTypes, f) {
				g.totals[id][f] = n
			}
		}
	}
	return g
}

func (g *goldenClickHouse) Query(_ context.Context, sql string, _ []chread.Setting) ([]map[string]any, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.queries++
	_, rest, _ := strings.Cut(sql, "AND entityId IN (")
	list, _, _ := strings.Cut(rest, ")")
	var rows []map[string]any
	for _, s := range strings.Split(list, ",") {
		id, err := strconv.Atoi(s)
		if err != nil {
			continue
		}
		for _, f := range goldenImageMetricTypes {
			if n := g.totals[id][f]; n > 0 {
				rows = append(rows, map[string]any{"entityId": json.Number(s), "metricType": f, "value": json.Number(strconv.Itoa(n))})
			}
		}
	}
	return rows, nil
}

// withoutMetricHashes is fx with every metric hash removed (its images' metrics all cold).
func withoutMetricHashes(fx *goldenFixture) (*goldenFixture, int) {
	cold := *fx
	cold.Redis = map[string]goldenRedisEntry{}
	n := 0
	for k, v := range fx.Redis {
		if strings.HasPrefix(k, "metrics:Image:") {
			n++
			continue
		}
		cold.Redis[k] = v
	}
	return &cold, n
}

// goldenSources is the golden env's hydration sources.
func goldenSources(t *testing.T, env *goldenEnv) *hydrate.Sources {
	t.Helper()
	s, ok := env.server.Deps.Hydrator.(*hydrate.Sources)
	if !ok || s.Compute == nil {
		t.Fatal("the golden hydrator is not a computing *hydrate.Sources")
	}
	return s
}

// With every metric hash of a served golden request cold, Go computes them from ClickHouse and
// answers exactly what Node answered with them warm (Node's MetricService answers a cold image with
// ClickHouse's totals, and getImageMetricsObject shapes them as it shapes the hash: the same stats,
// statsUnknown false), writing nothing with write-back off. Without the reader the same request
// falls back `metrics-miss`.
func TestGoldenMetricsComputedFromClickHouse(t *testing.T) {
	compared := 0
	for _, gc := range goldenProbeCases {
		if !gc.presence {
			continue // model.getAll reads no image metric hash
		}
		for _, path := range goldenFiles(t, gc.dir, gc.min) {
			fx := goldenLoad(t, path)
			if fx.Expect.Fallback != "" {
				continue
			}
			cold, n := withoutMetricHashes(fx)
			if n == 0 {
				continue
			}
			t.Run(gc.dir+"/"+fx.Name, func(t *testing.T) {
				env := goldenSetup(t, cold)
				ch := newGoldenClickHouse(fx.Redis)
				goldenSources(t, env).Compute.ClickHouse = ch
				before := goldenCacheState(env.cache)
				ctx := context.Background()
				r, err := gc.request(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
				if err != nil {
					t.Fatal(err)
				}
				c, err := gc.serve(env.server, ctx, r)
				if err != nil {
					t.Fatalf("serve with the metric hashes cold: %v", err)
				}
				rep, err := shadow.Compare(c.payload, fx.Expect.Envelope)
				if err != nil {
					t.Fatalf("compare: %v", err)
				}
				goldenReport(t, rep, c.payload)
				if ch.queries == 0 {
					t.Fatal("served without a ClickHouse read: the computed path was not exercised")
				}
				if after := goldenCacheState(env.cache); !reflect.DeepEqual(after, before) {
					t.Fatalf("write-back off wrote to the cache:\n before %v\n after  %v", before, after)
				}
				compared++

				// The control: no reader, the same cold request falls back.
				plain := goldenSetup(t, cold)
				r, err = gc.request(ctx, ShadowRequest{Input: fx.Request.Input, Headers: plain.headers})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := gc.serve(plain.server, ctx, r); fallback.Reason(err) != "metrics-miss" {
					t.Fatalf("no reader: %v, want the metrics-miss fallback", err)
				}
			})
		}
	}
	// Positive control: the served fixtures holding metric hashes (18 as-posts, 16 infinite on
	// 2026-11-16) all reach the comparison.
	if compared < 34 {
		t.Fatalf("%d golden requests compared, want at least 34", compared)
	}
}

// The Go-first probe on a request whose metric hashes are cold: with a ClickHouse reader the miss is
// one Go computes, so the request is would_serve with the metrics cache reported and one read per
// page that missed; without one it is would_miss on metrics.
func TestProbeComputedMetricsMiss(t *testing.T) {
	reached := map[string]int{}
	for _, gc := range goldenProbeCases {
		if !gc.presence {
			continue
		}
		for _, path := range goldenFiles(t, gc.dir, gc.min) {
			fx := goldenLoad(t, path)
			if fx.Expect.Fallback != "" {
				continue
			}
			cold, n := withoutMetricHashes(fx)
			if n == 0 {
				continue
			}
			t.Run(gc.dir+"/"+fx.Name, func(t *testing.T) {
				for _, withReader := range []bool{true, false} {
					env := goldenSetup(t, cold)
					ch := newGoldenClickHouse(fx.Redis)
					if withReader {
						goldenSources(t, env).Compute.ClickHouse = ch
					}
					checker := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
					rec := &hydrate.PresenceProbe{Checker: checker}
					_, err := probes[gc.procedure].run(env.server, context.Background(), ProbeRequest{Input: cold.Request.Input, Headers: env.headers}, rec)
					result, missed := classifyProbe(err, rec.Misses(), rec.Raced(), checker.MissReason)
					if !slices.Contains(missed, hydrate.CacheMetrics) {
						t.Fatalf("reader %v: missed %v, want metrics reported", withReader, missed)
					}
					if withReader {
						if result != ProbeWouldServe || rec.DBReads()[hydrate.CacheMetrics] == 0 {
							t.Fatalf("with a reader: %s, reads %v (err %v); want would_serve with the metrics reads counted", result, rec.DBReads(), err)
						}
						if ch.queries != 0 {
							t.Fatalf("the probe queried ClickHouse %d times", ch.queries)
						}
					} else if result != ProbeWouldMiss {
						t.Fatalf("without a reader: %s, want would_miss", result)
					}
					reached[gc.dir+"/"+result]++
				}
			})
		}
	}
	for _, k := range []string{"as-posts/" + ProbeWouldServe, "as-posts/" + ProbeWouldMiss, "infinite/" + ProbeWouldServe, "infinite/" + ProbeWouldMiss} {
		if reached[k] == 0 {
			t.Errorf("no fixture reached %s: %v", k, reached)
		}
	}
}
