package v1models

// Golden tests for GET /api/v1/models and /api/v1/models/[id]: each fixture under
// testdata/golden/v1-models is one request, the synthetic world it reads, and the answer the REAL
// Node handler gives over that world (src/server/__tests__/feed-go-v1-models.golden.test.ts holds the
// fixture to the Node code). Here the Go port reads the same world — the packed cache values under
// their real keys, the replica rows — and must produce the same bytes, and build the same model
// statement.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

const (
	goldenDir = "../../testdata/golden/v1-models"
	// The fixture count gen-v1-models.mjs writes: fewer found means the glob matched the wrong place.
	goldenMin = 38
)

type goldenEntry struct {
	Packed string  `json:"packed"`
	Raw    *string `json:"raw"`
}

type goldenFixture struct {
	Name   string `json:"name"`
	Now    string `json:"now"`
	Config struct {
		ImageLocation        string `json:"imageLocation"`
		BaseURL              string `json:"baseUrl"`
		CoverageNext         bool   `json:"coverageNext"`
		BaseModelFeedMetrics bool   `json:"baseModelFeedMetrics"`
		RegionRestricted     bool   `json:"regionRestricted"`
		// SERVER_DOMAIN_RED and its aliases, as the Node golden test sets them.
		ServerDomainRed        string `json:"serverDomainRed"`
		ServerDomainRedAliases string `json:"serverDomainRedAliases"`
		// ServeDataMiss is FEED_GO_V1_MODELS_SERVE_DATA_MISS (with the miss computation on): a fixture
		// whose `coldModelData` records are computed by dataForModelsCache's lookup.
		ServeDataMiss bool `json:"serveDataMiss"`
	} `json:"config"`
	Request struct {
		Path    string            `json:"path"`
		Query   string            `json:"query"`
		Headers map[string]string `json:"headers"`
	} `json:"request"`
	World    map[string]json.RawMessage `json:"world"`
	Redis    map[string]goldenEntry     `json:"redis"`
	SysRedis map[string]goldenEntry     `json:"sysRedis"`
	Expect   struct {
		Fallback string     `json:"fallback"`
		Body     *string    `json:"body"`
		SQL      *goldenSQL `json:"sql"`
		// TrainingDataSQL is trainingDataListing's statement, when Node sent one.
		TrainingDataSQL *goldenSQL `json:"trainingDataSql"`
		// Search is the text search's call, when Node made one.
		Search *goldenSearch `json:"search"`
	} `json:"expect"`
}

// goldenSearch is the search call Node's resolveModelSearchIds made: `index(index).search(q, params)`,
// params as JSON.stringify sent them.
type goldenSearch struct {
	Index  string         `json:"index"`
	Q      string         `json:"q"`
	Params map[string]any `json:"params"`
}

// same is nil when req is Node's call: the same index, text and request body.
func (g *goldenSearch) same(req SearchRequest) error {
	body, err := req.Body()
	if err != nil {
		return err
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		return err
	}
	q := got["q"]
	delete(got, "q")
	if req.Index != g.Index || q != g.Q || !reflect.DeepEqual(got, g.Params) {
		return fmt.Errorf("search call differs from Node's:\n go:   %s %v %v\n node: %s %q %v", req.Index, q, got, g.Index, g.Q, g.Params)
	}
	return nil
}

// goldenSearcher answers the fixture's text search from `world.search.hits` and records each call.
type goldenSearcher struct {
	hits []int
	reqs []SearchRequest
}

func (g *goldenSearcher) SearchModelIDs(_ context.Context, req SearchRequest) ([]int, error) {
	g.reqs = append(g.reqs, req)
	return g.hits, nil
}

type goldenSQL struct {
	Text   string            `json:"text"`
	Values []json.RawMessage `json:"values"`
}

// sameStatement is nil when the statement is the fixture's: the text whitespace-normalised (exact
// bytes when exact), and the values.
func (g *goldenSQL) sameStatement(what, sql string, args []any, exact bool) error {
	if exact && sql != g.Text {
		return fmt.Errorf("%s is not Node's text byte for byte:\n go:   %q\n node: %q", what, sql, g.Text)
	}
	if got, want := NormalizeSQL(sql), NormalizeSQL(g.Text); got != want {
		return fmt.Errorf("%s differs from Node's:\n go:   %s\n node: %s", what, got, want)
	}
	if len(args) != len(g.Values) {
		return fmt.Errorf("%s: %d values, Node binds %d", what, len(args), len(g.Values))
	}
	for i, a := range args {
		var want any
		_ = json.Unmarshal(g.Values[i], &want)
		if got := jsonArg(a); !reflect.DeepEqual(got, want) {
			return fmt.Errorf("%s value $%d: go %#v, node %#v", what, i+1, got, want)
		}
	}
	return nil
}

