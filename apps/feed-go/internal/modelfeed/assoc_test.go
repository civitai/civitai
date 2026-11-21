package modelfeed

import (
	"context"
	"errors"
	"strconv"
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

// fakePrefs answers HiddenUserIDs.
type fakePrefs struct {
	ids   []int
	miss  bool
	err   error
	asked []int
}

func (f *fakePrefs) HiddenUserIDs(_ context.Context, userID int) ([]int, bool, error) {
	f.asked = append(f.asked, userID)
	if f.err != nil {
		return nil, false, f.err
	}
	if f.miss {
		return nil, false, nil
	}
	return f.ids, true, nil
}

// fakeGates answers GateRules.
type fakeGates struct {
	rules []GateRule
	err   error
	calls int
}

func (f *fakeGates) GateRules(context.Context) ([]GateRule, error) {
	f.calls++
	return f.rules, f.err
}

// assocEnv is an AssocDeps over fakes: the source model row, the association rows, the approved
// promotion count, the page query's rows and the image query's rows, each recorded when asked.
type assocEnv struct {
	deps       *AssocDeps
	sources    *fakeSources
	gallery    *fakeGallery
	prefs      *fakePrefs
	gates      *fakeGates
	db         *testkit.DB
	source     []any // poi, userId; nil = no row
	targets    [][]any
	promotions int
	rows       []testRow
	paid       map[int]*time.Time
	images     [][]any

	mu         sync.Mutex
	pageSQL    []string
	pageArgs   [][]any
	imageSQL   []string
	imageArgs  [][]any
	promoReads int
	srcReads   int
}

func newAssocEnv(rows ...testRow) *assocEnv {
	e := &assocEnv{
		rows: rows,
		paid: map[int]*time.Time{},
		sources: &fakeSources{
			page: hydrate.ModelPage{
				Basic: map[int]hydrate.BasicUser{}, ProfilePics: map[int]superjson.Object{}, UserCosmetics: map[int][]any{},
				Data: map[int]hydrate.ModelData{}, Frames: map[int]superjson.Object{}, Decorations: map[int]superjson.Object{},
				PrivacyDefaults: map[int]hydrate.PrivacyDefaults{},
			},
			images: map[int][]superjson.Object{}, members: map[int]bool{}, users: map[string]int{},
		},
		gallery: &fakeGallery{settings: map[int]*feed.GallerySettings{}},
		prefs:   &fakePrefs{},
		gates:   &fakeGates{},
	}
	e.db = &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "Model" WHERE "id" = $1`, Rows: func(_ []any) (*testkit.Rows, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.srcReads++
			if e.source == nil {
				return testkit.NewRows([]string{"poi", "userId"}), nil
			}
			return testkit.NewRows([]string{"poi", "userId"}, e.source), nil
		}},
		{Match: `FROM "ModelAssociations"`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"toModelId", "toArticleId"}, e.targets...), nil
		}},
		{Match: `FROM "Placement"`, Rows: func(_ []any) (*testkit.Rows, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.promoReads++
			return testkit.NewRows([]string{"count"}, []any{int64(e.promotions)}), nil
		}},
		{Match: `"cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.pageSQL = append(e.pageSQL, sql)
			e.pageArgs = append(e.pageArgs, args)
			out := make([][]any, len(e.rows))
			for i, r := range e.rows {
				out[i] = r.values()
			}
			return testkit.NewRows(modelColumns, out...), nil
		}},
		{Match: `GROUP BY mv."modelId"`, Rows: func(args []any) (*testkit.Rows, error) {
			var out [][]any
			for _, id := range args[0].([]int) {
				if d, ok := e.paid[id]; ok {
					var v any
					if d != nil {
						v = *d
					}
					out = append(out, []any{id, v})
				}
			}
			return testkit.NewRows([]string{"modelId", "deadline"}, out...), nil
		}},
		{Match: `AS full_mv(id)`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.imageSQL = append(e.imageSQL, sql)
			e.imageArgs = append(e.imageArgs, args)
			return testkit.NewRows(assocImageColumns, e.images...), nil
		}},
	}}
	e.deps = &AssocDeps{
		Deps: &Deps{
			DB: e.db, Sources: e.sources, Gallery: e.gallery,
			Addons: func(context.Context) []browsing.Addon { return nil },
			Config: Config{CoverageNext: true, LoadingOpenToAll: true, BaseModelMetrics: true, ImagesSlim: true},
			Now:    func() time.Time { return testNow },
		},
		Prefs: e.prefs, Gates: e.gates, Promotions: feed.PromotionsOff,
	}
	return e
}

