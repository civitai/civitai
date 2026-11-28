package v1models

import (
	"context"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// modelDataRoutes answers dataForModelsCache's lookup queries (hydrate's sqlModelDataVersions and
// sqlModelDataHashes) with the rows the test world's cached record for model 5001 was written from:
// the record newTestWorld caches, as the replica returns it (int4 columns as int32, text[] as
// []string). It counts the version reads.
func modelDataRoutes(versionReads *int) []testkit.Route {
	return []testkit.Route{
		{Match: `LEFT JOIN "GenerationCoverage"`, Rows: func(args []any) (*testkit.Rows, error) {
			*versionReads++
			cols := []string{"id", "index", "modelId", "name", "earlyAccessTimeFrame", "baseModel", "baseModelType",
				"createdAt", "trainingStatus", "publishedAt", "status", "flags", "availability", "nsfwLevel", "description",
				"trainedWords", "vaeId", "covered", "coveredNext"}
			ids, _ := args[0].([]int)
			var vals [][]any
			for _, id := range ids {
				if id == 5001 {
					vals = append(vals, []any{int32(6001), int32(0), int32(5001), "v1", int32(0), "SDXL 1.0", nil,
						nil, nil, nil, "Published", int32(32), "Public", int32(1), "d", []string{}, nil, true, false})
				}
			}
			return testkit.NewRows(cols, vals...), nil
		}},
		{Match: `FROM "ModelHash"`, Rows: func([]any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"modelId", "hash"}), nil
		}},
	}
}

// The cached record of newTestWorld written as the lookup writes it: the version columns in the
// lookup's order (baseModelType, createdAt, trainingStatus, publishedAt, vaeId null here).
func lookupShapedRecord() superjson.Object {
	ver := meta("id", int64(6001), "index", int64(0), "name", "v1", "earlyAccessTimeFrame", int64(0), "baseModel", "SDXL 1.0",
		"baseModelType", nil, "createdAt", nil, "trainingStatus", nil, "publishedAt", nil,
		"status", "Published", "flags", int64(32), "availability", "Public", "nsfwLevel", int64(1), "description", "d",
		"trainedWords", []any{}, "vaeId", nil, "covered", true, "coveredNext", false)
	return append(meta("modelId", int64(5001), "hashes", []any{}, "tags", []any{}, "versions", []any{ver}),
		superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)})
}

// serveDataMissList answers the list `limit=5` over w, the model-data lookup answered (and its
// version reads counted) by modelDataRoutes: computeMisses is FEED_GO_COMPUTE_MISSES (the switch and
// the computation it wires), serveDataMiss FEED_GO_V1_MODELS_SERVE_DATA_MISS, serving a public
// request rather than a shadow sample.
func serveDataMissList(t *testing.T, w *testWorld, serving, serveDataMiss, computeMisses bool) (*Answer, int, error) {
	t.Helper()
	d := w.deps(t)
	reads := 0
	d.Sources.Replica = &testkit.DB{Routes: append(modelDataRoutes(&reads), w.db.Routes...)}
	d.Config.ComputeMisses = computeMisses
	if computeMisses {
		d.Sources.Compute = &hydrate.MissCompute{Now: func() time.Time { return testNow }}
	}
	d.Config.ServeDataMiss = serveDataMiss
	ans, err := ServeList(context.Background(), d, d.Sources, ListRequest{
		Query: "limit=5", Path: "/api/v1/models", Host: "site.example.test", Serving: serving,
	})
	return ans, reads, err
}

// missWorld is the test world with model 5001's model-data entry missing.
func missWorld() *testWorld {
	w := newTestWorld()
	w.entries[KeyDataForModel+":5001"] = nil
	return w
}

