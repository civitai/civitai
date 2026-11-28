package sitesearch

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
)

// Every key of each generated schema is read here, and nothing else: a key the app adds to a schema
// (regenerated into schemas.json) fails this until it is read or made a fallback, and a key it drops
// fails it too.
func TestInputKeyLedger(t *testing.T) {
	for name, kinds := range map[string]map[string]int{
		inputschema.SiteSearchParams:     paramsKinds,
		inputschema.SiteMultiSearchQuery: queryKinds,
		inputschema.SiteFacetSearch:      facetKinds,
	} {
		got := slices.Sorted(maps.Keys(kinds))
		if want := inputschema.Get(name).Keys(); !slices.Equal(got, want) {
			t.Errorf("%s: read %v, schema %v", name, got, want)
		}
	}
	if want := inputschema.Get(inputschema.SiteMultiSearch).Keys(); !slices.Equal(want, []string{"queries"}) {
		t.Errorf("siteMultiSearchSchema keys %v, want [queries]", want)
	}
}

func TestParsePath(t *testing.T) {
	for _, c := range []struct {
		rest  string
		route Route
		index string
	}{
		{"multi-search", RouteMulti, ""},
		{"indexes/models_v9/search", RouteSearch, "models_v9"},
		{"indexes/tools_v2/facet-search", RouteFacet, "tools_v2"},
	} {
		route, index, err := ParsePath(c.rest)
		if err != nil || route != c.route || index != c.index {
			t.Errorf("%q: %v %q %v", c.rest, route, index, err)
		}
	}
	for _, rest := range []string{"", "token", "multi-search/", "indexes/models_v9", "indexes/models_v9/search/x", "indexes/models_v9/documents", "keys"} {
		if _, _, err := ParsePath(rest); fallback.Reason(err) != "search-path" {
			t.Errorf("%q: %v, want search-path", rest, err)
		}
	}
}

// What zod refuses (Node's 400) falls back as search-input-invalid; an unknown key it would strip
// falls back as input-unknown-key, after the refusals; a body that is not JSON, or JSON.parse would
// read differently (a duplicate key), falls back too.
func TestParseBodyRefusals(t *testing.T) {
	long := `"` + strings.Repeat("a", 101) + `"`
	for _, c := range []struct {
		route Route
		body  string
		want  string
	}{
		{RouteSearch, `{"limit":-1}`, "search-input-invalid"},
		{RouteSearch, `{"limit":1.5}`, "search-input-invalid"},
		{RouteSearch, `{"limit":"10"}`, "search-input-invalid"},
		{RouteSearch, `{"limit":1e300}`, "search-input-invalid"},
		{RouteSearch, `{"hitsPerPage":101}`, "search-input-invalid"},
		{RouteSearch, `{"cropLength":1001}`, "search-input-invalid"},
		{RouteSearch, `{"q":3}`, "search-input-invalid"},
		{RouteSearch, `{"q":"` + strings.Repeat("a", 1001) + `"}`, "search-input-invalid"},
		{RouteSearch, `{"filter":3}`, "search-input-invalid"},
		{RouteSearch, `{"filter":[["a",1]]}`, "search-input-invalid"},
		{RouteSearch, `{"filter":[[["a"]]]}`, "search-input-invalid"},
		{RouteSearch, `{"sort":null}`, "search-input-invalid"},
		{RouteSearch, `{"sort":[` + long + `]}`, "search-input-invalid"},
		{RouteSearch, `{"highlightPreTag":` + long + `}`, "search-input-invalid"},
		{RouteSearch, `{"matchingStrategy":"any"}`, "search-input-invalid"},
		{RouteSearch, `[]`, "search-input-invalid"},
		{RouteSearch, `null`, "search-input-invalid"},
		{RouteSearch, `{"vector":[1],"limit":-1}`, "search-input-invalid"},
		{RouteSearch, `{"vector":[1]}`, "input-unknown-key"},
		{RouteSearch, `{"showRankingScoreDetails":true}`, "input-unknown-key"},
		{RouteSearch, `{"indexUid":"models_v9"}`, "input-unknown-key"},
		{RouteSearch, `{"q":"a","q":"b"}`, "search-input-duplicate"},
		{RouteSearch, ``, "search-input"},
		{RouteSearch, `{"q":`, "search-input"},
		{RouteSearch, "{\"q\":\"\xff\"}", "search-input"},
		{RouteMulti, `{}`, "search-input-invalid"},
		{RouteMulti, `{"queries":[]}`, "search-input-invalid"},
		{RouteMulti, `{"queries":[` + strings.Repeat(`{"indexUid":"tools_v2"},`, 20) + `{"indexUid":"tools_v2"}]}`, "search-input-invalid"},
		{RouteMulti, `{"queries":[{"q":"a"}]}`, "search-input-invalid"},
		{RouteMulti, `{"queries":[{"indexUid":"tools_v2"}],"federation":{}}`, "input-unknown-key"},
		{RouteMulti, `{"queries":[{"indexUid":"tools_v2","federationOptions":{}}]}`, "input-unknown-key"},
		{RouteFacet, `{"facetQuery":"a"}`, "search-input-invalid"},
		{RouteFacet, `{"facetName":"type","limit":3,"vector":[1]}`, "input-unknown-key"},
		{RouteFacet, `{"facetName":"type","indexUid":"tools_v2"}`, "input-unknown-key"},
		{RouteFacet, `{"facetQuery":"a","attributesToHighlight":["*"]}`, "search-input-invalid"},
		{RouteFacet, `{"facetName":3,"limit":3}`, "search-input-invalid"},
	} {
		if _, err := ParseBody(c.route, "tools_v2", []byte(c.body)); fallback.Reason(err) != c.want {
			t.Errorf("%d %s: %v, want %s", c.route, c.body, err, c.want)
		}
	}
}