// assocImageRow is one image-query row, in assocImageColumns order; extra overrides a column.
func assocImageRow(id, owner, level, versionID int, extra map[string]any) []any {
	m := map[string]any{
		"id": id, "userId": owner, "name": nil, "url": "u" + strconv.Itoa(id), "nsfwLevel": level, "width": 512, "height": 768,
		"hash": nil, "type": "image", "metadata": `{"width": 512}`, "minor": false, "poi": false,
		"modelVersionId": versionID, "availability": "Public", "hasMeta": true, "hasPositivePrompt": false,
		"onSite": false, "remixOfId": nil,
	}
	for k, v := range extra {
		m[k] = v
	}
	out := make([]any, len(assocImageColumns))
	for i, c := range assocImageColumns {
		out[i] = m[c]
	}
	return out
}

func assocIn(fromID int, level *int) *AssocInput {
	return &AssocInput{FromID: fromID, Type: AssociationSuggested, BrowsingLevel: level}
}

func lvl(n int) *int { return &n }

func assocServe(t *testing.T, e *assocEnv, req AssocRequest) (*AssocAnswer, error) {
	t.Helper()
	return ServeAssociated(context.Background(), e.deps, req)
}

// cardIDs is the answer's card ids, in order.
func cardIDs(t *testing.T, a *AssocAnswer) []int64 {
	t.Helper()
	out := make([]int64, len(a.Value))
	for i, v := range a.Value {
		o := v.(superjson.Object)
		id, _ := o.Get("id")
		out[i] = id.(int64)
	}
	return out
}

func cardField(t *testing.T, a *AssocAnswer, i int, key string) any {
	t.Helper()
	v, ok := a.Value[i].(superjson.Object).Get(key)
	if !ok {
		t.Fatalf("card %d has no %s", i, key)
	}
	return v
}

func wantReason(t *testing.T, err error, reason string) {
	t.Helper()
	if got := fallback.Reason(err); got != reason {
		t.Fatalf("fallback %q (%v), want %q", got, err, reason)
	}
}

// twoModelEnv is two associated models with one image each, the plainest world the tests vary.
func twoModelEnv() *assocEnv {
	e := newAssocEnv(
		testRow{id: 5001, owner: 1001, name: "Model One"},
		testRow{id: 5002, owner: 1002, name: "Model Two", typ: "LORA"},
	)
	e.targets = [][]any{{5002, nil}, {5001, nil}}
	s := e.sources
	s.page.Basic[1001] = hydrate.BasicUser{ID: 1001, Username: "artist_one"}
	s.page.Data[5001] = hydrate.ModelData{Hashes: []any{"ABCDEF"}, TagIDs: []int{7},
		Versions: []superjson.Object{version(6001, "SDXL 1.0", map[string]any{"flags": int64(32)})}}
	s.page.Data[5002] = hydrate.ModelData{Hashes: []any{}, TagIDs: []int{},
		Versions: []superjson.Object{version(6003, "Pony", map[string]any{"covered": false, "coveredNext": false})}}
	e.images = [][]any{assocImageRow(8001, 1001, 1, 6001, map[string]any{"name": "img", "hash": "h1"}), assocImageRow(8003, 1002, 1, 6003, nil)}
	return e
}