// FEED_GO_V1_MODELS_SERVE_DATA_MISS: a model-data miss on the public list is answered from the
// cache's own lookup, with the bytes a cache hit of the same record gives; off, or with no miss
// computation, or with the model's lag flag set and model-data not written back (no primary read for
// it: TestServeDataMissWrittenBackAndLagAware), it falls back as before. `[id]` computes it on a
// public request too, and a shadow `[id]` sample without the miss computation still falls back.
func TestServeListComputesModelDataMiss(t *testing.T) {
	serve := func(w *testWorld, on, compute bool) (*Answer, int, error) {
		return serveDataMissList(t, w, true, on, compute)
	}

	// The control: the record cached, in the lookup's shape.
	hit := newTestWorld()
	hit.entries[KeyDataForModel+":5001"] = lookupShapedRecord()
	want, reads, err := serve(hit, true, true)
	if err != nil || reads != 0 {
		t.Fatalf("hit: %v (%s), %d lookups", err, reason(err), reads)
	}
	wantBody, _ := superjson.Plain(want.Body)

	miss := missWorld
	got, reads, err := serve(miss(), true, true)
	if err != nil {
		t.Fatalf("computed miss: %v (%s)", err, reason(err))
	}
	gotBody, _ := superjson.Plain(got.Body)
	if string(gotBody) != string(wantBody) || reads != 1 {
		t.Errorf("computed miss (%d lookups):\n got  %s\n want %s", reads, gotBody, wantBody)
	}

	for _, c := range []struct {
		name        string
		on, compute bool
		edit        func(*testWorld)
	}{
		{"switch off", false, true, nil},
		{"no miss computation", true, false, nil},
		{"the model's lag flag set", true, true, func(w *testWorld) { w.raw["lag-helper:model:5001"] = "1" }},
	} {
		w := miss()
		if c.edit != nil {
			c.edit(w)
		}
		_, reads, err := serve(w, c.on, c.compute)
		if reason(err) != "v1-models-data-miss" || reads != 0 {
			t.Errorf("%s: %q (%v), %d lookups; want v1-models-data-miss and none", c.name, reason(err), err, reads)
		}
	}

	// `[id]`: a shadow sample without the miss computation falls back; a public request with the
	// switch (and the computation) is computed.
	w := miss()
	d := w.deps(t)
	d.Sources.Compute = &hydrate.MissCompute{Now: func() time.Time { return testNow }}
	d.Config.ServeDataMiss = true
	d.Config.ResponseCacheTTL = 0
	if _, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001", TrainingDataSQL: TrainingDataSQLHash}); reason(err) != "v1-models-data-miss" {
		t.Errorf("[id] sample, no miss computation: %q (%v), want v1-models-data-miss", reason(err), err)
	}
	w = miss()
	d = w.deps(t)
	idReads := 0
	d.Sources.Replica = &testkit.DB{Routes: append(modelDataRoutes(&idReads), w.db.Routes...)}
	d.Sources.Compute = &hydrate.MissCompute{Now: func() time.Time { return testNow }}
	d.Config.ComputeMisses, d.Config.ServeDataMiss, d.Config.ResponseCacheTTL = true, true, 0
	if _, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001", Serving: true}); err != nil || idReads != 1 {
		t.Errorf("[id] public, switch on: %v (%s), %d lookups; want served from one lookup", err, reason(err), idReads)
	}
}

// The two switches: a shadow sample computes a model-data miss whenever FEED_GO_COMPUTE_MISSES is
// on, so the shadow compares the computed answer before it is served; a public request serves one
// only with FEED_GO_V1_MODELS_SERVE_DATA_MISS too. Every other combination falls back.
func TestListDataMissShadowAndServeSwitches(t *testing.T) {
	for _, c := range []struct {
		name                                  string
		serving, serveDataMiss, computeMisses bool
		computed                              bool
	}{
		{"sample, serve switch off, compute on", false, false, true, true},
		{"sample, serve switch on, compute on", false, true, true, true},
		{"sample, compute off", false, false, false, false},
		{"public, serve switch off, compute on", true, false, true, false},
		{"public, serve switch on, compute on", true, true, true, true},
		{"public, serve switch on, compute off", true, true, false, false},
	} {
		ans, reads, err := serveDataMissList(t, missWorld(), c.serving, c.serveDataMiss, c.computeMisses)
		if c.computed {
			if err != nil || reads != 1 || ans == nil || ans.Trivial {
				t.Errorf("%s: %v (%s), %d lookups; want the computed page and one lookup", c.name, err, reason(err), reads)
			}
			continue
		}
		if reason(err) != "v1-models-data-miss" || reads != 0 {
			t.Errorf("%s: %q (%v), %d lookups; want v1-models-data-miss and none", c.name, reason(err), err, reads)
		}
	}
}
