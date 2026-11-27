package modelfeed

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// `newCreators` with its port off falls back as it always has (`input-newCreators` for any value
// isEmpty does not call empty, the string "false" included); on, it is booleanString as Node's schema
// reads it: null and the strings z.stringbool refuses are Node's 400 (input-invalid).
func TestPortNewCreators(t *testing.T) {
	for _, raw := range []string{`{"json":{"newCreators":true}}`, `{"json":{"newCreators":"true"}}`, `{"json":{"newCreators":1}}`, `{"json":{"newCreators":"false"}}`} {
		for _, p := range []Ports{{}, allPorts, {HidePaid: true, PublishedRange: true, VerifiedBot: true}} {
			if _, err := parseWith(t, raw, p); fallback.Reason(err) != "input-newCreators" {
				t.Errorf("off %+v, %s: %v (%q), want input-newCreators", p, raw, err, fallback.Reason(err))
			}
		}
	}
	for _, raw := range []string{`{"json":{"newCreators":false}}`, `{"json":{"newCreators":null}}`, `{"json":{"newCreators":0}}`, `{"json":{}}`} {
		if in, err := parseWith(t, raw, Ports{}); err != nil || in.NewCreators {
			t.Errorf("off, %s: %v (%q), want parsed without newCreators, as before", raw, err, fallback.Reason(err))
		}
	}
	for raw, want := range map[string]bool{
		`{"json":{"newCreators":true}}`:    true,
		`{"json":{"newCreators":"true"}}`:  true,
		`{"json":{"newCreators":"yes"}}`:   true,
		`{"json":{"newCreators":1}}`:       true,
		`{"json":{"newCreators":false}}`:   false,
		`{"json":{"newCreators":"false"}}`: false,
		`{"json":{"newCreators":0}}`:       false,
		`{"json":{"newCreators":2}}`:       false,
		`{"json":{}}`:                      false,
	} {
		in, err := parseWith(t, raw, Ports{NewCreators: true})
		if err != nil {
			t.Fatalf("on, %s: %v (%q)", raw, err, fallback.Reason(err))
		}
		if in.NewCreators != want {
			t.Errorf("on, %s: NewCreators %v, want %v", raw, in.NewCreators, want)
		}
	}
	for _, raw := range []string{`{"json":{"newCreators":null}}`, `{"json":{"newCreators":"maybe"}}`, `{"json":{"newCreators":""}}`, `{"json":{"newCreators":[true]}}`} {
		if _, err := parseWith(t, raw, Ports{NewCreators: true}); fallback.Reason(err) != "input-invalid" {
			t.Errorf("on, %s: %v (%q), want input-invalid", raw, err, fallback.Reason(err))
		}
	}
}

