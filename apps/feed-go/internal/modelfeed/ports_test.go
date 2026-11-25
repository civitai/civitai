package modelfeed

import (
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func parseWith(t *testing.T, raw string, p Ports) (*Input, error) {
	t.Helper()
	m, err := trpc.DecodeEnvelope([]byte(raw))
	if err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return ParseWith(m, p)
}

var allPorts = Ports{IDs: true, Followed: true}

// Off (the default), each port's shape falls back with the reason it always had, whatever else is on.
func TestPortsOffFallBackAsBefore(t *testing.T) {
	for raw, want := range map[string]string{
		`{"json":{"ids":[1]}}`:             "input-ids",
		`{"json":{"ids":[]}}`:              "input-ids",
		`{"json":{"ids":null}}`:            "input-ids",
		`{"json":{"ids":""}}`:              "input-ids",
		`{"json":{"followed":true}}`:       "input-followed",
		`{"json":{"followed":"true"}}`:     "input-followed",
		`{"json":{"ids":[1],"query":"x"}}`: "input-ids", // ids is checked first, as before
	} {
		for _, p := range []Ports{{}, {Followed: true}} {
			if strings.Contains(raw, "followed") && p.Followed {
				continue
			}
			_, err := parseWith(t, raw, p)
			if got := fallback.Reason(err); got != want {
				t.Errorf("%s with %+v: %q (%v), want %q", raw, p, got, err, want)
			}
		}
	}
	if _, err := parseWith(t, `{"json":{"followed":true}}`, Ports{IDs: true}); fallback.Reason(err) != "input-followed" {
		t.Errorf("followed with only the ids port: %v, want input-followed", err)
	}
	if _, err := parseWith(t, `{"json":{"ids":[1]}}`, Ports{Followed: true}); fallback.Reason(err) != "input-ids" {
		t.Errorf("ids with only the followed port: %v, want input-ids", err)
	}
}

// commaDelimitedNumberArray as model.getAll reads `ids`: every present value is a list (null and []
// included, "" is [0]), strings split on commas and trimmed, each element a JS Number that must be an
// int4 integer here.
func TestParseIDs(t *testing.T) {
	for raw, want := range map[string][]int{
		`{"json":{"ids":[5005,5001]}}`:      {5005, 5001},
		`{"json":{"ids":["5005","5001"]}}`:  {5005, 5001},
		`{"json":{"ids":"5005, 5001,7"}}`:   {5005, 5001, 7},
		`{"json":{"ids":""}}`:               {0},
		`{"json":{"ids":"5005,"}}`:          {5005, 0},
		`{"json":{"ids":[]}}`:               {},
		`{"json":{"ids":null}}`:             {},
		`{"json":{"ids":["  12 "]}}`:        {12},
		`{"json":{"ids":[-3,"+4"]}}`:        {-3, 4},
		`{"json":{"ids":[2147483647]}}`:     {2147483647},
		`{"json":{"ids":[5001],"limit":1}}`: {5001},
	} {
		in, err := parseWith(t, raw, allPorts)
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", raw, err, fallback.Reason(err))
		}
		if !in.HasIDs || !reflect.DeepEqual(in.IDs, want) {
			t.Errorf("%s: HasIDs %v IDs %v, want %v", raw, in.HasIDs, in.IDs, want)
		}
	}
	in, err := parseWith(t, `{"json":{"sort":"Newest"}}`, allPorts)
	if err != nil || in.HasIDs || in.IDs != nil {
		t.Fatalf("no ids: HasIDs %v IDs %v err %v", in.HasIDs, in.IDs, err)
	}
	for _, raw := range []string{
		`{"json":{"ids":[1.5]}}`, `{"json":{"ids":[2147483648]}}`, `{"json":{"ids":["0x10"]}}`,
		`{"json":{"ids":["1e3"]}}`, `{"json":{"ids":["abc"]}}`, `{"json":{"ids":[true]}}`,
		`{"json":{"ids":[null]}}`, `{"json":{"ids":[[1]]}}`, `{"json":{"ids":5}}`, `{"json":{"ids":{"a":1}}}`,
		`{"json":{"ids":"1;2"}}`,
	} {
		if _, err := parseWith(t, raw, allPorts); fallback.Reason(err) != "model-ids" {
			t.Errorf("%s: %v, want model-ids", raw, err)
		}
	}
}