// facetStrippedKeys is a reviewed parity decision, pinned as literals: every key is a
// siteSearchParamsSchema key that siteFacetSearchSchema lacks, so zod strips it on the facet route, and
// together they are all such keys. It fails on the web PR that adds one of them to the facet schema,
// or a key to the search schema (each regenerates schemas.json).
func TestFacetStrippedKeysAreStrippedByZod(t *testing.T) {
	want := []string{"attributesToCrop", "attributesToHighlight", "attributesToRetrieve", "cropLength", "cropMarker", "facets",
		"highlightPostTag", "highlightPreTag", "hitsPerPage", "limit", "offset", "page", "sort"}
	if got := slices.Sorted(maps.Keys(facetStrippedKeys)); !slices.Equal(got, want) {
		t.Errorf("facetStrippedKeys = %v, want %v (a change here is a reviewed parity decision)", got, want)
	}
	params, facet := inputschema.Get(inputschema.SiteSearchParams), inputschema.Get(inputschema.SiteFacetSearch)
	var lacking []string
	for _, k := range params.Keys() {
		if !facet.Has(k) {
			lacking = append(lacking, k)
		}
	}
	if !slices.Equal(lacking, want) {
		t.Errorf("siteSearchParamsSchema keys siteFacetSearchSchema lacks: %v, want %v", lacking, want)
	}
	for _, k := range want {
		if facet.Has(k) {
			t.Errorf("%s is a siteFacetSearchSchema key: zod no longer strips it", k)
		}
	}
}

// The facet route drops the keys zod strips as Node does: unread (a value zod would refuse on the
// search route included), never forwarded, and the rest of the call is unchanged. On the search
// route they are the schema's own keys, read and refused as zod refuses them.
func TestFacetDropsStrippedKeys(t *testing.T) {
	body := `{"q":"","facetName":"type","facetQuery":"lo","filter":"a = 1","attributesToHighlight":["*"],"attributesToCrop":[],` +
		`"attributesToRetrieve":["id"],"cropLength":5000,"cropMarker":"...","facets":["type"],"highlightPreTag":"<b>",` +
		`"highlightPostTag":"</b>","hitsPerPage":-1,"limit":"20","offset":3,"page":1,"sort":null}`
	req, err := ParseBody(RouteFacet, ToolsIndex, []byte(body))
	if err != nil {
		t.Fatalf("facet search with the stripped keys: %v, want accepted", err)
	}
	call := req.Call(ViewerOf(Session{}))
	if want := `{"q":"","facetName":"type","facetQuery":"lo","filter":"a = 1"}`; string(call.Body) != want {
		t.Errorf("call body\n got %s\nwant %s", call.Body, want)
	}
	// On the search route the same values are zod's to refuse.
	if _, err := ParseBody(RouteSearch, ToolsIndex, []byte(`{"hitsPerPage":-1}`)); fallback.Reason(err) != "search-input-invalid" {
		t.Errorf("search route, hitsPerPage -1: %v, want search-input-invalid", err)
	}
}

// The bodies zod accepts: nullish q and facetQuery, the windows clamped to 1000, exactly 20 queries.
func TestParseBodyAccepts(t *testing.T) {
	for _, c := range []struct {
		route Route
		body  string
	}{
		{RouteSearch, `{}`},
		{RouteSearch, `{"q":null,"limit":0,"offset":1000,"page":5000,"hitsPerPage":100,"cropLength":0}`},
		{RouteSearch, `{"filter":"","sort":[],"facets":["type"],"matchingStrategy":"frequency"}`},
		{RouteSearch, `{"filter":["a",["b","c"],""]}`},
		{RouteMulti, `{"queries":[` + strings.Repeat(`{"indexUid":"tools_v2"},`, 19) + `{"indexUid":"tools_v2"}]}`},
		{RouteFacet, `{"facetName":"type","facetQuery":null,"q":"x","filter":"a = 1","matchingStrategy":"last"}`},
	} {
		if _, err := ParseBody(c.route, "tools_v2", []byte(c.body)); err != nil {
			t.Errorf("%s: %v", c.body, err)
		}
	}
}

func decodeJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return v
}

// The search call is withViewer's: the viewer's clauses ANDed on as list elements after the client's
// parts (an empty string part dropped, an OR group kept), `sfwName` added to a models query's
// attributes, the windows clamped and numbers as JSON.stringify writes them. Expectations are the JSON
// Node's postToSearch sends for the same body and viewer.
func TestCall(t *testing.T) {
	signedOut := ViewerOf(Session{})
	for _, c := range []struct {
		name  string
		route Route
		index string
		body  string
		v     Viewer
		path  string
		want  string
	}{
		{
			name: "models, signed out", route: RouteSearch, index: ModelsIndex, v: signedOut,
			body: `{"q":"cat","filter":"type = LORA","attributesToRetrieve":["id","name"],"limit":5000,"offset":1e2}`,
			path: "/indexes/models_v9/search",
			want: `{"q":"cat","filter":["type = LORA","poi != true","availability != Private","nsfwLevel=1"],"attributesToRetrieve":["id","name","sfwName"],"limit":1000,"offset":100}`,
		},
		{
			name: "models, a list filter with an empty part and an OR group", route: RouteSearch, index: ModelsIndex,
			v:    Viewer{UserID: 5},
			body: `{"filter":["",["a = 1","b = 2"],"c = 3"],"attributesToRetrieve":["*"]}`,
			path: "/indexes/models_v9/search",
			want: `{"filter":[["a = 1","b = 2"],"c = 3","poi != true OR user.id = 5","availability != Private OR user.id = 5"],"attributesToRetrieve":["*"]}`,
		},
		{
			name: "tools, no clause: the filter as sent, an absent one absent", route: RouteSearch, index: ToolsIndex, v: signedOut,
			body: `{"q":"x","filter":""}`,
			path: "/indexes/tools_v2/search",
			want: `{"q":"x","filter":""}`,
		},
		{
			name: "articles, the clause appended when the client sent no filter", route: RouteSearch, index: ArticlesIndex,
			v: Viewer{Cap: 3}, body: `{"q":"x"}`, path: "/indexes/articles_v5/search",
			want: `{"q":"x","filter":["nsfwLevel=1 OR nsfwLevel=2"]}`,
		},
		{
			name: "facet search, comics", route: RouteFacet, index: ComicsIndex, v: signedOut,
			body: `{"facetName":"genre","facetQuery":null}`,
			path: "/indexes/comics_v1/facet-search",
			want: `{"facetName":"genre","facetQuery":null,"filter":["nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [2, 4, 8, 16, 32]"]}`,
		},
		{
			name: "multi-search, each query held to its own index's clauses", route: RouteMulti, v: signedOut,
			body: `{"queries":[{"indexUid":"users_v3","q":"a","attributesToRetrieve":["id"]},{"indexUid":"models_v9","q":"a"}]}`,
			path: "/multi-search",
			want: `{"queries":[{"indexUid":"users_v3","q":"a","attributesToRetrieve":["id"]},{"indexUid":"models_v9","q":"a","filter":["poi != true","availability != Private","nsfwLevel=1"]}]}`,
		},
	} {
		req, err := ParseBody(c.route, c.index, []byte(c.body))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		call := req.Call(c.v)
		if call.Path != c.path {
			t.Errorf("%s: path %q, want %q", c.name, call.Path, c.path)
		}
		if got, want := decodeJSON(t, call.Body), decodeJSON(t, []byte(c.want)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %s\nwant %s", c.name, call.Body, c.want)
		}
	}
}

// A client string cannot close the clauses' parenthesis: whatever it holds, it is one list element
// and every clause is its own element after it.
func TestCallKeepsClauseElementsApart(t *testing.T) {
	req, err := ParseBody(RouteSearch, ModelsIndex, []byte(`{"filter":"id = 1) OR (poi = true"}`))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Filter []string `json:"filter"`
	}
	if err := json.Unmarshal(req.Call(Viewer{Cap: 1}).Body, &body); err != nil {
		t.Fatal(err)
	}
	want := []string{"id = 1) OR (poi = true", "poi != true", "availability != Private", "nsfwLevel=1"}
	if !slices.Equal(body.Filter, want) {
		t.Fatalf("filter %q, want %q", body.Filter, want)
	}
}

func TestQueryTexts(t *testing.T) {
	req, err := ParseBody(RouteMulti, "", []byte(`{"queries":[{"indexUid":"tools_v2","q":"a"},{"indexUid":"tools_v2","q":null},{"indexUid":"tools_v2"},{"indexUid":"tools_v2","q":""}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := req.QueryTexts(); !slices.Equal(got, []string{"a", ""}) {
		t.Errorf("multi: %q", got)
	}
	req, _ = ParseBody(RouteFacet, "tools_v2", []byte(`{"facetName":"x","q":"b"}`))
	if got := req.QueryTexts(); !slices.Equal(got, []string{"b"}) {
		t.Errorf("facet: %q", got)
	}
}