func day(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

// `publishedFrom` / `publishedTo` with the port off fall back as they always have (the first
// non-empty key in the list names the reason); on, each is publishedDateSchema (a real UTC calendar
// day, YYYY-MM-DD: anything else, null included, is Node's 400, input-invalid), then
// publishedRangeError (one end only, an end before the start, more than 31 days:
// input-published-range).
func TestPortPublishedRange(t *testing.T) {
	for raw, want := range map[string]string{
		`{"json":{"publishedFrom":"2026-06-01","publishedTo":"2026-06-02"}}`: "input-publishedFrom",
		`{"json":{"publishedFrom":"2026-06-01"}}`:                            "input-publishedFrom",
		`{"json":{"publishedTo":"2026-06-02"}}`:                              "input-publishedTo",
		`{"json":{"publishedFrom":"junk"}}`:                                  "input-publishedFrom",
	} {
		for _, p := range []Ports{{}, {NewCreators: true, VerifiedBot: true, IDs: true, Followed: true, HidePaid: true}} {
			if _, err := parseWith(t, raw, p); fallback.Reason(err) != want {
				t.Errorf("off %+v, %s: %v (%q), want %s", p, raw, err, fallback.Reason(err), want)
			}
		}
	}
	// Empty values were never a fallback (isEmpty): off, they are parsed as before.
	if in, err := parseWith(t, `{"json":{"publishedFrom":null,"publishedTo":""}}`, Ports{}); err != nil || !in.PublishedFrom.IsZero() || !in.PublishedTo.IsZero() {
		t.Fatalf("off, empty values: %v (%q), want parsed with no range", err, fallback.Reason(err))
	}

	on := Ports{PublishedRange: true}
	for _, c := range []struct {
		raw      string
		from, to time.Time
	}{
		{`{"json":{"publishedFrom":"2026-05-15","publishedTo":"2026-06-15"}}`, day(2026, 5, 15), day(2026, 6, 15)}, // 31 days: the widest
		{`{"json":{"publishedFrom":"2026-06-02","publishedTo":"2026-06-02"}}`, day(2026, 6, 2), day(2026, 6, 2)},
		{`{"json":{"publishedFrom":"2024-02-29","publishedTo":"2024-03-01"}}`, day(2024, 2, 29), day(2024, 3, 1)},
		{`{"json":{"publishedFrom":"2025-12-31","publishedTo":"2026-01-31"}}`, day(2025, 12, 31), day(2026, 1, 31)},
		{`{"json":{}}`, time.Time{}, time.Time{}},
	} {
		in, err := parseWith(t, c.raw, on)
		if err != nil {
			t.Fatalf("on, %s: %v (%q)", c.raw, err, fallback.Reason(err))
		}
		if !in.PublishedFrom.Equal(c.from) || !in.PublishedTo.Equal(c.to) {
			t.Errorf("on, %s: from %v to %v, want %v %v", c.raw, in.PublishedFrom, in.PublishedTo, c.from, c.to)
		}
	}
	for raw, want := range map[string]string{
		// publishedDateSchema: zod's 400, before getModelsRaw's range check.
		`{"json":{"publishedFrom":"2026-02-30","publishedTo":"2026-03-01"}}`:           "input-invalid",
		`{"json":{"publishedFrom":"2023-02-29","publishedTo":"2023-03-01"}}`:           "input-invalid",
		`{"json":{"publishedFrom":"2026-13-01","publishedTo":"2026-06-01"}}`:           "input-invalid",
		`{"json":{"publishedFrom":"2026-6-01","publishedTo":"2026-06-02"}}`:            "input-invalid",
		`{"json":{"publishedFrom":"2026-06-01T00:00:00Z","publishedTo":"2026-06-02"}}`: "input-invalid",
		`{"json":{"publishedFrom":" 2026-06-01","publishedTo":"2026-06-02"}}`:          "input-invalid",
		`{"json":{"publishedFrom":"2026-06-01","publishedTo":"２０２６-06-02"}}`:           "input-invalid",
		`{"json":{"publishedFrom":"","publishedTo":"2026-06-02"}}`:                     "input-invalid",
		`{"json":{"publishedFrom":null,"publishedTo":"2026-06-02"}}`:                   "input-invalid",
		`{"json":{"publishedFrom":20260601,"publishedTo":"2026-06-02"}}`:               "input-invalid",
		`{"json":{"publishedFrom":"2026-02-30"}}`:                                      "input-invalid",
		// publishedRangeError.
		`{"json":{"publishedFrom":"2026-06-01"}}`:                            "input-published-range",
		`{"json":{"publishedTo":"2026-06-01"}}`:                              "input-published-range",
		`{"json":{"publishedFrom":"2026-06-02","publishedTo":"2026-06-01"}}`: "input-published-range",
		`{"json":{"publishedFrom":"2026-05-14","publishedTo":"2026-06-15"}}`: "input-published-range",
		`{"json":{"publishedFrom":"2025-01-01","publishedTo":"2026-01-01"}}`: "input-published-range",
	} {
		if _, err := parseWith(t, raw, on); fallback.Reason(err) != want {
			t.Errorf("on, %s: %v (%q), want %s", raw, err, fallback.Reason(err), want)
		}
	}
	// A value the schema refuses elsewhere is input-invalid first, as zod answers it before getModelsRaw.
	if _, err := parseWith(t, `{"json":{"publishedFrom":"2026-06-01","limit":101}}`, on); fallback.Reason(err) != "input-invalid" {
		t.Errorf("one end and a bad limit: %v, want input-invalid", err)
	}
}

// selCols is the page query's select list for the standard path up to the cursor column, as
// TestBuildHighestRatedFirstPage pins it.
const selCols = `SELECT mm."modelId" as "id", m."name"::text as "name", m."sfwName"::text as "sfwName", m."coverImageId", m."sfwCoverImageId",
	m."type"::text as "type", mm."minor", m."sfwOnly", mm."poi", m."nsfw", mm."nsfwLevel",
	mm."status"::text as "status", m."createdAt", mm."lastVersionAt", m."publishedAt", m."locked", m."meta",
	mm."mode"::text as "mode", mm."availability"::text as "availability",
	jsonb_build_object('downloadCount', mm."downloadCount", 'thumbsUpCount', mm."thumbsUpCount",
	  'thumbsDownCount', mm."thumbsDownCount", 'commentCount', mm."commentCount",
	  'collectedCount', mm."collectedCount", 'tippedAmountCount', mm."tippedAmountCount") as "rank",
	mm."userId", `

// The whole statement with a published range, single-branch form (no cursor): getModelsRaw's
// `ranged` CTE (the Published status, both bounds) leads it, the page joins it, and the WHERE binds
// the bounds again after the period clause and before the status one.
func TestBuildPublishedRangeSingleBranch(t *testing.T) {
	gte, lt := day(2026, 5, 15), day(2026, 6, 16)
	stmt := build(t, PageQuery{Take: 2, Sort: SortNewest, BrowsingLevel: 1, PublishedGte: gte, PublishedLt: lt,
		PeriodCutoff: day(2026, 5, 1)})
	want := `WITH ranged AS MATERIALIZED (
		  SELECT "id" FROM "Model"
		  WHERE "status" = 'Published'::"ModelStatus" AND "publishedAt" >= $1 AND "publishedAt" < $2
		)
		` + selCols + `CONCAT(mm."lastVersionAt", '|', mm."modelId")::text as "cursorId"
		FROM "ModelMetric" mm JOIN "Model" m ON m."id" = mm."modelId"
		JOIN ranged ON ranged."id" = m."id"
		WHERE (mm."mode" IS NULL OR mm."mode" != 'Archived'::"ModelModifier")
		AND (mm."mode" IS DISTINCT FROM 'TakenDown'::"ModelModifier")
		AND (mm."lastVersionAt" >= $3)
		AND m."publishedAt" >= $4 AND m."publishedAt" < $5
		AND mm."status" = 'Published'::"ModelStatus"
		AND mm."availability" != 'Private'::"Availability"
		AND (mm."nsfwLevel" & $6) != 0
		ORDER BY mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC
		LIMIT $7`
	if got := norm(stmt.Text); got != norm(want) {
		t.Fatalf("SQL:\n got  %s\n want %s", got, norm(want))
	}
	wantArgs := []any{gte, lt, day(2026, 5, 1), gte, lt, 1, 3}
	if !reflect.DeepEqual(stmt.Args, wantArgs) {
		t.Fatalf("args %#v, want %#v", stmt.Args, wantArgs)
	}
}

// The whole statement with a published range, a type filter and a split keyset cursor: the CTE
// (narrowed to the types) prefixes the UNION ALL form, both branches join it, and the withheld
// viewer is still bound last.
func TestBuildPublishedRangeSplitCursor(t *testing.T) {
	gte, lt := day(2026, 6, 2), day(2026, 6, 3)
	stmt := build(t, PageQuery{Take: 1, Sort: SortHighestRated, BrowsingLevel: 31, Cursor: "70|80|5002", ViewerID: 7,
		Types: []string{"LORA"}, PublishedGte: gte, PublishedLt: lt})
	where := `(mm."mode" IS NULL OR mm."mode" != 'Archived'::"ModelModifier")
		AND (mm."mode" IS DISTINCT FROM 'TakenDown'::"ModelModifier" OR mm."userId" = $14)
		AND m.type = ANY($4::text[]::"ModelType"[])
		AND m."publishedAt" >= $5 AND m."publishedAt" < $6
		AND mm."status" = 'Published'::"ModelStatus"
		AND mm."availability" != 'Private'::"Availability"
		AND (mm."nsfwLevel" & $12) != 0`
	branch := selCols + `CONCAT(mm."thumbsUpCount", '|', mm."downloadCount", '|', mm."modelId")::text as "cursorId"
		FROM "ModelMetric" mm JOIN "Model" m ON m."id" = mm."modelId"
		JOIN ranged ON ranged."id" = m."id"
		WHERE ` + where
	order := `ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId" LIMIT $13`
	want := `WITH ranged AS MATERIALIZED (
		  SELECT "id" FROM "Model"
		  WHERE "status" = 'Published'::"ModelStatus" AND "publishedAt" >= $1 AND "publishedAt" < $2
		    AND "type" = ANY($3::text[]::"ModelType"[])
		)
		(` + branch + ` AND (mm."thumbsUpCount" = $9 AND mm."downloadCount" = $10 AND mm."modelId" >= $11) ` + order + `)
		UNION ALL
		(` + branch + ` AND ((mm."thumbsUpCount", mm."downloadCount") < ($7, $8)) ` + order + `)
		LIMIT $13`
	if got := norm(stmt.Text); got != norm(want) {
		t.Fatalf("SQL:\n got  %s\n want %s", got, norm(want))
	}
	types := []string{"LORA"}
	wantArgs := []any{gte, lt, types, types, gte, lt, int64(70), int64(80), int64(70), int64(80), int64(5002), 31, 2, 7}
	if !reflect.DeepEqual(stmt.Args, wantArgs) {
		t.Fatalf("args %#v, want %#v", stmt.Args, wantArgs)
	}
}

// No range: no CTE and no join, on any base-model path (the range's text is absent byte for byte).
func TestBuildNoPublishedRange(t *testing.T) {
	for _, q := range []PageQuery{
		{Take: 2, Sort: SortNewest, BrowsingLevel: 1},
		{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, BaseModels: []string{"A", "B"}, Cursor: "1|2|3"},
	} {
		got := build(t, q).Text
		if strings.Contains(got, "ranged") || strings.Contains(got, `"publishedAt" >=`) || strings.Contains(got, `"publishedAt" <`) {
			t.Errorf("%+v: a range clause without a range:\n%s", q, norm(got))
		}
	}
}

// The range on every base-model path joins the CTE on the model table, so each FROM keeps `m`.
func TestBuildPublishedRangeBaseModelPaths(t *testing.T) {
	gte, lt := day(2026, 6, 1), day(2026, 6, 2)
	for _, c := range []struct {
		bms  []string
		sort string
		from string
	}{
		{[]string{"A"}, SortHighestRated, `JOIN "ModelMetric" mm ON mm."modelId" = mbm."modelId" JOIN ranged ON ranged."id" = m."id" WHERE`},
		{[]string{"A", "B"}, SortNewest, `) mbm ON true JOIN ranged ON ranged."id" = m."id" WHERE`},
		{[]string{"A", "B"}, SortHighestRated, `) mbm JOIN ranged ON ranged."id" = m."id" WHERE`},
	} {
		got := norm(build(t, PageQuery{Take: 2, Sort: c.sort, BrowsingLevel: 1, BaseModels: c.bms, PublishedGte: gte, PublishedLt: lt}).Text)
		if !strings.Contains(got, c.from) || !strings.HasPrefix(got, `WITH ranged AS MATERIALIZED (SELECT "id" FROM "Model" WHERE`) {
			t.Errorf("%v %s: want %s and the CTE first in\n%s", c.bms, c.sort, c.from, got)
		}
	}
}

// `newCreators`: the board as `mm."userId" = ANY($n::integer[])` (Node's `IN (…)`; the `integer[]`
// cast keeps its text apart from `followed`'s), or `1 = 0` for an empty board, after `followed` and
// before the base-model filter, as getModelsRaw pushes them.
func TestBuildNewCreators(t *testing.T) {
	stmt := build(t, PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, ViewerID: 9, Followed: true,
		FollowedUserIDs: []int{41}, NewCreators: true, NewCreatorUserIDs: []int{1002, 1001}, BaseModels: []string{"Pony"}})
	got := norm(stmt.Text)
	frags := []string{`mm."userId" = ANY($1::int[])`, `mm."userId" = ANY($2::integer[])`, `mbm."baseModel" = $3`}
	last := -1
	for _, f := range frags {
		i := strings.Index(got, f)
		if i < 0 {
			t.Fatalf("missing %s in\n%s", f, got)
		}
		if i < last {
			t.Fatalf("%s out of getModelsRaw's order in\n%s", f, got)
		}
		last = i
	}
	if !reflect.DeepEqual(stmt.Args[:3], []any{[]int{41}, []int{1002, 1001}, "Pony"}) {
		t.Fatalf("args %#v", stmt.Args)
	}
	empty := build(t, PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, NewCreators: true})
	if n := strings.Count(empty.Text, "1 = 0"); n != 1 || strings.Contains(empty.Text, "::integer[]") {
		t.Fatalf("an empty board: `1 = 0` %d time(s), want 1 and no list in\n%s", n, norm(empty.Text))
	}
	if off := build(t, PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, NewCreatorUserIDs: []int{5}}); strings.Contains(off.Text, "::integer[]") || strings.Contains(off.Text, "1 = 0") {
		t.Fatalf("NewCreators off binds no board:\n%s", norm(off.Text))
	}
}