// `followed` is a booleanString: read as one with the port on, a value the schema rejects is
// input-invalid.
func TestParseFollowed(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"json":{"followed":true}}`:    true,
		`{"json":{"followed":"yes"}}`:   true,
		`{"json":{"followed":1}}`:       true,
		`{"json":{"followed":false}}`:   false,
		`{"json":{"followed":"false"}}`: false,
		`{"json":{"followed":null}}`:    false,
		`{"json":{}}`:                   false,
	} {
		in, err := parseWith(t, raw, allPorts)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if in.Followed != want {
			t.Errorf("%s: Followed %v, want %v", raw, in.Followed, want)
		}
	}
	if _, err := parseWith(t, `{"json":{"followed":"maybe"}}`, allPorts); fallback.Reason(err) != "input-invalid" {
		t.Fatalf("followed maybe: %v, want input-invalid", err)
	}
}

// The personal Hot lead skips a truthy `followed` and a non-empty `ids` (`input.ids?.length`), not an
// empty one.
func TestPersonalHotLeadEligiblePorts(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"json":{"sort":"Hot","followed":true}}`:  false,
		`{"json":{"sort":"Hot","followed":false}}`: true,
		`{"json":{"sort":"Hot","ids":[5]}}`:        false,
		`{"json":{"sort":"Hot","ids":"5"}}`:        false,
		`{"json":{"sort":"Hot","ids":[]}}`:         true,
		`{"json":{"sort":"Hot","ids":null}}`:       true,
	} {
		in, err := parseWith(t, raw, allPorts)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if got := in.PersonalHotLeadEligible(); got != want {
			t.Errorf("%s: eligible %v, want %v", raw, got, want)
		}
	}
}

// The page query's clauses for the two ports: `ids` as its own `= ANY(…::integer[])` (never the pin's
// text), `followed` as the follow list or `1 = 0`.
func TestPageQueryPorts(t *testing.T) {
	q := PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, IDs: []int{7, 3}}
	st, err := q.Build()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st.Text, `mm."modelId" = ANY($`) || !strings.Contains(st.Text, `::integer[])`) {
		t.Fatalf("ids clause missing: %s", norm(st.Text))
	}
	if !hasArg(st.Args, []int{7, 3}) {
		t.Fatalf("ids not bound: %v", st.Args)
	}
	if strings.Contains(st.Text, `"modelId" = ANY($1::int[])`) || strings.Contains(st.Text, "1 = 0") {
		t.Fatalf("ids alone: %s", norm(st.Text))
	}
	q = PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, ViewerID: 9, Followed: true, FollowedUserIDs: []int{41, 42}}
	if st, err = q.Build(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st.Text, `mm."userId" = ANY($`) || !hasArg(st.Args, []int{41, 42}) || strings.Contains(st.Text, "1 = 0") {
		t.Fatalf("followed: %s %v", norm(st.Text), st.Args)
	}
	q.FollowedUserIDs = nil
	if st, err = q.Build(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st.Text, "1 = 0") || strings.Contains(st.Text, `mm."userId" = ANY(`) {
		t.Fatalf("followed, no follows: %s", norm(st.Text))
	}
	q = PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, IDs: []int{}}
	if st, err = q.Build(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(st.Text, "::integer[]") {
		t.Fatalf("an empty ids list filters nothing: %s", norm(st.Text))
	}
}

func hasArg(args []any, want []int) bool {
	for _, a := range args {
		if v, ok := a.([]int); ok && reflect.DeepEqual(v, want) {
			return true
		}
	}
	return false
}

// portsEnv is a one-row page whose model's first version is Private: the card shows it exactly when
// hidePrivateModels is off.
func portsEnv() *env {
	const owner = 9
	e := newEnv([]testRow{{id: 1, owner: owner, cursor: "c1"}})
	e.sources.page.Data[1] = hydrate.ModelData{Versions: []superjson.Object{
		version(10, "Pony", map[string]any{"availability": "Private"}), version(11, "Pony", nil),
	}}
	e.sources.images[10] = []superjson.Object{image(100, owner, 1, nil)}
	e.sources.images[11] = []superjson.Object{image(110, owner, 1, nil)}
	e.sources.follows = map[int][]int{3: {owner, 12}, 4: {}}
	return e
}