// revive turns the fixture's JSON-with-markers into the Go values a pgx row holds: `{"$date": …}` a
// time.Time, numbers float64, objects maps, arrays slices.
func revive(v any) any {
	switch t := v.(type) {
	case map[string]any:
		if d, ok := t["$date"].(string); ok && len(t) == 1 {
			tm, err := time.Parse(time.RFC3339Nano, d)
			if err != nil {
				panic(err)
			}
			return tm.UTC()
		}
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = revive(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = revive(x)
		}
		return out
	}
	return v
}

func (fx *goldenFixture) world(t *testing.T, key string, into any) {
	t.Helper()
	raw, ok := fx.World[key]
	if !ok {
		t.Fatalf("world has no %q", key)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("world %s: %v", key, err)
	}
}

func (fx *goldenFixture) rows(t *testing.T, key string) []map[string]any {
	t.Helper()
	var list []any
	fx.world(t, key, &list)
	out := make([]map[string]any, len(list))
	for i, x := range list {
		out[i], _ = revive(x).(map[string]any)
	}
	return out
}

func toRows(cols []string, maps []map[string]any) *testkit.Rows {
	data := make([][]any, len(maps))
	for i, m := range maps {
		row := make([]any, len(cols))
		for j, c := range cols {
			row[j] = m[c]
		}
		data[i] = row
	}
	return testkit.NewRows(cols, data...)
}

// argIDs reads a `= ANY($1::int[])` argument.
func argIDs(args []any) map[int]bool {
	out := map[int]bool{}
	if len(args) == 0 {
		return out
	}
	if ids, ok := args[0].([]int); ok {
		for _, id := range ids {
			out[id] = true
		}
	}
	return out
}

func filterRows(maps []map[string]any, col string, ids map[int]bool) []map[string]any {
	out := []map[string]any{}
	for _, m := range maps {
		if id, ok := intOf(m[col]); ok && ids[id] {
			out = append(out, m)
		}
	}
	return out
}

var modelColumns = []string{
	"id", "name", "sfwName", "coverImageId", "sfwCoverImageId", "description", "sfwDescription",
	"allowNoCredit", "allowCommercialUse", "allowDerivatives", "allowDifferentLicense", "type", "minor",
	"sfwOnly", "poi", "nsfw", "nsfwLevel", "status", "createdAt", "lastVersionAt", "publishedAt", "locked",
	"meta", "mode", "availability", "rank", "userId", "cursorId",
}

// jsonArg is a bound value as the Node fixture writes it (a Date as its ISO string, null for nil).
func jsonArg(v any) any {
	switch t := v.(type) {
	case time.Time:
		return superjson.FormatDate(t)
	case nil:
		return nil
	case int:
		return float64(t)
	case []int:
		out := make([]any, len(t))
		for i, n := range t {
			out[i] = float64(n)
		}
		return out
	}
	return v
}

type goldenEnv struct {
	deps    *Deps
	users   UsernameResolver
	db      *testkit.DB
	stmts   int
	tdStmts int
	// search answers a fixture with `world.search` (nil: no search backend).
	search *goldenSearcher
}

// trainingDataColumns are the training data statement's columns.
var trainingDataColumns = []string{"id", "virusScanResult", "nsfwLevel", "fullyRated", "restricted"}

