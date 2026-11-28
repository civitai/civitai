package v1models

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The cache values the Node app writes on these misses, packed by msgpackr's module-level `pack`
// (testdata/golden/pack.mjs's importDep('msgpackr'), `pack({...}).toString('hex')`), cachedAt testNow:
//
//	modelTagCache, model 5001:      { modelId: 5001, tagIds: [11], cachedAt }
//	dataForModelsCache, model 5001: { modelId: 5001, hashes: [], tags: [], versions: [<modelDataRoutes' row>], cachedAt }
const (
	nodeModelTags5001 = "de0003a76d6f64656c4964cd1389a6746167496473910ba86361636865644174d6ff6a2fe940"
	nodeModelData5001 = "de0005a76d6f64656c4964cd1389a668617368657390a47461677390a876657273696f6e7391de0012a26964cd1771a5696e64657800a46e616d65a27631b46561726c7941636365737354696d654672616d6500a9626173654d6f64656ca85344584c20312e30ad626173654d6f64656c54797065c0a9637265617465644174c0ae747261696e696e67537461747573c0ab7075626c69736865644174c0a6737461747573a95075626c6973686564a5666c61677320ac617661696c6162696c697479a65075626c6963a96e7366774c6576656c01ab6465736372697074696f6ea164ac747261696e6564576f72647390a57661654964c0a7636f7665726564c3ab636f76657265644e657874c2a86361636865644174d6ff6a2fe940"
)

func nodeBytes(t *testing.T, h string) string {
	t.Helper()
	b, err := hex.DecodeString(h)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// modelTagsRoute answers modelTagCache's lookup (TagsOnModels) with model 5001's one row, tag 11, and
// counts the reads.
func modelTagsRoute(reads *int) testkit.Route {
	return testkit.Route{Match: `FROM "TagsOnModels" WHERE "modelId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
		*reads++
		var vals [][]any
		for _, id := range args[0].([]int) {
			if id == 5001 {
				vals = append(vals, []any{int32(5001), int32(11)})
			}
		}
		return testkit.NewRows([]string{"modelId", "tagId"}, vals...), nil
	}}
}

// missEnv is one request over w with the miss computation on (FEED_GO_COMPUTE_MISSES): sw sets the
// v1 models switches, writeBack the caches FEED_GO_CACHE_WRITEBACK lists, primary the primary's
// routes (nil: no primary).
type missEnv struct {
	w                                       *testWorld
	d                                       *Deps
	tagReads, dataReads, primaryDataReads   int
	showcaseReplica, showcasePrimary        [][]int
	showcaseRowOnReplica, showcaseRowOnPrim bool
}

func newMissEnv(t *testing.T, w *testWorld, sw func(*Config), writeBack hydrate.WriteSet, withPrimary bool) *missEnv {
	t.Helper()
	e := &missEnv{w: w}
	e.d = w.deps(t)
	showcase := func(bound *[][]int, row *bool) testkit.Route {
		return testkit.Route{Match: `FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" = ANY($1::int[])`,
			Rows: func(args []any) (*testkit.Rows, error) {
				ids, _ := args[0].([]int)
				*bound = append(*bound, ids)
				if *row {
					return testkit.NewRows([]string{"?column?"}, []any{int32(1)}), nil
				}
				return testkit.NewRows([]string{"?column?"}), nil
			}}
	}
	routes := append(modelDataRoutes(&e.dataReads), modelTagsRoute(&e.tagReads), showcase(&e.showcaseReplica, &e.showcaseRowOnReplica))
	w.db.Routes = append(routes, w.db.Routes...)
	e.d.Sources.Replica = w.db
	e.d.Config.ComputeMisses = true
	e.d.Sources.Compute = &hydrate.MissCompute{Now: func() time.Time { return testNow }, WriteBack: writeBack}
	if withPrimary {
		e.d.Sources.Compute.Primary = &testkit.DB{Routes: append(modelDataRoutes(&e.primaryDataReads),
			showcase(&e.showcasePrimary, &e.showcaseRowOnPrim))}
	}
	if sw != nil {
		sw(&e.d.Config)
	}
	return e
}

func (e *missEnv) list(serving bool) (*Answer, error) {
	return ServeList(context.Background(), e.d, e.d.Sources, ListRequest{
		Query: "limit=5", Path: "/api/v1/models", Host: "site.example.test", Serving: serving,
	})
}

func (e *missEnv) detail(serving bool) (*Answer, error) {
	return ServeDetail(context.Background(), e.d, DetailRequest{ID: "5001", Serving: serving, TrainingDataSQL: TrainingDataSQLHash})
}