func portsInput(t *testing.T, extra string) *Input {
	t.Helper()
	in, err := parseWith(t, `{"json":{"sort":"Highest Rated","limit":1,"browsingLevel":1`+extra+`}}`, allPorts)
	if err != nil {
		t.Fatalf("%s: %v", extra, err)
	}
	return in
}

// `ids` (any list, empty included) and `followed` (signed out too) turn hidePrivateModels off: the
// Private version is the card's; with neither it is hidden.
func TestServePortsShowPrivateVersions(t *testing.T) {
	for _, c := range []struct {
		extra  string
		viewer *Viewer
		want   int64
	}{
		{``, nil, 11},
		{`,"ids":[1]`, nil, 10},
		{`,"ids":[]`, nil, 10},
		{`,"followed":true`, nil, 10},
		{`,"followed":true`, &Viewer{ID: 3}, 10},
		{`,"followed":false`, &Viewer{ID: 3}, 11},
	} {
		e := portsEnv()
		ans, err := serve(t, e, portsInput(t, c.extra), c.viewer)
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", c.extra, err, fallback.Reason(err))
		}
		if got := field(t, items(t, ans)[0], "version.id"); got != c.want {
			t.Errorf("%s viewer %v: version %v, want %d", c.extra, c.viewer, got, c.want)
		}
	}
}

// The page query binds what Node binds: a non-empty `ids` list; for a signed-in `followed` the
// viewer's follows read on every page (none: `1 = 0`), and nothing signed out, where no follow list
// is read.
func TestServePortsBindings(t *testing.T) {
	e := portsEnv()
	if _, err := serve(t, e, portsInput(t, `,"ids":"1, 5"`), nil); err != nil {
		t.Fatal(err)
	}
	if !hasArg(e.args[0], []int{1, 5}) || !strings.Contains(e.queries[0], "::integer[]") {
		t.Fatalf("ids: %s %v", norm(e.queries[0]), e.args[0])
	}
	e = portsEnv()
	if _, err := serve(t, e, portsInput(t, `,"followed":true`), &Viewer{ID: 3}); err != nil {
		t.Fatal(err)
	}
	if !hasArg(e.args[0], []int{9, 12}) || !reflect.DeepEqual(e.sources.followRq, []int{3}) {
		t.Fatalf("followed: args %v, asked %v", e.args[0], e.sources.followRq)
	}
	e = portsEnv()
	e.pages = [][]testRow{{}}
	ans, err := serve(t, e, portsInput(t, `,"followed":true`), &Viewer{ID: 4})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(e.queries[0], "1 = 0") || !ans.Trivial {
		t.Fatalf("followed, no follows: trivial %v, %s", ans.Trivial, norm(e.queries[0]))
	}
	e = portsEnv()
	if _, err := serve(t, e, portsInput(t, `,"followed":true`), nil); err != nil {
		t.Fatal(err)
	}
	if len(e.sources.followRq) != 0 || strings.Contains(e.queries[0], "1 = 0") || strings.Contains(e.queries[0], `mm."userId" = ANY(`) {
		t.Fatalf("followed signed out: asked %v, %s", e.sources.followRq, norm(e.queries[0]))
	}
	// Every page of the loop reads the follows again, as each getModelsRaw call does.
	e = portsEnv()
	// Page 1's one row shows no version (Draft only), so the loop asks for page 2 from the lookahead.
	e.pages = [][]testRow{{{id: 2, owner: 9, cursor: "5|5|2"}, {id: 1, owner: 9, cursor: "4|4|1"}}, {{id: 1, owner: 9, cursor: "4|4|1"}}}
	e.sources.page.Data[2] = hydrate.ModelData{Versions: []superjson.Object{version(20, "Pony", map[string]any{"status": "Draft"})}}
	in := portsInput(t, `,"followed":true`)
	if _, err := serve(t, e, in, &Viewer{ID: 3}); err != nil {
		t.Fatal(err)
	}
	if len(e.queries) != 2 || !reflect.DeepEqual(e.sources.followRq, []int{3, 3}) {
		t.Fatalf("loop: %d pages, follows asked %v; want 2 and [3 3]", len(e.queries), e.sources.followRq)
	}
}