func goldenSetup(t *testing.T, fx *goldenFixture) *goldenEnv {
	t.Helper()
	now, err := time.Parse(time.RFC3339Nano, fx.Now)
	if err != nil {
		t.Fatal(err)
	}
	nowFn := func() time.Time { return now }
	cache, sys := testkit.NewRedis(), testkit.NewRedis()
	for key, e := range fx.Redis {
		setGolden(t, cache, key, e)
	}
	seedUncuratedShowcases(cache, fx)
	for key, e := range fx.SysRedis {
		setGolden(t, sys, key, e)
	}

	env := &goldenEnv{}
	models := fx.rows(t, "models")
	var gates []int
	fx.world(t, "paidAccessGates", &gates)
	var stats map[string][]any
	fx.world(t, "stats", &stats)
	statRows := func(k string) []map[string]any {
		out := make([]map[string]any, len(stats[k]))
		for i, x := range stats[k] {
			out[i], _ = revive(x).(map[string]any)
		}
		return out
	}
	vae := fx.rows(t, "vaeFiles")
	var usernames map[string]int
	fx.world(t, "usernames", &usernames)
	trainingData := fx.rows(t, "trainingData")
	var tdError bool
	if raw, ok := fx.World["trainingDataError"]; ok {
		_ = json.Unmarshal(raw, &tdError)
	}
	var tagIDs map[string]int
	fx.world(t, "tagIdsByName", &tagIDs)

	env.db = &testkit.DB{Routes: []testkit.Route{
		{Match: `as "cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			env.stmts++
			if fx.Expect.Fallback != "" {
				// A fallback fixture records no Node statement: only the reason is pinned.
				return toRows(modelColumns, models), nil
			}
			if fx.Expect.SQL == nil {
				return nil, errors.New("a model statement was built; the fixture expects none")
			}
			if err := fx.Expect.SQL.sameStatement("model statement", sql, args, false); err != nil {
				return nil, err
			}
			return toRows(modelColumns, models), nil
		}},
		// trainingDataListing's statement: Node's text and candidates, answered from the fixture's rows
		// of those versions (or its read error).
		{Match: `AS restricted`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			env.tdStmts++
			if fx.Expect.Fallback == "" {
				if fx.Expect.TrainingDataSQL == nil {
					return nil, errors.New("a training data statement was sent; the fixture expects none")
				}
				if err := fx.Expect.TrainingDataSQL.sameStatement("training data statement", sql, args, true); err != nil {
					return nil, err
				}
			}
			if tdError {
				return nil, errors.New("the fixture's training data read fails")
			}
			return toRows(trainingDataColumns, filterRows(trainingData, "modelVersionId", argIDs(args))), nil
		}},
		{Match: `AS deadline`, Rows: func(args []any) (*testkit.Rows, error) {
			ids := argIDs(args)
			var rows []map[string]any
			for _, id := range gates {
				if ids[id] {
					rows = append(rows, map[string]any{"modelId": float64(id), "deadline": nil})
				}
			}
			return toRows([]string{"modelId", "deadline"}, rows), nil
		}},
		{Match: `FROM "RecommendedResource"`, Rows: func(args []any) (*testkit.Rows, error) {
			return toRows([]string{"sourceId", "resourceId", "settings"}, filterRows(statRows("vaeLinked"), "sourceId", argIDs(args))), nil
		}},
		{Match: `FROM "ModelVersionMetric"`, Rows: func(args []any) (*testkit.Rows, error) {
			return toRows([]string{"modelVersionId", "downloadCount", "thumbsUpCount", "thumbsDownCount"},
				filterRows(statRows("versionMetrics"), "modelVersionId", argIDs(args))), nil
		}},
		{Match: `SELECT id, meta FROM "ModelVersion"`, Rows: func(args []any) (*testkit.Rows, error) {
			return toRows([]string{"id", "meta"}, filterRows(statRows("versionMeta"), "id", argIDs(args))), nil
		}},
		{Match: `FROM "ModelMetric" WHERE`, Rows: func(args []any) (*testkit.Rows, error) {
			return toRows([]string{"modelId", "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "tippedAmountCount"},
				filterRows(statRows("modelMetrics"), "modelId", argIDs(args))), nil
		}},
		{Match: `FROM "ModelFile" WHERE`, Rows: func(args []any) (*testkit.Rows, error) {
			return toRows(vaeFileColumns, filterRows(vae, "modelVersionId", argIDs(args))), nil
		}},
		{Match: `FROM "ModelFileHash"`, Rows: func(args []any) (*testkit.Rows, error) {
			ids := argIDs(args)
			var rows []map[string]any
			for _, f := range vae {
				id, _ := intOf(f["id"])
				if !ids[id] {
					continue
				}
				hs, _ := f["hashes"].([]any)
				for _, h := range hs {
					hm, _ := h.(map[string]any)
					rows = append(rows, map[string]any{"fileId": float64(id), "type": hm["type"], "hash": hm["hash"]})
				}
			}
			return toRows([]string{"fileId", "type", "hash"}, rows), nil
		}},
		{Match: `FROM "User" WHERE username`, Rows: func(args []any) (*testkit.Rows, error) {
			name, _ := args[0].(string)
			if id, ok := usernames[name]; ok {
				return toRows([]string{"id"}, []map[string]any{{"id": float64(id)}}), nil
			}
			return toRows([]string{"id"}, nil), nil
		}},
		// The `tag` filter's lookup by name (Node: dbRead.tag.findUnique over the same map).
		{Match: `FROM "Tag" WHERE name`, Rows: func(args []any) (*testkit.Rows, error) {
			name, _ := args[0].(string)
			if id, ok := tagIDs[name]; ok {
				return toRows([]string{"id"}, []map[string]any{{"id": float64(id)}}), nil
			}
			return toRows([]string{"id"}, nil), nil
		}},
	}}

	if fx.Config.ServeDataMiss {
		env.db.Routes = append(modelDataLookupRoutes(t, fx), env.db.Routes...)
	}
	packed := &hydrate.PackedReader{Redis: cache, Now: nowFn}
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: env.db}
	if fx.Config.ServeDataMiss {
		sources.Compute = &hydrate.MissCompute{Now: nowFn}
	}
	env.deps = &Deps{
		DB:      env.db,
		Packed:  packed,
		Sources: sources,
		Gallery: &feed.GalleryStore{Cache: cache, DB: env.db},
		Addons:  (&feed.AddonSource{Sys: sys}).Addons,
		// The blocked browsing tags under their real key in the cache redis (Node's
		// getBlockedBrowsingTags reads the fixture's `blockedTags`), unmemoized.
		Blocked: &feed.BlockedTags{Cache: cache, TTL: -1},
		Config: Config{
			ImageLocation:        fx.Config.ImageLocation,
			BaseURL:              fx.Config.BaseURL,
			CoverageNext:         fx.Config.CoverageNext,
			BaseModelFeedMetrics: fx.Config.BaseModelFeedMetrics,
			ServeDataMiss:        fx.Config.ServeDataMiss,
			// ServeDataMiss needs ComputeMisses (ValidateMisses).
			ComputeMisses:    fx.Config.ServeDataMiss,
			ResponseCacheTTL: 180 * time.Second,
			// The Node golden test runs the non-production build (isProd false): localhost origins.
			Production: false,
			// isRedCapableHost's list from the env the Node golden test sets (config.Hosts["red"] order).
			RedHosts: RedHosts(fx.Config.ServerDomainRed,
				append([]string{fx.Config.ServerDomainRed}, strings.Split(fx.Config.ServerDomainRedAliases, ",")...)),
		},
		Now: nowFn,
	}
	env.users = sources
	if raw, ok := fx.World["search"]; ok {
		var s struct {
			Hits []int `json:"hits"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("world search: %v", err)
		}
		env.search = &goldenSearcher{hits: s.Hits}
		env.deps.Search = env.search
	}
	return env
}

// modelDataLookupColumns are dataForModelsCache's lookup columns, in its query's order.
var modelDataLookupColumns = []string{"id", "index", "modelId", "name", "earlyAccessTimeFrame", "baseModel",
	"baseModelType", "createdAt", "trainingStatus", "publishedAt", "status", "flags", "availability", "nsfwLevel",
	"description", "trainedWords", "vaeId", "covered", "coveredNext"}

// modelDataLookupRoutes answer dataForModelsCache's lookup queries (its versions and its SHA256 model
// hashes) with the rows each requested model's `world.modelData` record was written from: the
// versions in record order with their modelId (integers as int64, text[] as []string), the hashes
// in record order. The record is what the lookup writes (gen-v1-models.mjs), so the rows are that
// record's inverse.
func modelDataLookupRoutes(t *testing.T, fx *goldenFixture) []testkit.Route {
	t.Helper()
	var data map[string]any
	fx.world(t, "modelData", &data)
	records := map[int]map[string]any{}
	for k, v := range data {
		id, err := strconv.Atoi(k)
		if err != nil {
			t.Fatalf("modelData key %q", k)
		}
		records[id], _ = revive(v).(map[string]any)
	}
	column := func(col string, v any) any {
		switch x := v.(type) {
		case float64:
			return int64(x)
		case []any:
			if col == "trainedWords" {
				out := make([]string, len(x))
				for i, e := range x {
					out[i], _ = e.(string)
				}
				return out
			}
		}
		return v
	}
	return []testkit.Route{
		{Match: `LEFT JOIN "GenerationCoverage"`, Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			var rows [][]any
			for _, id := range ids {
				vs, _ := records[id]["versions"].([]any)
				for _, x := range vs {
					v, _ := x.(map[string]any)
					row := make([]any, len(modelDataLookupColumns))
					for i, c := range modelDataLookupColumns {
						if c == "modelId" {
							row[i] = int64(id)
							continue
						}
						row[i] = column(c, v[c])
					}
					rows = append(rows, row)
				}
			}
			return testkit.NewRows(modelDataLookupColumns, rows...), nil
		}},
		{Match: `FROM "ModelHash"`, Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			var rows [][]any
			for _, id := range ids {
				hs, _ := records[id]["hashes"].([]any)
				for _, h := range hs {
					rows = append(rows, []any{int64(id), h})
				}
			}
			return testkit.NewRows([]string{"modelId", "hash"}, rows...), nil
		}},
	}
}