// fakeBoards answers the new-creators boards from a map (an absent board is a miss); asked records
// the boards read.
type fakeBoards struct {
	mu     sync.Mutex
	boards map[string][]int
	asked  []string
}

func (f *fakeBoards) UserIDs(_ context.Context, boardID string) ([]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, boardID)
	ids, ok := f.boards[boardID]
	if !ok {
		return nil, fallback.New("new-creators-miss")
	}
	return append([]int{}, ids...), nil
}

func newCreatorsEnv(pages ...[]testRow) (*env, *fakeBoards) {
	e := newEnv(pages...)
	for _, id := range []int{1, 2} {
		e.sources.page.Data[id] = hydrate.ModelData{Versions: []superjson.Object{version(10*id, "Pony", nil)}}
		e.sources.images[10*id] = []superjson.Object{image(100*id, 9, 1, nil)}
	}
	boards := &fakeBoards{boards: map[string][]int{"new_creators": {9, 12}, "new_creators-red": {12, 9, 13}}}
	e.deps.NewCreators = boards
	return e, boards
}

// serveColor serves in signed out on a host of board color color.
func serveColor(e *env, in *Input, color string) (*Answer, error) {
	return Serve(context.Background(), e.deps, Request{Input: in, BoardColor: color})
}

// `newCreators` reads the board of the request's board color (red: new_creators-red; every other
// color, or none: new_creators) and binds it in board order; an empty board is `1 = 0`.
func TestServeNewCreatorsBoard(t *testing.T) {
	for color, want := range map[string]struct {
		board string
		ids   []int
	}{
		"red":   {"new_creators-red", []int{12, 9, 13}},
		"green": {"new_creators", []int{9, 12}},
		"blue":  {"new_creators", []int{9, 12}},
		"":      {"new_creators", []int{9, 12}},
	} {
		e, boards := newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
		in := baseInput()
		in.NewCreators = true
		if _, err := serveColor(e, in, color); err != nil {
			t.Fatalf("%q: %v (%q)", color, err, fallback.Reason(err))
		}
		if !reflect.DeepEqual(boards.asked, []string{want.board}) {
			t.Errorf("%q: boards read %v, want [%s]", color, boards.asked, want.board)
		}
		if !hasArg(e.args[0], want.ids) || !strings.Contains(e.queries[0], `::integer[])`) {
			t.Errorf("%q: the board %v not bound: %v\n%s", color, want.ids, e.args[0], norm(e.queries[0]))
		}
	}
	e, boards := newCreatorsEnv([]testRow{})
	boards.boards["new_creators"] = []int{}
	in := baseInput()
	in.NewCreators = true
	ans, err := serveColor(e, in, "green")
	if err != nil {
		t.Fatal(err)
	}
	if len(e.queries) != 1 || !strings.Contains(e.queries[0], "1 = 0") || !ans.Trivial {
		t.Fatalf("an empty board: %d page queries, trivial %v; want one with `1 = 0`", len(e.queries), ans.Trivial)
	}
}