// The whole answer, compared with the answer Node gives for the same rows, cache values and image
// rows (written out by hand from getAssociatedResourcesCardDataHandler and getModelsRaw): the
// association order with a repeated id repeated, the cards' head as model.getAll's, the image rows
// untrimmed, canGenerate from the version's coverage, `sponsored: false`.
func TestAssocWholeAnswer(t *testing.T) {
	e := twoModelEnv()
	e.targets = [][]any{{5002, nil}, {5001, nil}, {5002, nil}}
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Cap: browsing.PublicLevels})
	if err != nil {
		t.Fatalf("ServeAssociated: %v (%q)", err, fallback.Reason(err))
	}
	payload, err := superjson.Serialize(ans.Value)
	if err != nil {
		t.Fatal(err)
	}
	card2 := `{"resourceType":"model","id":5002,"name":"Model Two","coverImageId":null,"sfwCoverImageId":null,"type":"LORA","minor":false,"sfwOnly":false,
	   "poi":false,"nsfw":false,"nsfwLevel":1,"status":"Published","createdAt":"2026-01-02T03:04:05.000Z",
	   "lastVersionAt":"2026-06-01T00:00:00.000Z","publishedAt":"2026-06-01T00:00:00.000Z","locked":false,"mode":null,
	   "availability":"Public","userId":1002,"earlyAccessDeadline":null,"hasActivePaidAccess":false,"hasSfwFace":false,
	   "baseModels":["Pony"],
	   "user":{"id":1002,"username":null,"deletedAt":null,"image":null,"profilePicture":null,"cosmetics":[]},
	   "cosmetic":null,"eventDecoration":null,"tags":[],"hashes":[],
	   "hiddenMetrics":{"buzz":false,"downloads":false,"generations":false},
	   "rank":{"downloadCount":10,"thumbsUpCount":20,"thumbsDownCount":1,"commentCount":2,"collectedCount":3,"tippedAmountCount":4},
	   "images":[{"id":8003,"userId":1002,"name":null,"url":"u8003","nsfwLevel":1,"width":512,"height":768,"hash":null,"type":"image",
	     "metadata":{"width":512},"minor":false,"poi":false,"modelVersionId":6003,"availability":"Public","hasMeta":true,
	     "hasPositivePrompt":false,"onSite":false,"remixOfId":null}],
	   "canGenerate":false,
	   "version":{"id":6003,"name":"vPony","baseModel":"Pony","status":"Published","availability":"Public","nsfwLevel":1,
	     "flags":0,"covered":false,"coveredNext":false},
	   "sponsored":false}`
	card1 := `{"resourceType":"model","id":5001,"name":"Model One","coverImageId":null,"sfwCoverImageId":null,"type":"Checkpoint","minor":false,"sfwOnly":false,
	   "poi":false,"nsfw":false,"nsfwLevel":1,"status":"Published","createdAt":"2026-01-02T03:04:05.000Z",
	   "lastVersionAt":"2026-06-01T00:00:00.000Z","publishedAt":"2026-06-01T00:00:00.000Z","locked":false,"mode":null,
	   "availability":"Public","userId":1001,"earlyAccessDeadline":null,"hasActivePaidAccess":false,"hasSfwFace":false,
	   "baseModels":["SDXL 1.0"],
	   "user":{"id":1001,"username":"artist_one","deletedAt":null,"image":null,"profilePicture":null,"cosmetics":[]},
	   "cosmetic":null,"eventDecoration":null,"tags":[7],"hashes":["abcdef"],
	   "hiddenMetrics":{"buzz":false,"downloads":false,"generations":false},
	   "rank":{"downloadCount":10,"thumbsUpCount":20,"thumbsDownCount":1,"commentCount":2,"collectedCount":3,"tippedAmountCount":4},
	   "images":[{"id":8001,"userId":1001,"name":"img","url":"u8001","nsfwLevel":1,"width":512,"height":768,"hash":"h1","type":"image",
	     "metadata":{"width":512},"minor":false,"poi":false,"modelVersionId":6001,"availability":"Public","hasMeta":true,
	     "hasPositivePrompt":false,"onSite":false,"remixOfId":null}],
	   "canGenerate":true,
	   "version":{"id":6001,"name":"vSDXL 1.0","baseModel":"SDXL 1.0","status":"Published","availability":"Public","nsfwLevel":1,
	     "flags":0,"covered":true,"coveredNext":true},
	   "sponsored":false}`
	dates := func(i string) string {
		return `"` + i + `.createdAt":["Date"],"` + i + `.lastVersionAt":["Date"],"` + i + `.publishedAt":["Date"]`
	}
	node := `{"json":[` + card2 + `,` + card1 + `,` + card2 + `],"meta":{"values":{` + dates("0") + `,` + dates("1") + `,` + dates("2") + `},"v":1}}`
	rep, err := shadow.Compare(payload, []byte(node))
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Match {
		t.Fatalf("differs from Node's answer: %+v\n%s", rep.Diffs, payload)
	}
	if ans.Trivial {
		t.Fatal("a loaded answer is not trivial")
	}
	// The page query is restricted to the distinct ids, sorted Highest Rated, at the capped level.
	if len(e.pageSQL) != 1 || !strings.Contains(e.pageSQL[0], `."thumbsUpCount" DESC`) {
		t.Fatalf("page query: %v", e.pageSQL)
	}
	if !argsHave(e.pageArgs[0], []int{5002, 5001}) {
		t.Fatalf("page query args %v do not bind the distinct ids [5002 5001]", e.pageArgs[0])
	}
	// One image read over both shown versions; signed out the hidden lists are user -1's.
	if len(e.imageArgs) != 1 || !argsHave(e.imageArgs[0], []int{6001, 6003}) && !argsHave(e.imageArgs[0], []int{6003, 6001}) {
		t.Fatalf("image query args %v", e.imageArgs)
	}
	if len(e.prefs.asked) != 1 || e.prefs.asked[0] != -1 {
		t.Fatalf("hidden prefs read for %v, want [-1]", e.prefs.asked)
	}
	// The promotions flag is known off: no promotion read.
	if e.promoReads != 0 {
		t.Fatalf("promotion reads %d, want 0", e.promoReads)
	}
}