// seedUncuratedShowcases writes, for every version the fixture caches images for, the
// version-showcase entry getVersionShowcaseCache's lookup writes for an uncurated version: the Node
// golden test answers that lookup's ModelVersionShowcaseItem read with no rows (no fixture curates a
// showcase), so Node read each of them as uncurated. A fixture's own entry is kept.
func seedUncuratedShowcases(r *testkit.Redis, fx *goldenFixture) {
	prefix := hydrate.KeyVersionImages + ":"
	for key := range fx.Redis {
		id, ok := strings.CutPrefix(key, prefix)
		if !ok {
			continue
		}
		showcase := hydrate.KeyVersionShowcase + ":" + id
		if _, own := fx.Redis[showcase]; own {
			continue
		}
		n, err := strconv.Atoi(id)
		if err != nil {
			continue
		}
		r.SetString(showcase, jspack.Pack(jspack.O("modelVersionId", n, "rows", []any{}, "community", []any{})))
	}
}

func setGolden(t *testing.T, r *testkit.Redis, key string, e goldenEntry) {
	t.Helper()
	switch {
	case e.Packed != "":
		b, err := base64.StdEncoding.DecodeString(e.Packed)
		if err != nil {
			t.Fatalf("redis %s: %v", key, err)
		}
		r.SetString(key, b)
	case e.Raw != nil:
		r.SetString(key, []byte(*e.Raw))
	default:
		t.Fatalf("redis %s: no packed or raw value", key)
	}
}

