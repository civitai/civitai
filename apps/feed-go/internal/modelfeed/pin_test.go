package modelfeed

import (
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// pinEnv is newEnv with getOfficialModelIds answering checkpoints 3, 1 and 99 and a LORA 2, and every
// model of the pages below shown (a Pony version with one PG image).
func pinEnv(pages ...[]testRow) *env {
	e := newEnv(pages...)
	e.sources.official = []hydrate.OfficialModel{{ID: 3, Type: "Checkpoint"}, {ID: 2, Type: "LORA"}, {ID: 1, Type: "Checkpoint"},
		{ID: 99, Type: "Checkpoint"}}
	for _, id := range []int{1, 3, 10, 11, 12, 13} {
		e.sources.page.Data[id] = hydrate.ModelData{Versions: []superjson.Object{version(id*10, "Pony", nil)}}
		e.sources.images[id*10] = []superjson.Object{image(id*100, 9, 1, nil)}
	}
	return e
}

func hotInput(limit int) *Input {
	in := baseInput()
	in.Sort, in.BaseModels, in.Limit = SortHot, []string{"Pony"}, limit
	return in
}

func itemIDs(t *testing.T, a *Answer) []int64 {
	t.Helper()
	list := items(t, a)
	out := make([]int64, 0, len(list))
	for _, it := range list {
		out = append(out, field(t, it, "id").(int64))
	}
	return out
}

// idArg is the []int bound to the page query's `mm."modelId" <op>($n::int[])` clause, nil when the
// query has none.
func idArg(t *testing.T, sql string, args []any, op string) []int {
	t.Helper()
	marker := `mm."modelId" ` + op + `($`
	i := strings.Index(sql, marker)
	if i < 0 {
		return nil
	}
	rest := sql[i+len(marker):]
	n := 0
	for _, c := range rest {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	ids, ok := args[n-1].([]int)
	if !ok {
		t.Fatalf("$%d = %#v, not an id list", n, args[n-1])
	}
	return ids
}

// The first Hot page with a base-model filter: the official checkpoints (3, 1, 99 in
// getOfficialModelIds' order; the LORA 2 is not pinned) are one page of the same query restricted to
// them, take 3 (LIMIT 4), and lead the answer; the main page drops them, takes `limit` (LIMIT 3) and
// its lookahead is the answer's cursor.
func TestServeOfficialPinFirstPage(t *testing.T) {
	e := pinEnv(
		[]testRow{{id: 1, owner: 9, cursor: "9|1"}, {id: 3, owner: 9, cursor: "8|3"}},
		[]testRow{{id: 10, owner: 9, cursor: "7|10"}, {id: 11, owner: 9, cursor: "6|11"}, {id: 12, owner: 9, cursor: "5|12"}},
	)
	ans, err := serve(t, e, hotInput(2), nil)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if got := itemIDs(t, ans); !reflect.DeepEqual(got, []int64{1, 3, 10, 11}) {
		t.Fatalf("items %v, want the pinned 1, 3 then 10, 11", got)
	}
	if v, _ := ans.Value.Get("nextCursor"); v != "5|12" {
		t.Fatalf("nextCursor %v, want the main page's lookahead", v)
	}
	if len(e.queries) != 2 {
		t.Fatalf("%d page queries, want 2", len(e.queries))
	}
	pinned := []int{3, 1, 99}
	if got := idArg(t, e.queries[0], e.args[0], "= ANY"); !reflect.DeepEqual(got, pinned) {
		t.Fatalf("pinned page binds %v, want %v", got, pinned)
	}
	if got := idArg(t, e.queries[0], e.args[0], "!= ALL"); got != nil {
		t.Fatalf("the pinned page excludes %v", got)
	}
	if got := e.args[0][len(e.args[0])-1]; got != 4 {
		t.Fatalf("pinned page LIMIT %v, want 4 (take = the pinned ids' count, plus the lookahead)", got)
	}
	if got := idArg(t, e.queries[1], e.args[1], "!= ALL"); !reflect.DeepEqual(got, pinned) {
		t.Fatalf("main page excludes %v, want %v", got, pinned)
	}
	if got := idArg(t, e.queries[1], e.args[1], "= ANY"); got != nil {
		t.Fatalf("the main page is restricted to %v", got)
	}
	if got := e.args[1][len(e.args[1])-1]; got != 3 {
		t.Fatalf("main page LIMIT %v, want 3", got)
	}
	if e.sources.officialCalls != 1 {
		t.Fatalf("%d official reads, want 1", e.sources.officialCalls)
	}
}

// The pinned items do not count towards `limit`: with limit 1 and two pinned items the loop still
// fetches a main page.
func TestServeOfficialPinDoesNotFillTheLimit(t *testing.T) {
	e := pinEnv(
		[]testRow{{id: 1, owner: 9, cursor: "9|1"}, {id: 3, owner: 9, cursor: "8|3"}},
		[]testRow{{id: 10, owner: 9, cursor: "7|10"}, {id: 11, owner: 9, cursor: "6|11"}},
	)
	ans, err := serve(t, e, hotInput(1), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := itemIDs(t, ans); !reflect.DeepEqual(got, []int64{1, 3, 10}) || len(e.queries) != 2 {
		t.Fatalf("items %v after %d queries, want [1 3 10] after 2", got, len(e.queries))
	}
}

// A later page (a cursor): no pinned page, the main page still drops the pinned ids.
func TestServeOfficialPinLaterPage(t *testing.T) {
	e := pinEnv([]testRow{{id: 12, owner: 9, cursor: "5|12"}, {id: 13, owner: 9, cursor: "4|13"}})
	in := hotInput(2)
	in.Cursor = "6|11"
	ans, err := serve(t, e, in, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := itemIDs(t, ans); !reflect.DeepEqual(got, []int64{12, 13}) || len(e.queries) != 1 {
		t.Fatalf("items %v after %d queries, want [12 13] after 1", got, len(e.queries))
	}
	if got := idArg(t, e.queries[0], e.args[0], "!= ALL"); !reflect.DeepEqual(got, []int{3, 1, 99}) {
		t.Fatalf("excludes %v", got)
	}
	if v, _ := ans.Value.Get("nextCursor"); v != (superjson.Undefined{}) {
		t.Fatalf("nextCursor %#v, want undefined", v)
	}
}

// No pin outside Hot with a base-model filter (getOfficialModelIds is not read), and none when the
// official list holds no checkpoint (no pinned page, no exclusion).
func TestServeOfficialPinScope(t *testing.T) {
	notHot := baseInput()
	notHot.BaseModels = []string{"Pony"}
	noBase := baseInput()
	noBase.Sort = SortHot
	for _, c := range []struct {
		name  string
		in    *Input
		reads int
		lora  bool
	}{
		{"Highest Rated with base models", notHot, 0, false},
		{"Hot without base models", noBase, 0, false},
		{"Hot with base models, no official checkpoint", hotInput(2), 1, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := pinEnv([]testRow{{id: 10, owner: 9, cursor: "7|10"}})
			if c.lora {
				e.sources.official = []hydrate.OfficialModel{{ID: 2, Type: "LORA"}}
			}
			if _, err := serve(t, e, c.in, nil); err != nil {
				t.Fatal(err)
			}
			if e.sources.officialCalls != c.reads || len(e.queries) != 1 {
				t.Fatalf("%d official reads, %d queries; want %d and 1", e.sources.officialCalls, len(e.queries), c.reads)
			}
			if strings.Contains(e.queries[0], `mm."modelId" = ANY(`) || strings.Contains(e.queries[0], `mm."modelId" != ALL(`) {
				t.Fatalf("an id filter without a pin:\n%s", e.queries[0])
			}
		})
	}
}

// A pinned page that finds no row (no pinned model passes the filters) adds nothing; the answer is
// trivial only when the main page loaded nothing either.
func TestServeOfficialPinEmptyPinnedPage(t *testing.T) {
	e := pinEnv([]testRow{}, []testRow{{id: 10, owner: 9, cursor: "7|10"}})
	ans, err := serve(t, e, hotInput(2), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := itemIDs(t, ans); !reflect.DeepEqual(got, []int64{10}) || ans.Trivial {
		t.Fatalf("items %v trivial %v", got, ans.Trivial)
	}
	e = pinEnv([]testRow{}, []testRow{})
	if ans, err = serve(t, e, hotInput(2), nil); err != nil || !ans.Trivial {
		t.Fatalf("both empty: %v trivial %v", err, ans != nil && ans.Trivial)
	}
	// Positive control: a loaded pinned page alone is not trivial.
	e = pinEnv([]testRow{{id: 1, owner: 9, cursor: "9|1"}}, []testRow{})
	if ans, err = serve(t, e, hotInput(2), nil); err != nil || ans.Trivial {
		t.Fatalf("pinned rows only: %v trivial %v", err, ans != nil && ans.Trivial)
	}
}

// The official read's fallback (a miss without the computation, a failed read) is the request's; a
// flag mirror off falls back before the read.
func TestServeOfficialPinFallbacks(t *testing.T) {
	e := pinEnv()
	e.sources.officialErr = fallback.New("official-models-miss")
	if _, err := serve(t, e, hotInput(2), nil); fallback.Reason(err) != "official-models-miss" {
		t.Fatalf("%v, want official-models-miss", err)
	}
	e = pinEnv()
	e.deps.Config.ImagesSlim = false
	if _, err := serve(t, e, hotInput(2), nil); fallback.Reason(err) != "flag-off-state" || e.sources.officialCalls != 0 {
		t.Fatalf("%v after %d official reads, want flag-off-state and none", err, e.sources.officialCalls)
	}
}