func argsHave(args []any, ids []int) bool {
	for _, a := range args {
		if l, ok := a.([]int); ok && len(l) == len(ids) {
			same := true
			for i := range l {
				same = same && l[i] == ids[i]
			}
			if same {
				return true
			}
		}
	}
	return false
}

// The cards follow the association order; a model whose owner the viewer hides or blocks (either
// way) is dropped; a model the page query did not return is absent.
func TestAssocOrderAndHiddenUsers(t *testing.T) {
	e := twoModelEnv()
	e.targets = [][]any{{5001, nil}, {5003, nil}, {5002, nil}}
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Cap: browsing.PublicLevels})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 2 || got[0] != 5001 || got[1] != 5002 {
		t.Fatalf("cards %v, want [5001 5002]", got)
	}
	e = twoModelEnv()
	e.prefs.ids = []int{1002}
	viewer := &Viewer{ID: 1003}
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: viewer})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 1 || got[0] != 5001 {
		t.Fatalf("cards %v, want [5001]: 1002 is hidden", got)
	}
	if len(e.prefs.asked) != 1 || e.prefs.asked[0] != 1003 {
		t.Fatalf("hidden prefs read for %v, want the viewer 1003", e.prefs.asked)
	}
}

// No association is the trivial empty answer, read with nothing else; associations the page query
// answers no row for are an empty, trivial answer too.
func TestAssocEmpty(t *testing.T) {
	e := twoModelEnv()
	e.targets = nil
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, nil)})
	if err != nil || !ans.Trivial || len(ans.Value) != 0 {
		t.Fatalf("no associations: %v %+v", err, ans)
	}
	if len(e.pageSQL) != 0 || len(e.prefs.asked) != 0 {
		t.Fatal("no association must read no page and no hidden list")
	}
	e = twoModelEnv()
	e.rows = nil
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, nil)})
	if err != nil || !ans.Trivial || len(ans.Value) != 0 {
		t.Fatalf("no rows: %v %+v", err, ans)
	}
	payload, _ := superjson.Serialize(ans.Value)
	if string(payload) != `{"json":[]}` {
		t.Fatalf("empty answer = %s, want an empty array", payload)
	}
}

// A card with no image after the read, the hold and the viewer filter is dropped (no showImageless
// for this input); a taken-down model the viewer may see keeps its card with no images.
func TestAssocImagelessAndWithheld(t *testing.T) {
	e := twoModelEnv()
	e.images = e.images[:1] // 6003 has none
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 1 || got[0] != 5001 {
		t.Fatalf("cards %v, want [5001]", got)
	}
	e = twoModelEnv()
	e.rows[0].mode = "TakenDown"
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1001}})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 2 {
		t.Fatalf("cards %v, want both", got)
	}
	if imgs := cardField(t, ans, 1, "images").([]any); len(imgs) != 0 {
		t.Fatalf("withheld card images = %v, want []", imgs)
	}
	if imgs := cardField(t, ans, 0, "images").([]any); len(imgs) != 1 {
		t.Fatalf("other card images = %v, want 1", imgs)
	}
}