func goldenFiles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(goldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < goldenMin {
		t.Fatalf("%d fixtures, want at least %d (did the glob match nothing?)", len(files), goldenMin)
	}
	sort.Strings(files)
	return files
}

func goldenLoad(t *testing.T, path string) *goldenFixture {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // G304: a fixture from the testdata glob
	if err != nil {
		t.Fatal(err)
	}
	fx := &goldenFixture{}
	if err := json.Unmarshal(raw, fx); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return fx
}

// goldenNodeSQLHash is what the Node of these fixtures sends as its rule set id
// (trainingDataListingRulesId): the SHA-256 of the training data statement its route sent, as one
// fixture recorded it. Not derived from Go's embedded copy, so a drifted copy fails here.
var goldenNodeSQLHash = sync.OnceValues(func() (string, error) {
	raw, err := os.ReadFile(filepath.Join(goldenDir, "detail-training-data.json"))
	if err != nil {
		return "", err
	}
	var fx goldenFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		return "", err
	}
	if fx.Expect.TrainingDataSQL == nil {
		return "", errors.New("detail-training-data.json records no training data statement")
	}
	sum := sha256.Sum256([]byte(fx.Expect.TrainingDataSQL.Text))
	// The decision version is the Go mirror's: feed-go-training-data-listing.parity.test.ts requires it
	// to be Node's TRAINING_DATA_LISTING_RULES_VERSION.
	return hex.EncodeToString(sum[:]) + ";rules=" + strconv.Itoa(TrainingDataRulesVersion), nil
})

// goldenServe computes the fixture's request, as a sample from the fixtures' Node (its statement
// hash attached).
func goldenServe(ctx context.Context, env *goldenEnv, fx *goldenFixture) (*Answer, error) {
	hash, err := goldenNodeSQLHash()
	if err != nil {
		return nil, err
	}
	if id, ok := strings.CutPrefix(fx.Request.Path, "/api/v1/models/"); ok {
		return ServeDetail(ctx, env.deps, DetailRequest{
			ID: id, RegionRestricted: fx.Config.RegionRestricted, Host: fx.Request.Headers["host"],
			TrainingDataSQL: hash,
		})
	}
	return ServeList(ctx, env.deps, env.users, ListRequest{
		Query: fx.Request.Query, Path: fx.Request.Path, Host: fx.Request.Headers["host"],
		RegionRestricted: fx.Config.RegionRestricted, TrainingDataSQL: hash,
	})
}