// The board is read once per request, though every page of the loop binds it; `newCreators` false
// reads none (no reader needed); a miss is the reader's fallback, before any page query; no reader
// is new-creators-unconfigured.
func TestServeNewCreatorsReads(t *testing.T) {
	// Page 1's lookahead row starts page 2; page 1's one shown row is short of the limit.
	e, boards := newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "5|5|1"}, {id: 2, owner: 9, cursor: "4|4|2"}}, []testRow{{id: 2, owner: 9, cursor: "4|4|2"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{version(10, "Pony", map[string]any{"status": "Draft"})}}
	in := baseInput()
	in.Limit, in.NewCreators = 1, true
	if _, err := serveColor(e, in, "green"); err != nil {
		t.Fatal(err)
	}
	if len(e.queries) != 2 || !reflect.DeepEqual(boards.asked, []string{"new_creators"}) {
		t.Fatalf("loop: %d pages, boards read %v; want 2 pages, one read", len(e.queries), boards.asked)
	}
	for i := range e.queries {
		if !hasArg(e.args[i], []int{9, 12}) {
			t.Errorf("page %d does not bind the board: %v", i+1, e.args[i])
		}
	}

	e, _ = newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
	e.deps.NewCreators = nil
	if _, err := serveColor(e, baseInput(), "green"); err != nil {
		t.Fatalf("newCreators false, no reader: %v", err)
	}
	if strings.Contains(e.queries[0], "::integer[]") || strings.Contains(e.queries[0], "1 = 0") {
		t.Fatalf("newCreators false: %s", norm(e.queries[0]))
	}
	in = baseInput()
	in.NewCreators = true
	if _, err := serveColor(e, in, "green"); fallback.Reason(err) != "new-creators-unconfigured" {
		t.Fatalf("no reader: %v, want new-creators-unconfigured", err)
	}

	e, boards = newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
	delete(boards.boards, "new_creators")
	if _, err := serveColor(e, in, "green"); fallback.Reason(err) != "new-creators-miss" || len(e.queries) != 0 {
		t.Fatalf("a miss: %v (%q), %d page queries; want new-creators-miss and none", err, fallback.Reason(err), len(e.queries))
	}
}