// The image filter: an unrated image is its owner's and moderators'; a poi image is dropped under the
// addons' disablePoi except for its owner.
func TestAssocImageFilter(t *testing.T) {
	e := twoModelEnv()
	e.images = [][]any{assocImageRow(8001, 1001, 0, 6001, nil), assocImageRow(8003, 1002, 1, 6003, nil)}
	for _, c := range []struct {
		viewer *Viewer
		want   int
	}{{nil, 1}, {&Viewer{ID: 1001}, 2}, {&Viewer{ID: 1004, IsModerator: true}, 2}} {
		ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: c.viewer})
		if err != nil {
			t.Fatal(err)
		}
		if got := len(ans.Value); got != c.want {
			t.Errorf("viewer %+v: %d cards, want %d", c.viewer, got, c.want)
		}
	}
	e = twoModelEnv()
	e.images = [][]any{assocImageRow(8001, 1001, 1, 6001, map[string]any{"poi": true}), assocImageRow(8003, 1002, 1, 6003, nil)}
	e.deps.Addons = func(context.Context) []browsing.Addon {
		yes := true
		return []browsing.Addon{{Type: "some", NsfwLevels: []int{1}, DisablePoi: &yes}}
	}
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 1 || got[0] != 5002 {
		t.Fatalf("poi image under disablePoi: cards %v, want [5002]", got)
	}
}

// The showcase hold: an SFW-only model's images are held to its level (SFW without a stored
// setting) except for its owner; moderators read no settings at all.
func TestAssocShowcaseHold(t *testing.T) {
	e := twoModelEnv()
	e.rows[0].sfwOnly = true
	e.images = [][]any{assocImageRow(8001, 1001, 4, 6001, nil), assocImageRow(8003, 1002, 1, 6003, nil)}
	e.gallery.settings[5001] = &feed.GallerySettings{}
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(31))})
	if err != nil {
		t.Fatal(err)
	}
	if got := cardIDs(t, ans); len(got) != 1 || got[0] != 5002 {
		t.Fatalf("held R image: cards %v, want [5002]", got)
	}
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(31)), Viewer: &Viewer{ID: 1001}})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(ans.Value); got != 2 {
		t.Fatalf("owner: %d cards, want 2", got)
	}
	delete(e.gallery.settings, 5001) // a moderator never reads it (the fake would fall back)
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(31)), Viewer: &Viewer{ID: 1004, IsModerator: true}})
	if err != nil {
		t.Fatalf("moderator: %v", err)
	}
	if got := len(ans.Value); got != 2 {
		t.Fatalf("moderator: %d cards, want 2", got)
	}
}

// Metric privacy: a hidden download count is null for a viewer outside the owner's membership rule.
func TestAssocMetricPrivacy(t *testing.T) {
	e := twoModelEnv()
	e.rows[1].meta = `{"metricVisibility":{"downloads":"hide"}}`
	e.sources.members[1002] = true
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))})
	if err != nil {
		t.Fatal(err)
	}
	rank := cardField(t, ans, 0, "rank").(superjson.Object)
	if v, _ := rank.Get("downloadCount"); v != nil {
		t.Fatalf("hidden downloadCount = %v, want null", v)
	}
	hid := cardField(t, ans, 0, "hiddenMetrics").(superjson.Object)
	if v, _ := hid.Get("downloads"); v != true {
		t.Fatalf("hiddenMetrics.downloads = %v", v)
	}
	// The owner sees it.
	ans, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1002}})
	if err != nil {
		t.Fatal(err)
	}
	rank = cardField(t, ans, 0, "rank").(superjson.Object)
	if v, _ := rank.Get("downloadCount"); v != int64(10) {
		t.Fatalf("owner downloadCount = %v, want 10", v)
	}
}

