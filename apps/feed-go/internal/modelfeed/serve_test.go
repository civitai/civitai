package modelfeed

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

var testNow = time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

// modelColumns is the page query's select list, in scan order.
var modelColumns = []string{"id", "name", "sfwName", "coverImageId", "sfwCoverImageId", "type", "minor", "sfwOnly", "poi",
	"nsfw", "nsfwLevel", "status", "createdAt", "lastVersionAt", "publishedAt", "locked", "meta", "mode", "availability",
	"rank", "userId", "cursorId"}

// testRow is one page-query row; zero values are the plainest model.
type testRow struct {
	id, owner          int
	name               string
	sfwName            any
	cover, sfwCover    any
	typ                string
	minor, sfwOnly     bool
	nsfw               bool
	nsfwLevel          int
	meta               any
	mode               any
	rank, cursor       string
	createdAt, lastVer time.Time
}

func (r testRow) values() []any {
	typ := r.typ
	if typ == "" {
		typ = "Checkpoint"
	}
	level := r.nsfwLevel
	if level == 0 {
		level = 1
	}
	rank := r.rank
	if rank == "" {
		rank = `{"downloadCount":10,"thumbsUpCount":20,"thumbsDownCount":1,"commentCount":2,"collectedCount":3,"tippedAmountCount":4}`
	}
	created := r.createdAt
	if created.IsZero() {
		created = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	}
	last := r.lastVer
	if last.IsZero() {
		last = time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	}
	name := r.name
	if name == "" {
		name = "Model " + string(rune('A'+r.id%26))
	}
	return []any{r.id, name, r.sfwName, r.cover, r.sfwCover, typ, r.minor, r.sfwOnly, false, r.nsfw, level, "Published",
		created, last, last, false, r.meta, r.mode, "Public", rank, r.owner, r.cursor}
}

// fakeSources answers the cache reads from maps.
type fakeSources struct {
	mu        sync.Mutex
	page      hydrate.ModelPage
	images    map[int][]superjson.Object
	members   map[int]bool
	users     map[string]int
	versionRq [][]int
	memberRq  [][]int
	pageErr   error
	// official is what OfficialModels answers (officialErr fails it); officialCalls counts the calls.
	official      []hydrate.OfficialModel
	officialErr   error
	officialCalls int
	// computedRq are CreatorMembershipsComputed's calls.
	computedRq [][]int
}

func (f *fakeSources) OfficialModels(_ context.Context) ([]hydrate.OfficialModel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.officialCalls++
	return f.official, f.officialErr
}

func (f *fakeSources) ModelPage(_ context.Context, _ hydrate.ModelPageRequest) (*hydrate.ModelPage, error) {
	if f.pageErr != nil {
		return nil, f.pageErr
	}
	p := f.page
	return &p, nil
}

func (f *fakeSources) VersionImages(_ context.Context, ids []int) (map[int][]superjson.Object, error) {
	f.mu.Lock()
	f.versionRq = append(f.versionRq, ids)
	f.mu.Unlock()
	out := map[int][]superjson.Object{}
	for _, id := range ids {
		if l, ok := f.images[id]; ok {
			out[id] = l
		}
	}
	return out, nil
}

func (f *fakeSources) CreatorMemberships(_ context.Context, ids []int) (map[int]bool, error) {
	f.memberRq = append(f.memberRq, ids)
	out := map[int]bool{}
	for _, id := range ids {
		if f.members[id] {
			out[id] = true
		}
	}
	return out, nil
}

// CreatorMembershipsComputed answers as CreatorMemberships; computedRq records its calls.
func (f *fakeSources) CreatorMembershipsComputed(ctx context.Context, ids []int) (map[int]bool, error) {
	f.computedRq = append(f.computedRq, ids)
	return f.CreatorMemberships(ctx, ids)
}

func (f *fakeSources) UserIDByUsername(_ context.Context, name string) (int, bool, error) {
	id, ok := f.users[name]
	return id, ok, nil
}

type fakeGallery struct{ settings map[int]*feed.GallerySettings }

func (g *fakeGallery) SettingsMany(_ context.Context, ids []int) (map[int]*feed.GallerySettings, error) {
	out := map[int]*feed.GallerySettings{}
	for _, id := range ids {
		s, ok := g.settings[id]
		if !ok {
			return nil, fallback.New("gallery-settings-miss")
		}
		out[id] = s
	}
	return out, nil
}

// env is a Deps over fakes; pages are the page query's answers, in call order.
type env struct {
	deps    *Deps
	sources *fakeSources
	db      *testkit.DB
	pages   [][]testRow
	queries []string
	args    [][]any
	gates   map[int]*time.Time
	covers  [][]any
	// community are the community-cover guard's rows (modelId, imageId); communityArgs each read's
	// arguments.
	community     [][]any
	communityArgs [][]any
}