// Node reads the board after the blocked-tag check and the creator lookup and before the collection
// check (getModelsRaw's order): a blocked tag is an empty page with no board read, an unknown creator
// is its own fallback first, a board miss comes before an unreadable collection.
func TestServeNewCreatorsReadOrder(t *testing.T) {
	in := baseInput()
	in.NewCreators, in.Tag = true, "Blocked Tag"
	e, boards := newCreatorsEnv()
	delete(boards.boards, "new_creators")
	if ans, err := serveColor(e, in, "green"); err != nil || !ans.Trivial || len(boards.asked) != 0 {
		t.Fatalf("a blocked tag: %v, boards read %v; want an empty page and none", err, boards.asked)
	}
	in = baseInput()
	in.NewCreators, in.Username = true, "nobody"
	if _, err := serveColor(e, in, "green"); fallback.Reason(err) != "model-username-miss" || len(boards.asked) != 0 {
		t.Fatalf("an unknown creator: %v, boards read %v; want model-username-miss and none", err, boards.asked)
	}
	in = baseInput()
	in.NewCreators, in.CollectionID = true, 41
	if _, err := serveColor(e, in, "green"); fallback.Reason(err) != "new-creators-miss" {
		t.Fatalf("a collection after a board miss: %v (%q), want new-creators-miss", err, fallback.Reason(err))
	}
}