func TestAssocLevel(t *testing.T) {
	for _, c := range []struct {
		name  string
		in    *int
		isMod bool
		cap   int
		want  int
	}{
		{"absent, uncapped: the schema default", nil, false, 0, 31},
		{"absent, capped: the cap", nil, false, 1, 1},
		{"non-moderator: Blocked stripped", lvl(63), false, 0, 31},
		{"moderator: kept", lvl(63), true, 0, 63},
		{"disjoint with the cap: the cap", lvl(4), false, 3, 3},
		{"within the cap", lvl(6), false, 3, 2},
		{"zero, capped: the cap", lvl(0), false, 1, 1},
		{"zero, uncapped: zero", lvl(0), false, 0, 0},
	} {
		if got := assocLevel(assocIn(1, c.in), c.isMod, c.cap); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}

// The source model's POI rule (modelVisibleToViewer): hidden from strangers and signed-out viewers,
// visible to its owner; a moderator, and a fromId of 0, read nothing.
func TestAssocSourceVisibility(t *testing.T) {
	e := twoModelEnv()
	e.source = []any{true, 1001}
	_, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))})
	wantReason(t, err, "model-assoc-source-hidden")
	_, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1003}})
	wantReason(t, err, "model-assoc-source-hidden")
	if _, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1001}}); err != nil {
		t.Fatalf("owner: %v", err)
	}
	reads := e.srcReads
	if _, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1004, IsModerator: true}}); err != nil {
		t.Fatalf("moderator: %v", err)
	}
	if _, err = assocServe(t, e, AssocRequest{Input: assocIn(0, lvl(1))}); err != nil {
		t.Fatalf("fromId 0: %v", err)
	}
	if e.srcReads != reads {
		t.Fatalf("a moderator or fromId 0 read the source model (%d reads)", e.srcReads-reads)
	}
	// Not POI, or no such model: served.
	e.source = []any{false, 1001}
	if _, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))}); err != nil {
		t.Fatalf("not poi: %v", err)
	}
	e.source = nil
	if _, err = assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))}); err != nil {
		t.Fatalf("no row: %v", err)
	}
}