func newEnv(pages ...[]testRow) *env {
	e := &env{pages: pages, gates: map[int]*time.Time{}, sources: &fakeSources{
		page: hydrate.ModelPage{
			Basic: map[int]hydrate.BasicUser{}, ProfilePics: map[int]superjson.Object{}, UserCosmetics: map[int][]any{},
			Data: map[int]hydrate.ModelData{}, Frames: map[int]superjson.Object{}, Decorations: map[int]superjson.Object{},
			PrivacyDefaults: map[int]hydrate.PrivacyDefaults{},
		},
		images: map[int][]superjson.Object{}, members: map[int]bool{}, users: map[string]int{},
	}}
	var mu sync.Mutex
	e.db = &testkit.DB{Routes: []testkit.Route{
		{Match: `"cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			mu.Lock()
			defer mu.Unlock()
			e.queries = append(e.queries, sql)
			e.args = append(e.args, args)
			if len(e.pages) == 0 {
				return nil, errors.New("no more pages")
			}
			page := e.pages[0]
			e.pages = e.pages[1:]
			rows := make([][]any, len(page))
			for i, r := range page {
				rows[i] = r.values()
			}
			return testkit.NewRows(modelColumns, rows...), nil
		}},
		{Match: `GROUP BY mv."modelId"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, id := range args[0].([]int) {
				if d, ok := e.gates[id]; ok {
					var v any
					if d != nil {
						v = *d
					}
					rows = append(rows, []any{id, v})
				}
			}
			return testkit.NewRows([]string{"modelId", "deadline"}, rows...), nil
		}},
		{Match: `FROM "Image" i`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"id", "userId", "modelVersionId", "modelId"}, e.covers...), nil
		}},
		{Match: `FROM "ModelVersionShowcaseItem" s`, Rows: func(args []any) (*testkit.Rows, error) {
			mu.Lock()
			defer mu.Unlock()
			e.communityArgs = append(e.communityArgs, args)
			return testkit.NewRows([]string{"modelId", "imageId"}, e.community...), nil
		}},
		{Match: `SELECT id FROM "Tag" WHERE name = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			if args[0] == "anime" {
				return testkit.NewRows([]string{"id"}, []any{77}), nil
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
	}}
	cache := testkit.NewRedis()
	cache.SetString("system:blocked-browsing-tags", []byte(`[{"id":1,"name":"Blocked Tag"}]`))
	e.deps = &Deps{
		DB: e.db, Sources: e.sources, Gallery: &fakeGallery{settings: map[int]*feed.GallerySettings{}},
		Addons:  func(context.Context) []browsing.Addon { return nil },
		Blocked: &feed.BlockedTags{Cache: cache},
		Config:  Config{CoverageNext: true, LoadingOpenToAll: true, BaseModelMetrics: true, ImagesSlim: true},
		Now:     func() time.Time { return testNow },
	}
	return e
}

// version is a cached version record, its keys sorted (sortedRecord).
func version(id int, baseModel string, extra map[string]any) superjson.Object {
	v := map[string]any{"id": int64(id), "name": "v" + baseModel, "baseModel": baseModel, "status": "Published",
		"availability": "Public", "nsfwLevel": int64(1), "flags": int64(0), "covered": true, "coveredNext": true}
	for k, x := range extra {
		v[k] = x
	}
	return sortedRecord(v)
}

// image is a cached showcase image record, its keys sorted (sortedRecord).
func image(id, owner, level int, extra map[string]any) superjson.Object {
	m := map[string]any{"id": int64(id), "userId": int64(owner), "nsfwLevel": int64(level), "tags": []any{}}
	for k, x := range extra {
		m[k] = x
	}
	return sortedRecord(m)
}

// sortedRecord is m as an ordered record with its keys sorted: a record whose order the test does
// not care about (hydrate.Entry.Ordered of an entry built in code).
func sortedRecord(m map[string]any) superjson.Object {
	return hydrate.Wire(m).(superjson.Object)
}

func serve(t *testing.T, e *env, in *Input, viewer *Viewer) (*Answer, error) {
	t.Helper()
	return Serve(context.Background(), e.deps, Request{Input: in, Viewer: viewer, Cap: 0})
}

func baseInput() *Input {
	lv := 1
	return &Input{Limit: 2, Sort: SortHighestRated, Period: "AllTime", PeriodMode: "published", BrowsingLevel: &lv}
}

func items(t *testing.T, a *Answer) []superjson.Object {
	t.Helper()
	v, _ := a.Value.Get("items")
	list, _ := v.([]any)
	out := make([]superjson.Object, len(list))
	for i, x := range list {
		out[i] = x.(superjson.Object)
	}
	return out
}

func field(t *testing.T, o superjson.Object, path string) any {
	t.Helper()
	var cur any = o
	for _, k := range strings.Split(path, ".") {
		obj, ok := cur.(superjson.Object)
		if !ok {
			t.Fatalf("%s: %s is not an object", path, k)
		}
		if cur, ok = obj.Get(k); !ok {
			t.Fatalf("%s: no key %s", path, k)
		}
	}
	return cur
}

// The whole answer for a two-model page, compared with the answer Node gives for the same rows and
// cache values (written out by hand from getModelsRaw / getModelsWithImagesAndModelVersions).
func TestServeWholeAnswer(t *testing.T) {
	e := newEnv([]testRow{
		{id: 5001, owner: 1001, name: "Model One", cover: 8002, cursor: "20|10|5001"},
		{id: 5002, owner: 1002, name: "Model Two", typ: "LORA", cover: 9999, cursor: "20|10|5002"},
		{id: 5003, owner: 1002, cursor: "1|2|5003"}, // the lookahead row
	})
	deadline := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	e.gates[5001] = &deadline
	e.gates[5002] = nil // a gate with no end date
	s := e.sources
	s.page.Basic[1001] = hydrate.BasicUser{ID: 1001, Username: "artist_one"}
	s.page.Frames[5002] = superjson.Object{{Key: "id", Val: int64(302)}}
	s.page.Data[5001] = hydrate.ModelData{
		Hashes:   []any{"ABCDEF"},
		TagIDs:   []int{7},
		Versions: []superjson.Object{version(6001, "SDXL 1.0", map[string]any{"flags": int64(32)}), version(6002, "Pony", nil)},
	}
	s.page.Data[5002] = hydrate.ModelData{Hashes: []any{}, TagIDs: []int{}, Versions: []superjson.Object{version(6003, "Pony", map[string]any{"covered": false})}}
	s.images[6001] = []superjson.Object{
		image(8001, 1001, 1, map[string]any{"url": "u1", "onSite": true, "hasMeta": true, "hasPositivePrompt": false, "modelVersionId": int64(6001), "availability": "Public", "tags": []any{int64(7)}}),
		image(8002, 1001, 1, nil),
	}
	s.images[6003] = []superjson.Object{image(8003, 1002, 1, nil)}

	ans, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatalf("Serve: %v (%q)", err, fallback.Reason(err))
	}
	payload, err := superjson.Serialize(ans.Value)
	if err != nil {
		t.Fatal(err)
	}
	node := `{"json":{"items":[
	  {"id":5001,"name":"Model One","coverImageId":8002,"sfwCoverImageId":null,"type":"Checkpoint","minor":false,"sfwOnly":false,
	   "poi":false,"nsfw":false,"nsfwLevel":1,"status":"Published","createdAt":"2026-01-02T03:04:05.000Z",
	   "lastVersionAt":"2026-06-01T00:00:00.000Z","publishedAt":"2026-06-01T00:00:00.000Z","locked":false,"mode":null,
	   "availability":"Public","userId":1001,"earlyAccessDeadline":"2026-07-01T00:00:00.000Z","hasActivePaidAccess":true,
	   "hasSfwFace":false,"baseModels":["SDXL 1.0","Pony"],
	   "user":{"id":1001,"username":"artist_one","deletedAt":null,"image":null,"profilePicture":null,"cosmetics":[]},
	   "cosmetic":null,"eventDecoration":null,"tags":[7],"hashes":["abcdef"],
	   "hiddenMetrics":{"buzz":false,"downloads":false,"generations":false},
	   "rank":{"downloadCount":10,"thumbsUpCount":20,"thumbsDownCount":1,"commentCount":2,"collectedCount":3,"tippedAmountCount":4},
	   "version":{"id":6001,"name":"vSDXL 1.0","baseModel":"SDXL 1.0","status":"Published","availability":"Public","nsfwLevel":1,
	     "flags":0,"covered":true,"coveredNext":true},
	   "images":[{"id":8002,"userId":1001,"nsfwLevel":1,"tags":[]},{"id":8001,"userId":1001,"nsfwLevel":1,"url":"u1","tags":[7]}],
	   "canGenerate":true},
	  {"id":5002,"name":"Model Two","coverImageId":9999,"sfwCoverImageId":null,"type":"LORA","minor":false,"sfwOnly":false,
	   "poi":false,"nsfw":false,"nsfwLevel":1,"status":"Published","createdAt":"2026-01-02T03:04:05.000Z",
	   "lastVersionAt":"2026-06-01T00:00:00.000Z","publishedAt":"2026-06-01T00:00:00.000Z","locked":false,"mode":null,
	   "availability":"Public","userId":1002,"earlyAccessDeadline":null,"hasActivePaidAccess":true,
	   "hasSfwFace":false,"baseModels":["Pony"],
	   "user":{"id":1002,"username":null,"deletedAt":null,"image":null,"profilePicture":null,"cosmetics":[]},
	   "cosmetic":{"id":302},"eventDecoration":null,"tags":[],"hashes":[],
	   "hiddenMetrics":{"buzz":false,"downloads":false,"generations":false},
	   "rank":{"downloadCount":10,"thumbsUpCount":20,"thumbsDownCount":1,"commentCount":2,"collectedCount":3,"tippedAmountCount":4},
	   "version":{"id":6003,"name":"vPony","baseModel":"Pony","status":"Published","availability":"Public","nsfwLevel":1,
	     "flags":0,"covered":false,"coveredNext":true},
	   "images":[{"id":8003,"userId":1002,"nsfwLevel":1,"tags":[]}],
	   "canGenerate":true}
	 ],"nextCursor":"1|2|5003"},
	 "meta":{"values":{
	   "items.0.createdAt":["Date"],"items.0.lastVersionAt":["Date"],"items.0.publishedAt":["Date"],
	   "items.0.earlyAccessDeadline":["Date"],
	   "items.1.createdAt":["Date"],"items.1.lastVersionAt":["Date"],"items.1.publishedAt":["Date"]},"v":1}}`
	rep, err := shadow.Compare(payload, []byte(node))
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Match {
		t.Fatalf("differs from Node's answer: %+v\n%s", rep.Diffs, payload)
	}
	if ans.Trivial {
		t.Fatal("a loaded page is not trivial")
	}
	// One page: two items fill the limit. The cover 9999 was looked up on the replica (not on the
	// shown version) and not found, then among the model's featured community images, where it is
	// not either (Node's withCommunityCovers finds no row and answers the same).
	if len(e.queries) != 1 || len(e.db.Calls) != 4 {
		t.Fatalf("queries %d, db calls %d (%v)", len(e.queries), len(e.db.Calls), e.db.Calls)
	}
	if !reflect.DeepEqual(e.communityArgs, [][]any{{[]int{9999}, []int{5002}}}) {
		t.Fatalf("community-cover reads %v, want the one missing cover", e.communityArgs)
	}
}

// getModelsFeed loops while the page is short (up to three pages), and its nextCursor is the cursor
// of the last page that HAD one: a last page with no lookahead leaves the previous cursor in place.
func TestServeLoopsAndKeepsThePreviousCursor(t *testing.T) {
	e := newEnv(
		[]testRow{{id: 1, owner: 9, cursor: "c1"}, {id: 2, owner: 9, cursor: "c2"}, {id: 3, owner: 9, cursor: "5|5|3"}},
		[]testRow{{id: 4, owner: 9, cursor: "c4"}},
	)
	for _, id := range []int{1, 4} { // model 2 has no data entry: left out
		e.sources.page.Data[id] = hydrate.ModelData{Versions: []superjson.Object{version(id*10, "Pony", nil)}}
		e.sources.images[id*10] = []superjson.Object{image(id*100, 9, 1, nil)}
	}
	ans, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	got := items(t, ans)
	if len(got) != 2 || field(t, got[0], "id") != int64(1) || field(t, got[1], "id") != int64(4) {
		t.Fatalf("items %v", got)
	}
	if v, _ := ans.Value.Get("nextCursor"); v != "5|5|3" {
		t.Fatalf("nextCursor %v, want 5|5|3 (the second page had no lookahead)", v)
	}
	if len(e.args) != 2 {
		t.Fatalf("%d page queries, want 2", len(e.args))
	}
	// The second page is asked from the first page's lookahead (the split cursor's values bound).
	if !reflect.DeepEqual(e.args[1][:3], []any{int64(5), int64(5), int64(5)}) {
		t.Fatalf("second page args %v", e.args[1])
	}
}

// A last page with no lookahead and no earlier cursor: nextCursor is undefined.
func TestServeNoCursorIsUndefined(t *testing.T) {
	e := newEnv([]testRow{{id: 1, owner: 9, cursor: "c1"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
	ans, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := ans.Value.Get("nextCursor"); v != (superjson.Undefined{}) {
		t.Fatalf("nextCursor %#v, want undefined", v)
	}
}

// Three short pages and the loop stops; an empty page loads nothing (trivial).
func TestServeLoopBoundAndTrivial(t *testing.T) {
	e := newEnv(
		[]testRow{{id: 1, owner: 9, cursor: "a"}, {id: 2, owner: 9, cursor: "b"}, {id: 3, owner: 9, cursor: "1|1|3"}},
		[]testRow{{id: 4, owner: 9, cursor: "a"}, {id: 5, owner: 9, cursor: "b"}, {id: 6, owner: 9, cursor: "1|1|6"}},
		[]testRow{{id: 7, owner: 9, cursor: "a"}, {id: 8, owner: 9, cursor: "b"}, {id: 9, owner: 9, cursor: "1|1|9"}},
	)
	ans, err := serve(t, e, baseInput(), nil) // no data for any model: every page empties
	if err != nil {
		t.Fatal(err)
	}
	if len(items(t, ans)) != 0 || len(e.args) != 3 {
		t.Fatalf("items %d, queries %d; want 0 and 3", len(items(t, ans)), len(e.args))
	}
	if v, _ := ans.Value.Get("nextCursor"); v != "1|1|9" {
		t.Fatalf("nextCursor %v", v)
	}
	if ans.Trivial {
		t.Fatal("rows were loaded: not trivial")
	}
	empty := newEnv([]testRow{})
	ans, err = serve(t, empty, baseInput(), nil)
	if err != nil || !ans.Trivial || len(items(t, ans)) != 0 {
		t.Fatalf("empty page: %v trivial=%v", err, ans != nil && ans.Trivial)
	}
}

func TestServeFallbacks(t *testing.T) {
	noLevel := baseInput()
	noLevel.BrowsingLevel = nil
	named := baseInput()
	named.Username = "nobody"
	for _, c := range []struct {
		name   string
		in     *Input
		viewer *Viewer
		cfg    func(*Config)
		reason string
	}{
		{"signed in with no level", noLevel, &Viewer{ID: 1}, nil, "model-level-absent"},
		{"signed out uncapped with no level", noLevel, nil, nil, "model-level-absent"},
		{"base-model-feed-metrics off", baseInput(), nil, func(c *Config) { c.BaseModelMetrics = false }, "flag-off-state"},
		{"getAllModelImagesSlim off", baseInput(), nil, func(c *Config) { c.ImagesSlim = false }, "flag-off-state"},
		{"generation-coverage-next off", baseInput(), nil, func(c *Config) { c.CoverageNext = false }, "flag-off-state"},
		{"generation-loading-open-to-all off, even for a moderator", baseInput(), &Viewer{ID: 1, IsModerator: true}, func(c *Config) { c.LoadingOpenToAll = false }, "flag-off-state"},
		{"a creator the replica does not hold", named, nil, nil, "model-username-miss"},
	} {
		e := newEnv([]testRow{})
		if c.cfg != nil {
			c.cfg(&e.deps.Config)
		}
		_, err := serve(t, e, c.in, c.viewer)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
	// Positive control: every mirror on (production's state) is served.
	if _, err := serve(t, newEnv([]testRow{}), baseInput(), nil); err != nil {
		t.Fatalf("all mirrors on: %v", err)
	}
}

// The domain cap: signed out with no level is the cap; a level is held to it.
func TestResolveLevel(t *testing.T) {
	lv := 31
	for _, c := range []struct {
		in   *int
		cap  int
		want int
	}{{nil, 1, 1}, {&lv, 1, 1}, {&lv, 0, 31}, {&lv, 3, 3}} {
		got, err := resolveLevel(&Input{BrowsingLevel: c.in}, Request{Cap: c.cap})
		if err != nil || got != c.want {
			t.Errorf("level %v cap %d: %d %v, want %d", c.in, c.cap, got, err, c.want)
		}
	}
	disjoint := 16
	if got, _ := resolveLevel(&Input{BrowsingLevel: &disjoint}, Request{Cap: 3}); got != 3 {
		t.Errorf("disjoint level: %d, want the cap", got)
	}
	// A sent level is held to the selectable levels before the cap, unless a moderator sent it.
	mixed := 1 | 32
	for _, c := range []struct {
		v         *Viewer
		cap, want int
	}{{&Viewer{ID: 5}, 0, 1}, {nil, 0, 1}, {&Viewer{ID: 5}, 3, 1}, {&Viewer{ID: 5, IsModerator: true}, 0, 1 | 32}} {
		if got, err := resolveLevel(&Input{BrowsingLevel: &mixed}, Request{Viewer: c.v, Cap: c.cap}); err != nil || got != c.want {
			t.Errorf("viewer %+v cap %d: %d %v, want %d", c.v, c.cap, got, err, c.want)
		}
	}
}

// A blocked tag name is an empty page with no query; a known tag adds its filter; an unknown name
// none.
func TestServeTagFilter(t *testing.T) {
	e := newEnv()
	in := baseInput()
	in.Tag = "BLOCKED tag"
	ans, err := serve(t, e, in, nil)
	if err != nil || !ans.Trivial || len(items(t, ans)) != 0 || len(e.queries) != 0 {
		t.Fatalf("blocked tag: %v trivial=%v queries=%d", err, ans != nil && ans.Trivial, len(e.queries))
	}
	e = newEnv([]testRow{})
	in.Tag = "anime"
	if _, err := serve(t, e, in, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(norm(e.queries[0]), `tom."tagId" = $`) || !reflect.DeepEqual(e.args[0][len(e.args[0])-3:len(e.args[0])-2], []any{77}) {
		t.Fatalf("known tag: %s %v", norm(e.queries[0]), e.args[0])
	}
	e = newEnv([]testRow{})
	in.Tag = "unknown"
	if _, err := serve(t, e, in, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(norm(e.queries[0]), `AND tom."tagId" = $`) {
		t.Fatal("an unknown tag name adds no filter")
	}
	// The blocked list read falls back when the key is absent.
	e = newEnv()
	e.deps.Blocked = &feed.BlockedTags{Cache: testkit.NewRedis()}
	in.Tag = "x"
	if _, err := serve(t, e, in, nil); fallback.Reason(err) != "blocked-tags-miss" {
		t.Fatalf("absent blocked list: %v", err)
	}
	e = newEnv()
	e.deps.Blocked = nil
	if _, err := serve(t, e, in, nil); fallback.Reason(err) != "blocked-tags-unconfigured" {
		t.Fatalf("no blocked-tag reader: %v", err)
	}
}

// The addon exclusions are added unless the request is scoped to the viewer's own name; a creator
// filter turns the private-version filter off.
func TestServeAddonsAndOwnScope(t *testing.T) {
	addons := []browsing.Addon{{Type: "some", NsfwLevels: []int{1}, ExcludedTagIDs: []int{900}}}
	run := func(viewer *Viewer, username string) []any {
		e := newEnv([]testRow{})
		e.deps.Addons = func(context.Context) []browsing.Addon { return addons }
		e.sources.users["artist_one"] = 1001
		in := baseInput()
		in.Username = username
		if _, err := serve(t, e, in, viewer); err != nil {
			t.Fatal(err)
		}
		return e.args[0]
	}
	hasList := func(args []any) bool {
		for _, a := range args {
			if l, ok := a.([]int); ok && reflect.DeepEqual(l, []int{900}) {
				return true
			}
		}
		return false
	}
	if !hasList(run(nil, "")) {
		t.Error("signed out: the addon's excluded tags apply")
	}
	if hasList(run(&Viewer{ID: 1001, Username: "Artist_One"}, "artist_one")) {
		t.Error("own scope (case-insensitive): no addon tag exclusions")
	}
	if !hasList(run(&Viewer{ID: 5, Username: "someone"}, "artist_one")) {
		t.Error("another creator's page: the exclusions apply")
	}
}

// A minor or SFW-only model's showcase is held to its level (the cached gallery level when held,
// else the flags' limit), except for its owner; a moderator sees it whole.
func TestServeShowcaseHold(t *testing.T) {
	setup := func() *env {
		e := newEnv([]testRow{{id: 1, owner: 9, sfwOnly: true, cursor: "x"}, {id: 2, owner: 8, minor: true, cursor: "y"}})
		e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
		e.sources.page.Data[2] = hydrate.ModelData{Versions: []superjson.Object{version(20, "Pony", nil)}}
		e.sources.images[10] = []superjson.Object{image(101, 9, 4, nil), image(102, 9, 1, nil)}
		e.sources.images[20] = []superjson.Object{image(201, 8, 2, nil), image(202, 8, 1, nil)}
		held, level := true, 1
		e.deps.Gallery = &fakeGallery{settings: map[int]*feed.GallerySettings{
			1: nil, // no settings: the flags' limit (SFW)
			2: {SfwHeld: &held, Level: &level},
		}}
		return e
	}
	in := baseInput()
	lv := 31
	in.BrowsingLevel = &lv
	ids := func(a *Answer) [][]int64 {
		list := items(t, a)
		out := make([][]int64, 0, len(list))
		for _, it := range list {
			var l []int64
			for _, img := range field(t, it, "images").([]any) {
				id, _ := img.(superjson.Object).Get("id")
				l = append(l, id.(int64))
			}
			out = append(out, l)
		}
		return out
	}
	a, err := serve(t, setup(), in, &Viewer{ID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(a); !reflect.DeepEqual(got, [][]int64{{102}, {202}}) {
		t.Fatalf("held: %v", got)
	}
	a, _ = serve(t, setup(), in, &Viewer{ID: 9})
	if got := ids(a); !reflect.DeepEqual(got, [][]int64{{101, 102}, {202}}) {
		t.Fatalf("owner of model 1: %v", got)
	}
	a, _ = serve(t, setup(), in, &Viewer{ID: 3, IsModerator: true})
	if got := ids(a); !reflect.DeepEqual(got, [][]int64{{101, 102}, {201, 202}}) {
		t.Fatalf("moderator: %v", got)
	}
	// A held setting with no level falls back.
	e := setup()
	held := true
	e.deps.Gallery = &fakeGallery{settings: map[int]*feed.GallerySettings{1: nil, 2: {SfwHeld: &held}}}
	if _, err := serve(t, e, in, nil); fallback.Reason(err) != "model-held-level-unset" {
		t.Fatalf("level unset: %v", err)
	}
}

// Metric privacy: a member owner's hidden metrics are null to others, real to the owner; a lapsed
// owner's flags hide nothing; only owners with a hide flag have their membership read.
func TestServeMetricPrivacy(t *testing.T) {
	setup := func(member bool) *env {
		e := newEnv([]testRow{
			{id: 1, owner: 9, cursor: "x", meta: `{"metricVisibility":{"buzz":"hide"}}`},
			{id: 2, owner: 8, cursor: "y"},
		})
		for _, id := range []int{1, 2} {
			e.sources.page.Data[id] = hydrate.ModelData{Versions: []superjson.Object{version(id*10, "Pony", nil)}}
			e.sources.images[id*10] = []superjson.Object{image(id*100, 9, 1, nil)}
		}
		e.sources.page.PrivacyDefaults[9] = hydrate.PrivacyDefaults{Downloads: true}
		e.sources.members[9] = member
		return e
	}
	e := setup(true)
	a, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := items(t, a)
	if field(t, got[0], "rank.downloadCount") != nil || field(t, got[0], "rank.tippedAmountCount") != nil ||
		field(t, got[0], "hiddenMetrics.buzz") != true || field(t, got[0], "hiddenMetrics.downloads") != true {
		t.Fatalf("member, other viewer: %v", got[0])
	}
	if field(t, got[1], "rank.downloadCount") != int64(10) {
		t.Fatalf("no flags: %v", got[1])
	}
	if !reflect.DeepEqual(e.sources.memberRq, [][]int{{9}}) {
		t.Fatalf("memberships read for %v, want only owner 9", e.sources.memberRq)
	}
	a, _ = serve(t, setup(true), baseInput(), &Viewer{ID: 9})
	if field(t, items(t, a)[0], "rank.downloadCount") != int64(10) {
		t.Fatal("the owner sees their own metrics")
	}
	a, _ = serve(t, setup(false), baseInput(), nil)
	if field(t, items(t, a)[0], "hiddenMetrics.downloads") != false {
		t.Fatal("a lapsed member hides nothing")
	}
}

// Excluded tags: a model wearing one is left out (even its owner's, as getModelsRaw does); an image
// wearing one is left out unless the viewer owns the model.
func TestServeExcludedTags(t *testing.T) {
	setup := func() *env {
		e := newEnv([]testRow{{id: 1, owner: 9, cursor: "x"}, {id: 2, owner: 8, cursor: "y"}})
		e.sources.page.Data[1] = hydrate.ModelData{TagIDs: []int{55}, Versions: []superjson.Object{version(10, "Pony", nil)}}
		e.sources.page.Data[2] = hydrate.ModelData{TagIDs: []int{1}, Versions: []superjson.Object{version(20, "Pony", nil)}}
		e.sources.images[20] = []superjson.Object{image(201, 8, 1, map[string]any{"tags": []any{int64(56)}}), image(202, 8, 1, nil)}
		return e
	}
	in := baseInput()
	in.ExcludedTagIDs = []int{55, 56}
	a, err := serve(t, setup(), in, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := items(t, a)
	if len(got) != 1 || field(t, got[0], "id") != int64(2) || len(field(t, got[0], "images").([]any)) != 1 {
		t.Fatalf("other viewer: %v", got)
	}
	a, _ = serve(t, setup(), in, &Viewer{ID: 8})
	if got := items(t, a); len(field(t, got[0], "images").([]any)) != 2 {
		t.Fatalf("owner keeps their images: %v", got)
	}
}

// The version filters: Published only, mature-restricted base models at a mature level dropped,
// non-Public versions dropped unless a creator is named, and a base-model filter selects.
func TestServeVersionFilters(t *testing.T) {
	e := newEnv([]testRow{{id: 1, owner: 9, cursor: "x"}, {id: 2, owner: 9, cursor: "y"}, {id: 3, owner: 9, cursor: "z"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{
		version(10, "SD 3.5", map[string]any{"nsfwLevel": int64(4)}), // mature-restricted on models
		version(11, "Pony", map[string]any{"status": "Draft"}),
		version(12, "Pony", map[string]any{"availability": "Private"}),
		version(13, "Illustrious", nil),
	}}
	e.sources.page.Data[2] = hydrate.ModelData{Versions: []superjson.Object{version(20, "Pony", map[string]any{"availability": "Private"})}}
	e.sources.page.Data[3] = hydrate.ModelData{Versions: []superjson.Object{version(30, "Pony", nil)}}
	for _, v := range []int{13, 20, 30} {
		e.sources.images[v] = []superjson.Object{image(v*10, 9, 1, nil)}
	}
	in := baseInput()
	in.Limit = 3
	a, err := serve(t, e, in, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := items(t, a)
	if len(got) != 2 || field(t, got[0], "version.id") != int64(13) || field(t, got[1], "id") != int64(3) {
		t.Fatalf("%v", got)
	}
	if bm := field(t, got[0], "baseModels"); !reflect.DeepEqual(bm, []any{"Illustrious"}) {
		t.Fatalf("baseModels %v", bm)
	}
	// A base-model filter keeps the matching versions only (an empty filter keeps none).
	e = newEnv([]testRow{{id: 3, owner: 9, cursor: "z"}})
	e.sources.page.Data[3] = hydrate.ModelData{Versions: []superjson.Object{version(30, "Pony", nil), version(31, "Illustrious", nil)}}
	e.sources.images[31] = []superjson.Object{image(310, 9, 1, nil)}
	in = baseInput()
	in.BaseModels = []string{"Illustrious"}
	a, _ = serve(t, e, in, nil)
	if got := items(t, a); len(got) != 1 || field(t, got[0], "version.id") != int64(31) ||
		!reflect.DeepEqual(field(t, got[0], "baseModels"), []any{"Pony", "Illustrious"}) {
		t.Fatalf("base-model filter: %v", got)
	}
	e = newEnv([]testRow{{id: 3, owner: 9, cursor: "z"}})
	e.sources.page.Data[3] = hydrate.ModelData{Versions: []superjson.Object{version(30, "Pony", nil)}}
	in.BaseModels = []string{}
	a, _ = serve(t, e, in, nil)
	if len(items(t, a)) != 0 {
		t.Fatal("an empty base-model list keeps no version")
	}
}

// A creator's own page shows their imageless models; nobody else's does.
func TestServeImageless(t *testing.T) {
	setup := func() *env {
		e := newEnv([]testRow{{id: 1, owner: 9, cursor: "x"}})
		e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
		e.sources.users["artist"] = 9
		return e
	}
	in := baseInput()
	in.Username = "artist"
	a, _ := serve(t, setup(), in, &Viewer{ID: 9})
	if len(items(t, a)) != 1 {
		t.Fatal("the owner on their own page sees an imageless model")
	}
	a, _ = serve(t, setup(), in, &Viewer{ID: 4})
	if len(items(t, a)) != 0 {
		t.Fatal("another viewer does not")
	}
	a, _ = serve(t, setup(), baseInput(), &Viewer{ID: 9})
	if len(items(t, a)) != 0 {
		t.Fatal("not on the main feed")
	}
}

// A taken-down model's versions are not read, but its cover is found on another version through the
// replica, as getCoverImages does.
func TestServeCoverFromAnotherVersion(t *testing.T) {
	e := newEnv([]testRow{{id: 1, owner: 9, cover: 777, mode: "TakenDown", cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[11] = []superjson.Object{image(777, 9, 1, nil)}
	e.covers = [][]any{{777, 9, 11, 1}}
	a, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := items(t, a)
	if len(got) != 1 || len(field(t, got[0], "images").([]any)) != 1 {
		t.Fatalf("%v", got)
	}
	if !reflect.DeepEqual(e.sources.versionRq, [][]int{{11}}) {
		t.Fatalf("version reads %v: the withheld version is not read, the cover's is", e.sources.versionRq)
	}
	// Under a base-model filter the cover stays on the shown version: no replica lookup.
	e = newEnv([]testRow{{id: 1, owner: 9, cover: 777, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
	in := baseInput()
	in.BaseModels = []string{"Pony"}
	if _, err := serve(t, e, in, nil); err != nil {
		t.Fatal(err)
	}
	for _, c := range e.db.Calls {
		if strings.Contains(c, `FROM "Image" i`) {
			t.Fatal("sameVersionOnly: no cover lookup")
		}
	}
}

// A chosen cover the owner lookup does not find can be a community image the creator featured in a
// version showcase, which Node's withCommunityCovers (model-cover.service.ts) serves as the cover.
// Not ported: a cover that has a featured, not-removed Community showcase row on one of the model's
// versions falls back, on every path getCoverImages takes to withCommunityCovers.
func TestServeCommunityCoverFallsBack(t *testing.T) {
	for _, c := range []struct {
		name string
		row  testRow
		edit func(e *env, in *Input)
	}{
		// Not on the shown version, and the replica places it in another user's post.
		{"a foreign image", testRow{id: 1, owner: 9, cover: 777, cursor: "x"}, func(e *env, _ *Input) {
			e.covers = [][]any{{777, 55, 12, 1}}
		}},
		// No Image row at all for the owner lookup (its post is gone): Node still asks.
		{"no image row", testRow{id: 1, owner: 9, cover: 777, cursor: "x"}, nil},
		// The owner's image, but the version's cached images do not hold it.
		{"an owner image not cached", testRow{id: 1, owner: 9, cover: 777, cursor: "x"}, func(e *env, _ *Input) {
			e.covers = [][]any{{777, 9, 11, 1}}
		}},
		// Under a base-model filter the owner lookup is skipped; withCommunityCovers still runs.
		{"a base-model filter", testRow{id: 1, owner: 9, cover: 777, cursor: "x"}, func(_ *env, in *Input) {
			in.BaseModels = []string{"Pony"}
		}},
		{"hide paid", testRow{id: 1, owner: 9, cover: 777, cursor: "x"}, func(_ *env, in *Input) { in.HidePaid = true }},
		// A .com viewer of a model with a .com face: the .com cover is the chosen one.
		{"the .com cover", testRow{id: 1, owner: 9, sfwName: "Safe", cover: 101, sfwCover: 777, nsfw: true, nsfwLevel: 1 | 4, cursor: "x"}, nil},
	} {
		e := newEnv([]testRow{c.row})
		e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
		e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil), image(101, 9, 4, nil)}
		e.community = [][]any{{1, 777}}
		in := baseInput()
		if c.edit != nil {
			c.edit(e, in)
		}
		_, err := serve(t, e, in, nil)
		if got := fallback.Reason(err); got != "model-community-cover" {
			t.Errorf("%s: %v (%q), want model-community-cover", c.name, err, got)
		}
		if !reflect.DeepEqual(e.communityArgs, [][]any{{[]int{777}, []int{1}}}) {
			t.Errorf("%s: community-cover reads %v, want [[[777] [1]]]", c.name, e.communityArgs)
		}
	}
}

// A cover Node's withCommunityCovers cannot change is served as before: found on the shown version
// or as the owner's image on another (no community read), or missing with no featured row for that
// model and image (the read finds none, or only another model's or another image's).
func TestServeCommunityCoverServed(t *testing.T) {
	// On the shown version.
	e := newEnv([]testRow{{id: 1, owner: 9, cover: 101, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil), image(101, 9, 1, nil)}
	e.community = [][]any{{1, 101}}
	a, err := serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatalf("shown version: %v (%q)", err, fallback.Reason(err))
	}
	if id, _ := field(t, items(t, a)[0], "images").([]any)[0].(superjson.Object).Get("id"); id != int64(101) {
		t.Fatalf("shown version: the cover first: %v", items(t, a)[0])
	}
	if len(e.communityArgs) != 0 {
		t.Fatalf("shown version: community-cover reads %v, want none", e.communityArgs)
	}

	// The owner's image on another version.
	e = newEnv([]testRow{{id: 1, owner: 9, cover: 777, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
	e.sources.images[11] = []superjson.Object{image(777, 9, 1, nil)}
	e.covers = [][]any{{777, 9, 11, 1}}
	e.community = [][]any{{1, 777}}
	a, err = serve(t, e, baseInput(), nil)
	if err != nil {
		t.Fatalf("another version: %v (%q)", err, fallback.Reason(err))
	}
	if id, _ := field(t, items(t, a)[0], "images").([]any)[0].(superjson.Object).Get("id"); id != int64(777) {
		t.Fatalf("another version: the cover first: %v", items(t, a)[0])
	}
	if len(e.communityArgs) != 0 {
		t.Fatalf("another version: community-cover reads %v, want none", e.communityArgs)
	}

	// Missing, and no featured row for this model and image.
	for name, rows := range map[string][][]any{
		"no row":          nil,
		"another model's": {{2, 777}},
		"another image's": {{1, 778}},
	} {
		e = newEnv([]testRow{{id: 1, owner: 9, cover: 777, cursor: "x"}})
		e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
		e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
		e.community = rows
		a, err = serve(t, e, baseInput(), nil)
		if err != nil {
			t.Fatalf("%s: %v (%q)", name, err, fallback.Reason(err))
		}
		if imgs := field(t, items(t, a)[0], "images").([]any); len(imgs) != 1 {
			t.Fatalf("%s: images %v, want the version's own", name, imgs)
		}
		if len(e.communityArgs) != 1 {
			t.Fatalf("%s: community-cover reads %v, want one", name, e.communityArgs)
		}
	}

	// A failed read is an error, never a served default.
	e = newEnv([]testRow{{id: 1, owner: 9, cover: 777, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
	e.db.Routes = append([]testkit.Route{{Match: `FROM "ModelVersionShowcaseItem" s`, Rows: func(_ []any) (*testkit.Rows, error) {
		return nil, errors.New("replica down")
	}}}, e.db.Routes...)
	if _, err := serve(t, e, baseInput(), nil); err == nil {
		t.Fatal("a failed community-cover read served")
	}
}

// Under Hide Paid getCoverImages keeps the cover on the shown version (sameVersionOnly), as under a
// base-model filter: no replica lookup of another version.
func TestServeHidePaidCoverSameVersionOnly(t *testing.T) {
	e := newEnv([]testRow{{id: 1, owner: 9, cover: 777, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
	e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
	e.sources.images[11] = []superjson.Object{image(777, 9, 1, nil)}
	e.covers = [][]any{{777, 9, 11, 1}}
	in := baseInput()
	in.HidePaid = true
	a, err := serve(t, e, in, nil)
	if err != nil {
		t.Fatalf("%v (%q)", err, fallback.Reason(err))
	}
	for _, c := range e.db.Calls {
		if strings.Contains(c, `FROM "Image" i`) {
			t.Fatal("hide paid: no cover lookup on another version")
		}
	}
	imgs := field(t, items(t, a)[0], "images").([]any)
	if id, _ := imgs[0].(superjson.Object).Get("id"); len(imgs) != 1 || id != int64(100) {
		t.Fatalf("hide paid: images %v, want the shown version's own", imgs)
	}
}

// A .com face: its name, its cover, its PG/PG-13 images, a blank version description.
func TestServeSfwFace(t *testing.T) {
	e := newEnv([]testRow{{id: 1, owner: 9, name: "Spicy", sfwName: "Safe", cover: 101, sfwCover: 102, nsfw: true, nsfwLevel: 1 | 4, cursor: "x"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", map[string]any{"description": "red"})}}
	e.sources.images[10] = []superjson.Object{image(101, 9, 4, nil), image(102, 9, 1, nil), image(103, 9, 2, nil)}
	a, err := serve(t, e, baseInput(), nil) // level 1: a .com viewer
	if err != nil {
		t.Fatal(err)
	}
	it := items(t, a)[0]
	if field(t, it, "name") != "Safe" || field(t, it, "hasSfwFace") != true || field(t, it, "version.description") != "" {
		t.Fatalf("%v", it)
	}
	imgs := field(t, it, "images").([]any)
	if len(imgs) != 1 {
		t.Fatalf("images %v: only the PG one at level 1", imgs)
	}
	if id, _ := imgs[0].(superjson.Object).Get("id"); id != int64(102) {
		t.Fatalf("the .com cover first: %v", imgs)
	}
}

func TestBuildGetAllModelImages(t *testing.T) {
	imgs := make([]superjson.Object, 0, 8)
	for i, lv := range []int{4, 4, 4, 4, 4, 4, 1, 2} {
		imgs = append(imgs, image(i, 1, lv, map[string]any{"onSite": true, "availability": "Public"}))
	}
	ids := func(l []any) []int64 {
		out := make([]int64, len(l))
		for i, x := range l {
			v, _ := x.(superjson.Object).Get("id")
			out[i] = v.(int64)
		}
		return out
	}
	if got := ids(buildGetAllModelImages(imgs)); !reflect.DeepEqual(got, []int64{0, 1, 2, 3, 6, 7}) {
		t.Fatalf("slim: %v", got)
	}
	// Within the cap the images pass through, in order.
	if got := ids(buildGetAllModelImages(imgs[:6])); !reflect.DeepEqual(got, []int64{0, 1, 2, 3, 4, 5}) {
		t.Fatalf("within the cap: %v", got)
	}
	o := buildGetAllModelImages(imgs[:1])[0].(superjson.Object)
	for _, k := range []string{"onSite", "availability"} {
		if _, ok := o.Get(k); ok {
			t.Fatalf("%s kept", k)
		}
	}
}

func TestFilterImagesForViewer(t *testing.T) {
	imgs := []superjson.Object{
		image(1, 5, 0, nil), image(2, 5, 1, nil), image(3, 5, 8, nil), image(4, 6, 1, map[string]any{"poi": true}),
		image(5, 6, 2, map[string]any{"minor": true}),
	}
	ids := func(l []superjson.Object) []int {
		out := make([]int, 0, len(l))
		for _, m := range l {
			n, _ := hydrate.Int(hydrate.ObjectField(m, "id"))
			out = append(out, n)
		}
		return out
	}
	if got := ids(filterImagesForViewer(imgs, 3, false, true, true, nil)); !reflect.DeepEqual(got, []int{2}) {
		t.Fatalf("signed out, SFW, poi and minor off: %v", got)
	}
	if got := ids(filterImagesForViewer(imgs, 3, false, true, true, &Viewer{ID: 6})); !reflect.DeepEqual(got, []int{2, 4, 5}) {
		t.Fatalf("the owner of 4 and 5: %v", got)
	}
	// A model marked nsfw keeps every image up to the highest level selected.
	if got := ids(filterImagesForViewer(imgs, 1|8, true, false, false, &Viewer{ID: 1, IsModerator: true})); !reflect.DeepEqual(got, []int{1, 2, 3, 4, 5}) {
		t.Fatalf("nsfw model, moderator: %v", got)
	}
	// The level is held to the selectable levels here too.
	if got := ids(filterImagesForViewer(imgs, 1|32, true, false, false, &Viewer{ID: 1, IsModerator: true})); !reflect.DeepEqual(got, []int{1, 2, 4}) {
		t.Fatalf("nsfw model, level 33: %v", got)
	}
	other := []superjson.Object{image(6, 5, 32, nil), image(7, 5, 1, nil)}
	if got := ids(filterImagesForViewer(other, 1|32, false, false, false, &Viewer{ID: 1, IsModerator: true})); !reflect.DeepEqual(got, []int{7}) {
		t.Fatalf("level 33: %v", got)
	}
}

func TestCanGenerate(t *testing.T) {
	for _, c := range []struct {
		covered, live bool
		base, typ     string
		flags         int
		want          bool
	}{
		{true, true, "SDXL 1.0", "Checkpoint", 0, true},
		{true, true, "SDXL 1.0", "Checkpoint", 2, false}, // GenerationDisabled
		{true, false, "Ernie", "Checkpoint", 0, false},   // a model-locked base model reads the live column
		{true, false, "Ernie", "LORA", 0, true},          // only a checkpoint is held to the live column
		{true, true, "Unknown Base", "Checkpoint", 0, false},
		{false, true, "Pony", "LORA", 0, false},
	} {
		if got := isGenerationEligible(c.covered, c.live, c.base, c.typ, c.flags); got != c.want {
			t.Errorf("%+v: %v", c, got)
		}
	}
	if toPublicAPIVersionFlags(2|32|64) != 2 {
		t.Fatal("partner bits must be stripped")
	}
	if !isMatureRestrictedModels("SD 3.5") || !isMatureRestrictedModels("sd 3.5") || isMatureRestrictedModels("Pony") {
		t.Fatal("isMatureRestricted(models)")
	}
}

func TestParseRankAndPrivacy(t *testing.T) {
	r := parseRank([]byte(`{"downloadCount":null,"thumbsUpCount":5}`))
	if r["downloadCount"] != int64(0) || r["thumbsUpCount"] != int64(5) || r["commentCount"] != int64(0) {
		t.Fatalf("%v", r)
	}
	p := parseMetaPrivacy([]byte(`{"metricVisibility":{"downloads":"show"},"hideDownloads":true,"hideGenerations":true}`))
	if p.visibility != [3]string{"", "show", "hide"} {
		t.Fatalf("%v", p.visibility)
	}
	def := hydrate.PrivacyDefaults{Buzz: true, Downloads: true}
	if got := hidden(p, def, false, true); got != [3]bool{true, false, true} {
		t.Fatalf("nearest explicit wins, else the default: %v", got)
	}
	if got := hidden(p, def, true, true); got != [3]bool{} {
		t.Fatal("owner or moderator sees all")
	}
}

// testCollection is one Collection row as the permission read sees it, with its contributor rows
// (user id → permissions).
type testCollection struct {
	read         string
	owner        int
	contributors map[int][]string
}

// withCollections answers the collection permission read from cols and records each read's SQL and
// arguments.
func withCollections(e *env, cols map[int]testCollection) *[][]any {
	reads := &[][]any{}
	var mu sync.Mutex
	e.db.Routes = append(e.db.Routes, testkit.Route{Match: `FROM "Collection" c`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
		mu.Lock()
		defer mu.Unlock()
		*reads = append(*reads, append([]any{norm(sql)}, args...))
		names := []string{"read", "userId", "permissions"}
		c, ok := cols[args[0].(int)]
		if !ok {
			return testkit.NewRows(names), nil
		}
		perms := []string{}
		if len(args) > 1 {
			if p, ok := c.contributors[args[1].(int)]; ok {
				perms = p
			}
		}
		return testkit.NewRows(names, []any{c.read, c.owner, perms}), nil
	}})
	return reads
}

// collectionInput is a parsed model.getAll input over a collection (Highest Rated, two models, PG).
func collectionInput(t *testing.T, extra string) *Input {
	t.Helper()
	in, err := parseJSON(t, `{"json":{"sort":"Highest Rated","limit":2,"browsingLevel":1`+extra+`}}`)
	if err != nil {
		t.Fatalf("Parse: %v (reason %q)", err, fallback.Reason(err))
	}
	return in
}

var testCollections = map[int]testCollection{
	41: {read: "Public", owner: 70},
	42: {read: "Private", owner: 71, contributors: map[int][]string{72: {"ADD"}, 73: {"VIEW", "ADD"}}},
	44: {read: "Unlisted", owner: 70},
}

// Who may read a collection, as getModelsRaw asks getUserCollectionPermissionsById (no moderator
// branch): a readable one is served with the CollectionItem semi-join, any other is an empty answer
// with no nextCursor and no page query.
func TestServeCollectionAccess(t *testing.T) {
	const (
		signedOut = `EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."modelId" = mm."modelId" AND ci."collectionId" = $1 AND ci."status" = 'ACCEPTED'::"CollectionItemStatus")`
		viewerFmt = `EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."modelId" = mm."modelId" AND ci."collectionId" = $1 AND (ci."status" = 'ACCEPTED'::"CollectionItemStatus" OR (ci."status" = 'REVIEW'::"CollectionItemStatus" AND ci."addedById" = $2)))`
	)
	for _, c := range []struct {
		name       string
		collection string
		viewer     *Viewer
		served     bool
		clause     string
		args       []any // the page query's leading arguments
	}{
		{"public, signed out", "41", nil, true, signedOut, []any{41}},
		{"public, signed in", "41", &Viewer{ID: 72}, true, viewerFmt, []any{41, 72}},
		{"unlisted, signed out", "44", nil, true, signedOut, []any{44}},
		{"private, its owner", "42", &Viewer{ID: 71}, true, viewerFmt, []any{42, 71}},
		{"private, a contributor with VIEW", "42", &Viewer{ID: 73}, true, viewerFmt, []any{42, 73}},
		{"private, a contributor without VIEW", "42", &Viewer{ID: 72}, false, "", nil},
		{"private, another viewer", "42", &Viewer{ID: 74}, false, "", nil},
		{"private, a moderator", "42", &Viewer{ID: 75, IsModerator: true}, false, "", nil},
		{"private, signed out", "42", nil, false, "", nil},
		{"no such collection", "49", &Viewer{ID: 71}, false, "", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv([]testRow{{id: 1, owner: 9, cursor: "c1"}})
			e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", nil)}}
			e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
			reads := withCollections(e, testCollections)
			ans, err := serve(t, e, collectionInput(t, `,"collectionId":`+c.collection), c.viewer)
			if err != nil {
				t.Fatalf("Serve: %v (reason %q)", err, fallback.Reason(err))
			}
			if len(*reads) != 1 {
				t.Fatalf("%d permission reads, want 1", len(*reads))
			}
			// The contributor row is joined exactly when there is a viewer, bound as the second argument.
			read := (*reads)[0]
			joined := strings.Contains(read[0].(string), `LEFT JOIN "CollectionContributor" cc ON cc."collectionId" = c.id AND cc."userId" = $2`)
			if want := c.viewer != nil; joined != want || len(read) != map[bool]int{true: 3, false: 2}[want] {
				t.Fatalf("permission read %v: contributor join %v, want %v", read, joined, want)
			}
			if !c.served {
				if len(e.queries) != 0 || !ans.Trivial || len(items(t, ans)) != 0 {
					t.Fatalf("unreadable: %d page queries, trivial %v, %d items; want 0, true, 0", len(e.queries), ans.Trivial, len(items(t, ans)))
				}
				if v, _ := ans.Value.Get("nextCursor"); v != (superjson.Undefined{}) {
					t.Fatalf("nextCursor %#v, want undefined", v)
				}
				return
			}
			if len(e.queries) != 1 || len(items(t, ans)) != 1 {
				t.Fatalf("readable: %d page queries, %d items; want 1, 1", len(e.queries), len(items(t, ans)))
			}
			if q := norm(e.queries[0]); !strings.Contains(q, c.clause) {
				t.Fatalf("page query lacks\n %s\nin\n %s", c.clause, q)
			}
			if got := e.args[0][:len(c.args)]; !reflect.DeepEqual(got, c.args) {
				t.Fatalf("leading args %#v, want %#v", got, c.args)
			}
		})
	}
}

// Across the page loop the permission is read on every page, as Node reads it on every getModelsRaw
// call, and every page carries the semi-join (with the collection tag); the answer keeps the previous page's cursor as for any feed.
func TestServeCollectionPagesAndTag(t *testing.T) {
	e := newEnv(
		[]testRow{{id: 1, owner: 9, cursor: "c1"}, {id: 2, owner: 9, cursor: "c2"}, {id: 3, owner: 9, cursor: "5|5|3"}},
		[]testRow{{id: 4, owner: 9, cursor: "c4"}},
	)
	for _, id := range []int{1, 4} {
		e.sources.page.Data[id] = hydrate.ModelData{Versions: []superjson.Object{version(id*10, "Pony", nil)}}
		e.sources.images[id*10] = []superjson.Object{image(id*100, 9, 1, nil)}
	}
	reads := withCollections(e, testCollections)
	ans, err := serve(t, e, collectionInput(t, `,"collectionId":42,"collectionTagId":88`), &Viewer{ID: 71})
	if err != nil {
		t.Fatalf("Serve: %v (reason %q)", err, fallback.Reason(err))
	}
	if got := items(t, ans); len(got) != 2 || field(t, got[0], "id") != int64(1) || field(t, got[1], "id") != int64(4) {
		t.Fatalf("items %v", got)
	}
	if v, _ := ans.Value.Get("nextCursor"); v != "5|5|3" {
		t.Fatalf("nextCursor %v, want 5|5|3", v)
	}
	if len(*reads) != 2 || len(e.queries) != 2 {
		t.Fatalf("%d permission reads and %d page queries, want 2 and 2", len(*reads), len(e.queries))
	}
	for i, q := range e.queries {
		if !strings.Contains(norm(q), `AND ci."addedById" = $2)) AND ci."tagId" = $3)`) || !reflect.DeepEqual(e.args[i][:3], []any{42, 71, 88}) {
			t.Fatalf("page %d: %s %v", i+1, norm(q), e.args[i])
		}
	}
	// The second page starts from the first page's lookahead, after the collection's arguments.
	if !reflect.DeepEqual(e.args[1][3:6], []any{int64(5), int64(5), int64(5)}) {
		t.Fatalf("second page args %v", e.args[1])
	}
	// A collection tag without a collection is no filter (getModelsRaw reads it only inside the
	// collection branch).
	e = newEnv([]testRow{})
	reads = withCollections(e, testCollections)
	if _, err := serve(t, e, collectionInput(t, `,"collectionTagId":88`), nil); err != nil {
		t.Fatal(err)
	}
	if len(*reads) != 0 || strings.Contains(e.queries[0], "CollectionItem") {
		t.Fatalf("a tag alone: %d permission reads, query %s", len(*reads), norm(e.queries[0]))
	}
}

// With a collection, getModelsRaw's hidePrivateModels is off: a Private version is listed (here the
// first version, so the card shows it).
func TestServeCollectionShowsPrivateVersions(t *testing.T) {
	run := func(extra string) any {
		e := newEnv([]testRow{{id: 1, owner: 9, cursor: "c1"}})
		e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{
			version(10, "Pony", map[string]any{"availability": "Private"}), version(11, "Pony", nil),
		}}
		e.sources.images[10] = []superjson.Object{image(100, 9, 1, nil)}
		e.sources.images[11] = []superjson.Object{image(110, 9, 1, nil)}
		withCollections(e, testCollections)
		ans, err := serve(t, e, collectionInput(t, extra), nil)
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", extra, err, fallback.Reason(err))
		}
		return field(t, items(t, ans)[0], "version.id")
	}
	if got := run(""); got != int64(11) {
		t.Fatalf("no collection: version %v, want 11 (the Private one hidden)", got)
	}
	if got := run(`,"collectionId":41`); got != int64(10) {
		t.Fatalf("a collection: version %v, want 10 (the Private one listed)", got)
	}
}

// Node's order inside getModelsRaw: the creator lookup (a 404 for an unknown name) comes before the
// collection check, and the cursor is parsed after it, so a bad cursor on an unreadable collection is
// still the empty answer while on a readable one it is Node's 400.
func TestServeCollectionCheckOrder(t *testing.T) {
	e := newEnv()
	reads := withCollections(e, testCollections)
	if _, err := serve(t, e, collectionInput(t, `,"collectionId":42,"username":"nobody"`), nil); fallback.Reason(err) != "model-username-miss" || len(*reads) != 0 {
		t.Fatalf("unknown creator: %v, %d permission reads; want model-username-miss before any", err, len(*reads))
	}
	e = newEnv()
	withCollections(e, testCollections)
	ans, err := serve(t, e, collectionInput(t, `,"collectionId":42,"cursor":"x|y"`), nil)
	if err != nil || !ans.Trivial || len(e.queries) != 0 {
		t.Fatalf("bad cursor, unreadable collection: %v; want the empty answer", err)
	}
	e = newEnv()
	withCollections(e, testCollections)
	if _, err := serve(t, e, collectionInput(t, `,"collectionId":41,"cursor":"x|y"`), nil); fallback.Reason(err) != "model-cursor" {
		t.Fatalf("bad cursor, readable collection: %v; want model-cursor", err)
	}
}