func goldenRun(t *testing.T, fx *goldenFixture) {
	env := goldenSetup(t, fx)
	ans, err := goldenServe(context.Background(), env, fx)
	if want := fx.Expect.Fallback; want != "" {
		if err == nil {
			t.Fatalf("served; want fallback %q", want)
		}
		if got := fallback.Reason(err); got != want {
			t.Fatalf("fallback reason %q (%v), want %q", got, err, want)
		}
		return
	}
	if err != nil {
		t.Fatalf("compute: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	if fx.Expect.Body == nil {
		t.Fatalf("the fixture has no expected body yet: run the Node golden test and copy its GOLDEN-ACTUAL")
	}
	got, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(*fx.Expect.Body)
	searched := env.search != nil && len(env.search.reqs) > 0
	switch {
	case fx.Expect.Search == nil && searched:
		t.Errorf("a search call was made; the fixture expects none")
	case fx.Expect.Search != nil && (env.search == nil || len(env.search.reqs) != 1):
		t.Errorf("search calls: %v, want Node's one", env.search)
	case fx.Expect.Search != nil:
		if err := fx.Expect.Search.same(env.search.reqs[0]); err != nil {
			t.Error(err)
		}
	}
	// With no hit Node still sends its statement (no id clause) and discards its rows: none is sent
	// here.
	noHits := searched && len(env.search.hits) == 0
	if fx.Expect.SQL != nil && env.stmts != 1 && (!noHits || env.stmts != 0) {
		t.Errorf("model statements: %d, want 1", env.stmts)
	}
	if fx.Expect.TrainingDataSQL != nil && env.tdStmts != 1 {
		t.Errorf("training data statements: %d, want 1", env.tdStmts)
	}
	if bytes.Equal(got, want) {
		return
	}
	rep, err := shadow.CompareJSON(got, want)
	if err != nil {
		t.Fatalf("compare: %v\n go: %s", err, got)
	}
	var paths []string
	for _, d := range rep.Diffs {
		paths = append(paths, d.Kind+":"+d.Path)
	}
	t.Fatalf("not the bytes Node writes (structural match %v, diffs %v)\n go:   %s\n node: %s", rep.Match, paths, got, want)
}

func TestGoldenV1Models(t *testing.T) {
	for _, path := range goldenFiles(t) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRun(t, fx) })
	}
}

// The Node golden test runs the non-production build, so its nextPage and download URLs carry
// http://localhost:3000. In production getNextPage's origin is `new URL(…, "https://" + host).origin`:
// the WHATWG URL lowercases the host and drops https's default port, and keeps any other port. Over a
// fixture whose answer has a nextPage with a real cursor, the production build must write Node's
// body with only that origin changed.
func TestGoldenV1ModelsProductionOrigin(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "list-defaults-lookahead.json"))
	if fx.Expect.Body == nil || !strings.Contains(*fx.Expect.Body, `"nextPage":"http://localhost:3000/api/v1/models?`) ||
		!strings.Contains(*fx.Expect.Body, `cursor=300%7C999%7C5103`) {
		t.Fatalf("the fixture no longer carries a nextPage with a cursor: %v", fx.Expect.Body)
	}
	for _, c := range []struct{ host, origin string }{
		{"Site.Example.Test:443", "https://site.example.test"},
		{"site.example.test", "https://site.example.test"},
		{"SITE.example.test:8443", "https://site.example.test:8443"},
	} {
		fx := goldenLoad(t, filepath.Join(goldenDir, "list-defaults-lookahead.json"))
		fx.Request.Headers["host"] = c.host
		env := goldenSetup(t, fx)
		env.deps.Config.Production = true
		ans, err := goldenServe(context.Background(), env, fx)
		if err != nil {
			t.Fatalf("%s: %v (%s)", c.host, err, fallback.Reason(err))
		}
		got, err := superjson.Plain(ans.Body)
		if err != nil {
			t.Fatal(err)
		}
		want := strings.ReplaceAll(*fx.Expect.Body, "http://localhost:3000", c.origin)
		if string(got) != want {
			t.Errorf("%s:\n go:   %s\n want: %s", c.host, got, want)
		}
	}
	// A host the URL parser would not accept as is falls back rather than guess an origin.
	fx.Request.Headers["host"] = "bad host"
	env := goldenSetup(t, fx)
	env.deps.Config.Production = true
	if _, err := goldenServe(context.Background(), env, fx); fallback.Reason(err) != "v1-models-host" {
		t.Errorf("bad host: %v", err)
	}
}