// Every other fallback, each reached by a request no earlier check refuses.
func TestAssocFallbacks(t *testing.T) {
	cases := []struct {
		reason string
		setup  func(e *assocEnv) AssocRequest
	}{
		{"model-assoc-banned-session", func(e *assocEnv) AssocRequest {
			return AssocRequest{Input: assocIn(9001, lvl(1)), Banned: true}
		}},
		{"model-assoc-sponsored", func(e *assocEnv) AssocRequest {
			e.deps.Promotions = feed.PromotionsUnknown
			e.promotions = 1
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"model-assoc-articles", func(e *assocEnv) AssocRequest {
			e.targets = [][]any{{5001, nil}, {nil, 77}}
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"model-assoc-many", func(e *assocEnv) AssocRequest {
			e.targets = nil
			for i := 0; i <= assocModelCap; i++ {
				e.targets = append(e.targets, []any{10000 + i, nil})
			}
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"model-assoc-hidden-prefs-miss", func(e *assocEnv) AssocRequest {
			e.prefs.miss = true
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"model-assoc-hidden-prefs-unconfigured", func(e *assocEnv) AssocRequest {
			e.deps.Prefs = nil
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"model-assoc-wildcards", func(e *assocEnv) AssocRequest {
			e.rows[1].typ = "Wildcards"
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"gate-rules-unconfigured", func(e *assocEnv) AssocRequest {
			e.deps.Gates = nil
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"gate-rules-ecosystem", func(e *assocEnv) AssocRequest {
			e.gates.rules = []GateRule{{AvailableTo: "nobody", Presentation: "hidden", Ecosystems: []string{"SDXL"}}}
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
		{"gate-rules-testers", func(e *assocEnv) AssocRequest {
			e.gates.rules = []GateRule{{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{6001}}}
			return AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1003}}
		}},
		{"model-assoc-unconfigured", func(e *assocEnv) AssocRequest {
			e.deps = &AssocDeps{}
			return AssocRequest{Input: assocIn(9001, lvl(1))}
		}},
	}
	for _, c := range cases {
		t.Run(c.reason, func(t *testing.T) {
			e := twoModelEnv()
			req := c.setup(e)
			_, err := assocServe(t, e, req)
			wantReason(t, err, c.reason)
		})
	}
	// Positive control for the reached checks: the same world with no setup is served.
	if _, err := assocServe(t, twoModelEnv(), AssocRequest{Input: assocIn(9001, lvl(1))}); err != nil {
		t.Fatalf("control: %v", err)
	}
}

// The promotion read: none with the flag known off for the viewer, one otherwise; no approved run is
// served.
func TestAssocPromotionRead(t *testing.T) {
	for _, c := range []struct {
		audience feed.PromotionAudience
		viewer   *Viewer
		reads    int
	}{
		{feed.PromotionsOff, nil, 0},
		{feed.PromotionsModsTesters, nil, 0},
		{feed.PromotionsModsTesters, &Viewer{ID: 1003}, 1},
		{feed.PromotionsEveryone, nil, 1},
		{feed.PromotionsUnknown, nil, 1},
	} {
		e := twoModelEnv()
		e.deps.Promotions = c.audience
		if _, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: c.viewer}); err != nil {
			t.Fatalf("%v: %v", c.audience, err)
		}
		if e.promoReads != c.reads {
			t.Errorf("audience %v viewer %+v: %d promotion reads, want %d", c.audience, c.viewer, e.promoReads, c.reads)
		}
	}
}

// canGenerate: the version's coverage (the next column with the flag on, the live one off), a
// Private version for its owner and moderators only, a hidden gate rule on the version for the viewers
// it gates; a disabled rule changes nothing.
func TestAssocCanGenerate(t *testing.T) {
	gen := func(e *assocEnv, viewer *Viewer) bool {
		t.Helper()
		ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: viewer})
		if err != nil {
			t.Fatalf("%v (%q)", err, fallback.Reason(err))
		}
		for i := range ans.Value {
			if id, _ := ans.Value[i].(superjson.Object).Get("id"); id == int64(5001) {
				return cardField(t, ans, i, "canGenerate").(bool)
			}
		}
		t.Fatal("no card 5001")
		return false
	}
	e := twoModelEnv()
	if !gen(e, nil) {
		t.Fatal("covered SDXL checkpoint: want true")
	}
	e.sources.page.Data[5001].Versions[0]["coveredNext"] = false
	if gen(e, nil) {
		t.Fatal("not covered under the next column: want false")
	}
	e.deps.Config.CoverageNext = false
	if !gen(e, nil) {
		t.Fatal("flag off reads the live column: want true")
	}
	e = twoModelEnv()
	e.sources.page.Data[5001].Versions[0]["availability"] = "Private"
	if gen(e, &Viewer{ID: 1003}) {
		t.Fatal("private version, a stranger: want false")
	}
	if !gen(e, &Viewer{ID: 1001}) || !gen(e, &Viewer{ID: 1004, IsModerator: true}) {
		t.Fatal("private version, owner or moderator: want true")
	}
	e = twoModelEnv()
	e.gates.rules = []GateRule{{AvailableTo: "moderators", Presentation: "hidden", ModelVersionIDs: []int{6001}}}
	if gen(e, &Viewer{ID: 1003}) {
		t.Fatal("hidden moderators rule, a non-moderator: want false")
	}
	if !gen(e, &Viewer{ID: 1004, IsModerator: true}) {
		t.Fatal("hidden moderators rule, a moderator: want true")
	}
	e.gates.rules = []GateRule{{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{6001}}}
	if gen(e, nil) {
		t.Fatal("hidden testers rule, signed out (no testing access): want false")
	}
	e.gates.rules = []GateRule{{AvailableTo: "nobody", Presentation: "disabled", ModelVersionIDs: []int{6001}}}
	if !gen(e, nil) {
		t.Fatal("a disabled rule keeps canGenerate: want true")
	}
	// The rules are read only when a shown card could generate.
	e = twoModelEnv()
	e.sources.page.Data[5001].Versions[0]["covered"] = false
	e.sources.page.Data[5001].Versions[0]["coveredNext"] = false
	gen(e, nil)
	if e.gates.calls != 0 {
		t.Fatalf("gate rules read %d times with no card that could generate", e.gates.calls)
	}
}

// getResourceCanGenerate's explicit coverage: a model-locked checkpoint eligible on its live column
// generates under the next column only when it is one of the two named versions.
func TestAssocExplicitCoverage(t *testing.T) {
	locked := table.ModelLocked[0]
	for _, c := range []struct {
		id   int
		want bool
	}{{6001, false}, {1088507, true}, {2152373, true}} {
		it := &feedItem{row: &modelRow{ID: 5001, UserID: 1001, Type: "Checkpoint"}, versionID: c.id,
			version: sortedRecord(map[string]any{"id": int64(c.id), "baseModel": locked, "status": "Published", "availability": "Public",
				"flags": int64(0), "covered": true, "coveredNext": false})}
		if !generationTypes[locked]["Checkpoint"] {
			t.Skipf("%s does not generate checkpoints in basemodels.json", locked)
		}
		if got := assocBaseCanGenerate(it, nil, true); got != c.want {
			t.Errorf("version %d: %v, want %v", c.id, got, c.want)
		}
	}
}

// isBaseModelGenerationDisabled is `.some` over the base model's generation overrides, while
// isGenerationEligible reads the first override only: with two overrides on one base model, the first
// enabled and a later one disabled, the base model is generation-supported (its first override) and
// still generation-disabled. The table entry is set here, independent of basemodels.json: a
// supported, covered SDXL checkpoint then does not generate.
func TestAssocGenerationDisabledOverride(t *testing.T) {
	it := &feedItem{row: &modelRow{ID: 5001, UserID: 1001, Type: "Checkpoint"}, versionID: 6001,
		version: sortedRecord(map[string]any{"id": int64(6001), "baseModel": "SDXL 1.0", "status": "Published", "availability": "Public",
			"flags": int64(0), "covered": true, "coveredNext": true})}
	if !generationTypes["SDXL 1.0"]["Checkpoint"] || generationOff["SDXL 1.0"] {
		t.Fatal("SDXL 1.0 must be a supported, not disabled, checkpoint base in basemodels.json")
	}
	if !assocBaseCanGenerate(it, nil, true) {
		t.Fatal("control: a covered SDXL checkpoint generates")
	}
	generationOff["SDXL 1.0"] = true
	defer delete(generationOff, "SDXL 1.0")
	if assocBaseCanGenerate(it, nil, true) {
		t.Fatal("a later disabled generation override: want false")
	}
	// The table is read from basemodels.json: a base model disabled there (SD 3) is listed.
	if !generationOff["SD 3"] {
		t.Fatal("basemodels.json: SD 3 is not listed as generation-disabled")
	}
}

// Errors from the stores are returned, never served around.
func TestAssocStoreErrors(t *testing.T) {
	e := twoModelEnv()
	e.prefs.err = errors.New("redis down")
	if _, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))}); err == nil || fallback.Reason(err) != "" {
		t.Fatalf("hidden prefs error: %v, want a plain error", err)
	}
	e = twoModelEnv()
	e.gates.err = fallback.New("gate-rules-unreadable")
	_, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1))})
	wantReason(t, err, "gate-rules-unreadable")
}