// The addons are resolved under the `newCreators` scope only for a `newCreators` request.
func TestServeNewCreatorsAddonScope(t *testing.T) {
	addons := []browsing.Addon{
		{Type: "some", NsfwLevels: []int{1}, ExcludedTagIDs: []int{900}},
		{Type: "some", NsfwLevels: []int{1}, Scope: "newCreators", ExcludedTagIDs: []int{901}},
	}
	for _, nc := range []bool{false, true} {
		e, _ := newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
		e.deps.Addons = func(context.Context) []browsing.Addon { return addons }
		in := baseInput()
		in.NewCreators = nc
		if _, err := serveColor(e, in, "green"); err != nil {
			t.Fatal(err)
		}
		want := []int{900}
		if nc {
			want = []int{900, 901}
		}
		if !hasArg(e.args[0], want) {
			t.Errorf("newCreators %v: excluded tags %v not bound: %v", nc, want, e.args[0])
		}
	}
}

// A published range binds getModelsRaw's bounds: the start day's midnight and the midnight after the
// end day, in the CTE and the WHERE.
func TestServePublishedRangeBounds(t *testing.T) {
	e, _ := newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
	in := baseInput()
	in.PublishedFrom, in.PublishedTo = day(2026, 5, 15), day(2026, 6, 15)
	if _, err := serve(t, e, in, nil); err != nil {
		t.Fatal(err)
	}
	var times []time.Time
	for _, a := range e.args[0] {
		if tm, ok := a.(time.Time); ok {
			times = append(times, tm)
		}
	}
	want := []time.Time{day(2026, 5, 15), day(2026, 6, 16), day(2026, 5, 15), day(2026, 6, 16)}
	if !reflect.DeepEqual(times, want) || !strings.HasPrefix(strings.TrimSpace(e.queries[0]), "WITH ranged AS MATERIALIZED") {
		t.Fatalf("bounds %v, want %v; statement %.60s", times, want, norm(e.queries[0]))
	}
	e, _ = newCreatorsEnv([]testRow{{id: 1, owner: 9, cursor: "c"}})
	if _, err := serve(t, e, baseInput(), nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(e.queries[0], "ranged") {
		t.Fatalf("no range: %s", norm(e.queries[0]))
	}
}