func plain(t *testing.T, a *Answer) string {
	t.Helper()
	b, err := superjson.Plain(a.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func allMisses(c *Config) {
	c.ServeDataMiss, c.ServeTagsMiss, c.ServeTagNameStale, c.ServeShowcaseMiss = true, true, true, true
}

// FEED_GO_V1_MODELS_SERVE_TAGS_MISS: a model-tags miss on a public request (either route) is answered
// with modelTagCache's lookup, and, with model-tags written back, written as the Node app writes it:
// the bytes msgpackr writes for the same record (nodeModelTags5001), a day's EX. The written entry
// and Node's own decode to the same answer: a request reading Node's bytes gives the computed one's
// body. Off, it falls back as before, with no lookup.
func TestServeComputesModelTagsMiss(t *testing.T) {
	const key = KeyModelTags + ":5001"
	tagsOn := func(c *Config) { c.ServeTagsMiss = true }
	for _, route := range []string{"list", "detail"} {
		serve := func(e *missEnv) (*Answer, error) {
			if route == "list" {
				return e.list(true)
			}
			return e.detail(true)
		}
		// The control: Node's own bytes in the cache.
		hit := newTestWorld()
		hit.entries[key] = nil
		hit.raw[key] = nodeBytes(t, nodeModelTags5001)
		he := newMissEnv(t, hit, tagsOn, hydrate.WriteSet{hydrate.MissModelTags: true}, false)
		want, err := serve(he)
		if err != nil || he.tagReads != 0 {
			t.Fatalf("%s: Node's entry: %v (%s), %d lookups", route, err, reason(err), he.tagReads)
		}

		miss := newTestWorld()
		miss.entries[key] = nil
		me := newMissEnv(t, miss, tagsOn, hydrate.WriteSet{hydrate.MissModelTags: true}, false)
		got, err := serve(me)
		if err != nil {
			t.Fatalf("%s: computed: %v (%s)", route, err, reason(err))
		}
		if plain(t, got) != plain(t, want) || me.tagReads != 1 {
			t.Errorf("%s: computed (%d lookups):\n got  %s\n want %s", route, me.tagReads, plain(t, got), plain(t, want))
		}
		written, ok := miss.cache.String(key)
		if !ok || hex.EncodeToString(written) != nodeModelTags5001 {
			t.Errorf("%s: written %x (%v), want Node's %s", route, written, ok, nodeModelTags5001)
		}
		if ex := miss.cache.Expiry(key); ex != 24*time.Hour {
			t.Errorf("%s: written EX %v, want 24h", route, ex)
		}
	}

	for _, c := range []struct {
		name    string
		edit    func(*testWorld)
		sw      func(*Config)
		serving bool
		reason  string
		reads   int
		written bool
	}{
		{"switch off", nil, nil, true, "v1-models-tags-miss", 0, false},
		{"a bust's debounce marker: looked up, never written", func(w *testWorld) {
			w.entries[key] = meta("modelId", int64(5001), "debounce", true)
		}, tagsOn, true, "", 1, false},
		{"the GET fails", func(w *testWorld) { w.failKey = key }, tagsOn, true, "v1-models-tags-read-failed", 0, false},
		{"a shadow sample computes, writes nothing", nil, nil, false, "", 1, false},
	} {
		w := newTestWorld()
		w.entries[key] = nil
		if c.edit != nil {
			c.edit(w)
		}
		e := newMissEnv(t, w, c.sw, hydrate.WriteSet{hydrate.MissModelTags: true}, false)
		_, err := e.list(c.serving)
		_, isWritten := w.cache.String(key)
		if c.name == "a bust's debounce marker: looked up, never written" {
			b, _ := w.cache.String(key)
			isWritten = hex.EncodeToString(b) == nodeModelTags5001
		}
		if reason(err) != c.reason || e.tagReads != c.reads || isWritten != c.written {
			t.Errorf("%s: %q (%v), %d lookups, written %v; want %q, %d, %v", c.name, reason(err), err, e.tagReads, isWritten,
				c.reason, c.reads, c.written)
		}
	}
}

// FEED_GO_V1_MODELS_SERVE_DATA_MISS with model-data written back: a public request's model-data miss
// is written as the Node app writes it (nodeModelData5001, a day's EX), and a missed model whose lag
// flag is set is looked up on the PRIMARY (Node's lag-aware lookup) instead of falling back. Without
// write-back the flagged model still falls back (TestServeListComputesModelDataMiss), as it does
// with no primary to read.
func TestServeDataMissWrittenBackAndLagAware(t *testing.T) {
	const key = KeyDataForModel + ":5001"
	dataOn := func(c *Config) { c.ServeDataMiss = true }
	writes := hydrate.WriteSet{hydrate.MissModelData: true}

	// The control: Node's bytes in the cache.
	hit := newTestWorld()
	hit.entries[key] = nil
	hit.raw[key] = nodeBytes(t, nodeModelData5001)
	he := newMissEnv(t, hit, dataOn, writes, true)
	want, err := he.list(true)
	if err != nil || he.dataReads+he.primaryDataReads != 0 {
		t.Fatalf("Node's entry: %v (%s), %d+%d lookups", err, reason(err), he.dataReads, he.primaryDataReads)
	}

	for _, c := range []struct {
		name                  string
		flagged               bool
		replicaReads, primary int
	}{
		{"clean flag: the replica", false, 1, 0},
		{"flag set: the primary", true, 0, 1},
	} {
		w := newTestWorld()
		w.entries[key] = nil
		if c.flagged {
			w.raw["lag-helper:model:5001"] = "1"
		}
		e := newMissEnv(t, w, dataOn, writes, true)
		got, err := e.list(true)
		if err != nil {
			t.Fatalf("%s: %v (%s)", c.name, err, reason(err))
		}
		if plain(t, got) != plain(t, want) || e.dataReads != c.replicaReads || e.primaryDataReads != c.primary {
			t.Errorf("%s: replica %d primary %d lookups (want %d, %d), body:\n got  %s\n want %s", c.name,
				e.dataReads, e.primaryDataReads, c.replicaReads, c.primary, plain(t, got), plain(t, want))
		}
		written, _ := w.cache.String(key)
		if hex.EncodeToString(written) != nodeModelData5001 || w.cache.Expiry(key) != 24*time.Hour {
			t.Errorf("%s: written %x EX %v, want Node's bytes and 24h", c.name, written, w.cache.Expiry(key))
		}
	}

	// A shadow sample, model-data written back and a primary configured: it writes nothing and never
	// reads the primary; a flagged model falls back, a clean one is computed on the replica.
	for _, c := range []struct {
		name    string
		flagged bool
		reason  string
		replica int
	}{
		{"shadow, flag set", true, "v1-models-data-miss", 0},
		{"shadow, clean flag", false, "", 1},
	} {
		w := newTestWorld()
		w.entries[key] = nil
		if c.flagged {
			w.raw["lag-helper:model:5001"] = "1"
		}
		e := newMissEnv(t, w, dataOn, writes, true)
		_, err := e.list(false)
		if reason(err) != c.reason || e.dataReads != c.replica || e.primaryDataReads != 0 || w.cache.Has(key) {
			t.Errorf("%s: %q (%v), replica %d primary %d, written %v; want %q, %d, 0, false", c.name, reason(err), err,
				e.dataReads, e.primaryDataReads, w.cache.Has(key), c.reason, c.replica)
		}
	}

	// `[id]` computes it too now (DetailRequest.Serving).
	w := newTestWorld()
	w.entries[key] = nil
	e := newMissEnv(t, w, dataOn, writes, true)
	if _, err := e.detail(true); err != nil || e.dataReads != 1 {
		t.Errorf("[id]: %v (%s), %d lookups; want served from one lookup", err, reason(err), e.dataReads)
	}
}

// FEED_GO_V1_MODELS_SERVE_TAG_NAME_STALE: a tag-name entry past its day is named by tagCache's lookup
// on the replica, as the Node reader that wins the revalidate lock names it, and nothing is written;
// off it falls back (`v1-models-tag-name-stale`); a shadow sample names it with the miss computation.
func TestServeTagNameStaleNamed(t *testing.T) {
	const key = KeyBasicTags + ":11"
	staleWorld := func() *testWorld {
		w := newTestWorld()
		o := w.entries[key].(superjson.Object)
		w.entries[key] = append(omit(o, "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-48 * time.Hour)})
		w.tagRows = map[int]string{11: "style-db"}
		return w
	}
	for _, c := range []struct {
		name    string
		sw      func(*Config)
		serving bool
		detail  bool
		reason  string
	}{
		{"list, switch on", func(c *Config) { c.ServeTagNameStale = true }, true, false, ""},
		{"detail, switch on", func(c *Config) { c.ServeTagNameStale = true }, true, true, ""},
		{"list, switch off", nil, true, false, "v1-models-tag-name-stale"},
		{"shadow sample", nil, false, true, ""},
	} {
		w := staleWorld()
		e := newMissEnv(t, w, c.sw, nil, false)
		before, _ := w.cache.String(key)
		var ans *Answer
		var err error
		if c.detail {
			ans, err = e.detail(c.serving)
		} else {
			ans, err = e.list(c.serving)
		}
		if reason(err) != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, reason(err), err, c.reason)
			continue
		}
		if c.reason != "" {
			if w.tagLookups != 0 {
				t.Errorf("%s: %d lookups on a fallback", c.name, w.tagLookups)
			}
			continue
		}
		after, _ := w.cache.String(key)
		if body := plain(t, ans); !strings.Contains(body, `"tags":["style-db"]`) || w.tagLookups != 1 || string(after) != string(before) {
			t.Errorf("%s: %d lookups, entry rewritten %v, body:\n%s", c.name, w.tagLookups, string(after) != string(before), body)
		}
	}
}

// FEED_GO_V1_MODELS_SERVE_SHOWCASE_MISS: a version-showcase miss Node's fetch looks up is decided as
// Node decides it: a bust's debounce marker on the replica, a lag-flagged version on the primary. Off,
// both fall back (`v1-models-showcase-miss`), as does a flagged version with no primary to read.
func TestServeShowcaseMissReadThrough(t *testing.T) {
	debounce := func(w *testWorld) { w.entries[showcaseKey6001] = meta("debounce", true) }
	flagged := func(w *testWorld) {
		w.entries[showcaseKey6001] = nil
		w.raw["lag-helper:modelVersion:6001"] = "1"
	}
	on := func(c *Config) { c.ServeShowcaseMiss = true }
	for _, c := range []struct {
		name              string
		edit              func(*testWorld)
		sw                func(*Config)
		primary, rowThere bool
		reason            string
		replica, prim     int
	}{
		{"debounce marker: the replica decides", debounce, on, true, false, "", 1, 0},
		{"debounce marker, a row: curated", debounce, on, true, true, "v1-models-curated-showcase", 1, 0},
		{"debounce marker, switch off", debounce, nil, true, false, "v1-models-showcase-miss", 0, 0},
		{"flagged: the primary decides", flagged, on, true, false, "", 0, 1},
		{"flagged, no primary", flagged, on, false, false, "v1-models-showcase-miss", 0, 0},
		{"flagged, switch off", flagged, nil, true, false, "v1-models-showcase-miss", 0, 0},
	} {
		for _, detail := range []bool{false, true} {
			w := newTestWorld()
			c.edit(w)
			e := newMissEnv(t, w, c.sw, nil, c.primary)
			e.showcaseRowOnReplica, e.showcaseRowOnPrim = c.rowThere, c.rowThere
			var err error
			if detail {
				_, err = e.detail(true)
			} else {
				_, err = e.list(true)
			}
			if reason(err) != c.reason || len(e.showcaseReplica) != c.replica || len(e.showcasePrimary) != c.prim {
				t.Errorf("%s (detail %v): %q (%v), replica %v primary %v; want %q, %d, %d", c.name, detail, reason(err), err,
					e.showcaseReplica, e.showcasePrimary, c.reason, c.replica, c.prim)
			}
		}
	}
}

// Each switch serves its own miss only: a public request with every miss present at once and one
// switch on still falls back on the first miss it does not cover; all four on, it is served. A
// shadow sample computes all of them with the miss computation alone.
func TestV1ModelsMissSwitchesAreSeparate(t *testing.T) {
	allMissing := func() *testWorld {
		w := newTestWorld()
		w.entries[KeyDataForModel+":5001"] = nil
		w.entries[KeyModelTags+":5001"] = nil
		o := w.entries[KeyBasicTags+":11"].(superjson.Object)
		w.entries[KeyBasicTags+":11"] = append(omit(o, "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-48 * time.Hour)})
		w.entries[showcaseKey6001] = meta("debounce", true)
		w.tagRows = map[int]string{11: "style"}
		return w
	}
	for _, c := range []struct {
		name    string
		sw      func(*Config)
		serving bool
		reason  string
	}{
		{"data only", func(c *Config) { c.ServeDataMiss = true }, true, "v1-models-tags-miss"},
		{"data and tags", func(c *Config) { c.ServeDataMiss, c.ServeTagsMiss = true, true }, true, "v1-models-tag-name-stale"},
		{"all but showcase", func(c *Config) { c.ServeDataMiss, c.ServeTagsMiss, c.ServeTagNameStale = true, true, true }, true,
			"v1-models-showcase-miss"},
		{"all four", allMisses, true, ""},
		{"all four, no miss computation", func(c *Config) { allMisses(c); c.ComputeMisses = false }, true, "v1-models-data-miss"},
		{"shadow sample, no switch", nil, false, ""},
	} {
		e := newMissEnv(t, allMissing(), c.sw, nil, false)
		ans, err := e.list(c.serving)
		if reason(err) != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, reason(err), err, c.reason)
			continue
		}
		if c.reason == "" && (ans == nil || ans.Trivial || !strings.Contains(plain(t, ans), `"tags":["style"]`)) {
			t.Errorf("%s: answer %v", c.name, ans)
		}
	}
}