// The viewer class every answer reports (a fixed label set): signed out, a moderator, the source
// model's owner, any other signed-in viewer; on the empty answer too.
func TestAssocViewerClass(t *testing.T) {
	if got := ViewerClasses; len(got) != 4 || got[0] != "anon" || got[1] != "user" || got[2] != "owner" || got[3] != "moderator" {
		t.Fatalf("ViewerClasses = %v", got)
	}
	for _, c := range []struct {
		viewer  *Viewer
		targets [][]any
		want    string
	}{
		{nil, nil, "anon"},
		{nil, [][]any{{5001, nil}}, "anon"},
		{&Viewer{ID: 1003}, [][]any{{5001, nil}}, "user"},
		{&Viewer{ID: 1001}, [][]any{{5001, nil}}, "owner"},
		{&Viewer{ID: 1001}, nil, "owner"},
		{&Viewer{ID: 1001, IsModerator: true}, [][]any{{5001, nil}}, "moderator"},
	} {
		e := twoModelEnv()
		e.source = []any{false, 1001}
		e.targets = c.targets
		ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: c.viewer})
		if err != nil {
			t.Fatal(err)
		}
		if ans.ViewerClass != c.want {
			t.Errorf("viewer %+v targets %v: class %q, want %q", c.viewer, c.targets, ans.ViewerClass, c.want)
		}
	}
	// No source row: the owner class is not guessed.
	e := twoModelEnv()
	ans, err := assocServe(t, e, AssocRequest{Input: assocIn(9001, lvl(1)), Viewer: &Viewer{ID: 1001}})
	if err != nil || ans.ViewerClass != "user" {
		t.Fatalf("no source row: %v %q, want user", err, ans.ViewerClass)
	}
}
