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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

const (
	goldenDir = "../../testdata/golden/v1-models"
	// The fixture count gen-v1-models.mjs writes: fewer found means the glob matched the wrong place.
	goldenMin = 14
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
		Fallback string  `json:"fallback"`
		Body     *string `json:"body"`
		SQL      *struct {
			Text   string            `json:"text"`
			Values []json.RawMessage `json:"values"`
		} `json:"sql"`
	} `json:"expect"`
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
	deps  *Deps
	users UsernameResolver
	db    *testkit.DB
	stmts int
}

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
			if got, want := NormalizeSQL(sql), NormalizeSQL(fx.Expect.SQL.Text); got != want {
				return nil, fmt.Errorf("model statement differs from Node's:\n go:   %s\n node: %s", got, want)
			}
			if len(args) != len(fx.Expect.SQL.Values) {
				return nil, fmt.Errorf("model statement: %d values, Node binds %d", len(args), len(fx.Expect.SQL.Values))
			}
			for i, a := range args {
				var want any
				_ = json.Unmarshal(fx.Expect.SQL.Values[i], &want)
				if got := jsonArg(a); !reflect.DeepEqual(got, want) {
					return nil, fmt.Errorf("model statement value $%d: go %#v, node %#v", i+1, got, want)
				}
			}
			return toRows(modelColumns, models), nil
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
	}}

	packed := &hydrate.PackedReader{Redis: cache, Now: nowFn}
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: env.db}
	env.deps = &Deps{
		DB:      env.db,
		Packed:  packed,
		Sources: sources,
		Gallery: &feed.GalleryStore{Cache: cache, DB: env.db},
		Addons:  (&feed.AddonSource{Sys: sys}).Addons,
		Config: Config{
			ImageLocation:        fx.Config.ImageLocation,
			BaseURL:              fx.Config.BaseURL,
			CoverageNext:         fx.Config.CoverageNext,
			BaseModelFeedMetrics: fx.Config.BaseModelFeedMetrics,
			ResponseCacheTTL:     180 * time.Second,
			// The Node golden test runs the non-production build (isProd false): localhost origins.
			Production: false,
		},
		Now: nowFn,
	}
	env.users = sources
	return env
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

// goldenServe computes the fixture's request.
func goldenServe(ctx context.Context, env *goldenEnv, fx *goldenFixture) (*Answer, error) {
	if id, ok := strings.CutPrefix(fx.Request.Path, "/api/v1/models/"); ok {
		return ServeDetail(ctx, env.deps, DetailRequest{ID: id, RegionRestricted: fx.Config.RegionRestricted})
	}
	return ServeList(ctx, env.deps, env.users, ListRequest{
		Query: fx.Request.Query, Path: fx.Request.Path, Host: fx.Request.Headers["host"],
		RegionRestricted: fx.Config.RegionRestricted,
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
	if fx.Expect.SQL != nil && env.stmts != 1 {
		t.Errorf("model statements: %d, want 1", env.stmts)
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
