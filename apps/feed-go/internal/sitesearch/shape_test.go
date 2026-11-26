package sitesearch

import (
	"context"
	"errors"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// shapeOne runs ShapeHits over one hit and returns the shaped hit's bytes.
func shapeOne(t *testing.T, uid, hit string, v Viewer) string {
	t.Helper()
	out, present, err := ShapeHits(uid, []byte("["+hit+"]"), true, v)
	if err != nil {
		t.Fatalf("%s: %v", uid, err)
	}
	if !present {
		t.Fatalf("%s: hits dropped", uid)
	}
	s := string(out)
	return s[1 : len(s)-1]
}

// Each expectation below is the JSON.stringify of what site-search.service.ts's shape functions
// return for the hit (object spreads keep a key's place, a new key goes last), read off the Node code.
func TestShapeHits(t *testing.T) {
	for _, c := range []struct {
		name, uid, hit, want string
		v                    Viewer
	}{
		{
			name: "model, civitai.com face under PG: sfwName gone, images and copies capped, avatar kept",
			uid:  ModelsIndex, v: Viewer{Cap: 1, ShowSfwFace: true},
			hit:  `{"id":1,"name":"Red title","sfwName":"Safe title","images":[{"id":10,"nsfwLevel":1},{"id":11,"nsfwLevel":4},{"id":12}],"user":{"id":5,"username":"u","image":"x.png","profilePicture":{"id":7,"nsfwLevel":1}},"_formatted":{"name":"<em>Red</em>","sfwName":"<em>Safe</em>","images":[{"id":"10"},{"id":"11"}],"user":{"id":"5","image":"x.png","profilePicture":{"id":"7","nsfwLevel":"1"}}}}`,
			want: `{"id":1,"name":"Safe title","images":[{"id":10,"nsfwLevel":1}],"user":{"id":5,"username":"u","image":null,"profilePicture":{"id":7,"nsfwLevel":1}},"_formatted":{"name":"<em>Safe</em>","images":[{"id":"10"}],"user":{"id":"5","image":null,"profilePicture":{"id":"7","nsfwLevel":"1"}}}}`,
		},
		{
			name: "model, mature viewer, no cap: only sfwName removed",
			uid:  ModelsIndex, v: Viewer{UserID: 3},
			hit:  `{"id":2,"name":"N","sfwName":"S","images":[{"id":1,"nsfwLevel":16}],"_formatted":{"name":"N","sfwName":"S"}}`,
			want: `{"id":2,"name":"N","images":[{"id":1,"nsfwLevel":16}],"_formatted":{"name":"N"}}`,
		},
		{
			name: "model, face but no name asked for", uid: ModelsIndex, v: Viewer{ShowSfwFace: true},
			hit: `{"id":3,"sfwName":"S"}`, want: `{"id":3}`,
		},
		{
			name: "model, empty face keeps the name", uid: ModelsIndex, v: Viewer{ShowSfwFace: true},
			hit: `{"id":4,"name":"N","sfwName":""}`, want: `{"id":4,"name":"N"}`,
		},
		{
			name: "model, a null copy face takes the hit's", uid: ModelsIndex, v: Viewer{ShowSfwFace: true},
			hit:  `{"name":"N","sfwName":"S","_formatted":{"name":"<N>","sfwName":null}}`,
			want: `{"name":"S","_formatted":{"name":"S"}}`,
		},
		{
			name: "model, under a cap a copy without a kept list keeps nothing", uid: ModelsIndex, v: Viewer{Cap: 3},
			hit:  `{"id":5,"_formatted":{"images":[{"id":"1"}]}}`,
			want: `{"id":5,"_formatted":{"images":[]}}`,
		},
		{
			name: "model, under a cap images that are not a list become []", uid: ModelsIndex, v: Viewer{Cap: 3},
			hit: `{"id":6,"images":null}`, want: `{"id":6,"images":[]}`,
		},
		{
			name: "comic inside the cap keeps its cover", uid: ComicsIndex, v: Viewer{Cap: 1},
			hit:  `{"id":1,"coverImageNsfwLevel":1,"coverImageUrl":"a","_formatted":{"coverImageUrl":"a"}}`,
			want: `{"id":1,"coverImageNsfwLevel":1,"coverImageUrl":"a","_formatted":{"coverImageUrl":"a"}}`,
		},
		{
			name: "comic reaching past the cap loses its cover", uid: ComicsIndex, v: Viewer{Cap: 1},
			hit:  `{"id":2,"coverImageNsfwLevel":3,"coverImageUrl":"b","_formatted":{"coverImageUrl":"b","title":"t"}}`,
			want: `{"id":2,"coverImageNsfwLevel":3,"_formatted":{"title":"t"}}`,
		},
		{
			name: "unrated comic loses its cover", uid: ComicsIndex, v: Viewer{Cap: 3},
			hit: `{"id":3,"coverImageUrl":"c"}`, want: `{"id":3}`,
		},
		{
			name: "collection under PG: srcs dropped, items and cover capped, avatar without a rated picture",
			uid:  CollectionsIndex, v: Viewer{Cap: 1},
			hit:  `{"id":1,"srcs":["s"],"images":[{"id":1,"nsfwLevel":1},{"id":2,"nsfwLevel":2}],"image":{"id":9,"nsfwLevel":2},"user":{"id":3,"image":"i","profilePicture":null},"_formatted":{"srcs":["s"],"images":[{"id":"1"},{"id":"2"}],"image":{"id":"9"}}}`,
			want: `{"id":1,"images":[{"id":1,"nsfwLevel":1}],"image":null,"user":{"id":3,"image":null,"profilePicture":null},"_formatted":{"images":[{"id":"1"}],"image":null}}`,
		},
		{
			name: "collection at the viewer's SFW level: srcs kept, moved to the end",
			uid:  CollectionsIndex, v: Viewer{CollectionImageLevel: 3},
			hit:  `{"srcs":["s"],"id":1,"images":[{"id":1,"nsfwLevel":4}],"_formatted":{"srcs":["f"],"id":"1"}}`,
			want: `{"id":1,"images":[],"_formatted":{"id":"1","srcs":["f"]},"srcs":["s"]}`,
		},
		{
			name: "collection at a level short of SFW: srcs dropped",
			uid:  CollectionsIndex, v: Viewer{CollectionImageLevel: 1},
			hit:  `{"srcs":["s"],"id":1,"image":{"nsfwLevel":1}}`,
			want: `{"id":1,"image":{"nsfwLevel":1}}`,
		},
		{
			name: "users hit outside the cap: the user's own picture and image go",
			uid:  UsersIndex, v: Viewer{Cap: 1},
			hit:  `{"id":5,"username":"u","image":"i","profilePicture":{"id":1,"nsfwLevel":4},"_formatted":{"username":"<u>","profilePicture":{"id":"1"}}}`,
			want: `{"id":5,"username":"u","image":null,"profilePicture":null,"_formatted":{"username":"<u>","profilePicture":null,"image":null}}`,
		},
		{
			name: "bounty under SFW: images and copies capped",
			uid:  BountiesIndex, v: Viewer{Cap: 3},
			hit:  `{"id":1,"images":[{"id":1,"nsfwLevel":2},{"id":2,"nsfwLevel":8}],"_formatted":{"images":[{"id":"1"},{"id":"2"}]}}`,
			want: `{"id":1,"images":[{"id":1,"nsfwLevel":2}],"_formatted":{"images":[{"id":"1"}]}}`,
		},
		{
			name: "article under PG: a rated picture inside is kept, image appended as null",
			uid:  ArticlesIndex, v: Viewer{Cap: 1},
			hit:  `{"id":1,"user":{"id":2,"profilePicture":{"nsfwLevel":1}}}`,
			want: `{"id":1,"user":{"id":2,"profilePicture":{"nsfwLevel":1},"image":null}}`,
		},
		{
			name: "article under PG: an unrated picture is outside",
			uid:  ArticlesIndex, v: Viewer{Cap: 1},
			hit:  `{"id":1,"user":{"id":2,"profilePicture":{"id":3}}}`,
			want: `{"id":1,"user":{"id":2,"profilePicture":null,"image":null}}`,
		},
	} {
		if got := shapeOne(t, c.uid, c.hit, c.v); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// Hits that need no shaping are the backend's bytes, unparsed.
func TestShapeHitsLeavesOtherIndexesAlone(t *testing.T) {
	raw := `[{"id":1, "name" : "x"},1,null]`
	for _, c := range []struct {
		uid string
		v   Viewer
	}{{ToolsIndex, Viewer{Cap: 1}}, {ArticlesIndex, Viewer{}}, {CollectionsIndex, Viewer{UserID: 2}}} {
		out, present, err := ShapeHits(c.uid, []byte(raw), true, c.v)
		if err != nil || !present || string(out) != raw {
			t.Errorf("%s %+v: %s %v %v, want the bytes unchanged", c.uid, c.v, out, present, err)
		}
	}
}

// shapeHits on a result without a list: absent stays absent, a capped one becomes [].
func TestShapeHitsAbsentList(t *testing.T) {
	if out, present, err := ShapeHits(ModelsIndex, nil, false, Viewer{}); err != nil || present {
		t.Errorf("models uncapped, absent: %s %v %v, want still absent", out, present, err)
	}
	if out, present, err := ShapeHits(ArticlesIndex, nil, false, Viewer{Cap: 1}); err != nil || !present || string(out) != "[]" {
		t.Errorf("articles capped, absent: %s %v %v, want []", out, present, err)
	}
	if out, present, err := ShapeHits(CollectionsIndex, []byte(`{}`), true, Viewer{CollectionImageLevel: 7}); err != nil || !present || string(out) != "[]" {
		t.Errorf("collections at a level, not a list: %s %v %v, want []", out, present, err)
	}
	if out, present, err := ShapeHits(ModelsIndex, []byte(`null`), true, Viewer{}); err != nil || !present || string(out) != "null" {
		t.Errorf("models uncapped, null: %s %v %v, want null kept", out, present, err)
	}
}

// What Node reads in a way this port does not reproduce is a shape error (the request falls back):
// a hit that is not an object, a duplicate key, a rating that is not a number.
func TestShapeHitsRefusesUnreadShapes(t *testing.T) {
	for _, c := range []struct {
		name, uid, hits string
		v               Viewer
	}{
		{"a null model hit", ModelsIndex, `[null]`, Viewer{}},
		{"a primitive bounty hit", BountiesIndex, `[1]`, Viewer{Cap: 1}},
		{"a duplicate key", ModelsIndex, `[{"id":1,"id":2}]`, Viewer{}},
		{"a string rating", ModelsIndex, `[{"images":[{"id":1,"nsfwLevel":"1"}]}]`, Viewer{Cap: 1}},
		{"a fractional rating", ArticlesIndex, `[{"user":{"profilePicture":{"nsfwLevel":1.5}}}]`, Viewer{Cap: 1}},
		{"a fractional cover level", ComicsIndex, `[{"coverImageNsfwLevel":0.5}]`, Viewer{Cap: 1}},
		{"a primitive highlight copy", BountiesIndex, `[{"_formatted":"x"}]`, Viewer{Cap: 1}},
		{"an object image id", ModelsIndex, `[{"images":[{"id":{},"nsfwLevel":1}],"_formatted":{"images":[]}}]`, Viewer{Cap: 1}},
	} {
		if _, _, err := ShapeHits(c.uid, []byte(c.hits), true, c.v); !errors.Is(err, errShape) {
			t.Errorf("%s: err = %v, want errShape", c.name, err)
		}
	}
}

type fakeUpstream struct {
	path string
	body []byte
	res  *Response
	err  error
}

func (f *fakeUpstream) Post(_ context.Context, path string, body []byte) (*Response, error) {
	f.path, f.body = path, body
	return f.res, f.err
}

// The top-level shaping: an index search's hits, a multi-search's results by their own indexUid (else
// the query's at that position), and a facet search passed as it came.
func TestComputeShapesEachRoute(t *testing.T) {
	signedOut := ViewerOf(Session{})
	req, err := ParseBody(RouteSearch, ModelsIndex, []byte(`{"q":"cat"}`))
	if err != nil {
		t.Fatal(err)
	}
	up := &fakeUpstream{res: &Response{Status: 200, Body: []byte(` {"hits":[{"id":1,"name":"R","sfwName":"S"}],"query":"cat"} `)}}
	ans, err := Compute(context.Background(), up, req, signedOut)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"hits":[{"id":1,"name":"S"}],"query":"cat"}`; string(ans.Body) != want {
		t.Errorf("index search: %s, want %s", ans.Body, want)
	}
	if up.path != "/indexes/models_v9/search" {
		t.Errorf("index search path %q", up.path)
	}

	req, err = ParseBody(RouteMulti, "", []byte(`{"queries":[{"indexUid":"tools_v2","q":""},{"indexUid":"articles_v5"},{"indexUid":"models_v9"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	up.res = &Response{Status: 200, Body: []byte(`{"results":[{"indexUid":"tools_v2","hits":[{"id":1,"user":{"image":"t"}}]},{"hits":[{"id":2,"user":{"image":"a"}}]},{"indexUid":"models_v9","hits":[{"id":3,"sfwName":"S"}]}]}`)}
	ans, err = Compute(context.Background(), up, req, signedOut)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"results":[{"indexUid":"tools_v2","hits":[{"id":1,"user":{"image":"t"}}]},{"hits":[{"id":2,"user":{"image":null,"profilePicture":null}}]},{"indexUid":"models_v9","hits":[{"id":3}]}]}`
	if string(ans.Body) != want {
		t.Errorf("multi-search:\n got %s\nwant %s", ans.Body, want)
	}

	req, err = ParseBody(RouteFacet, ModelsIndex, []byte(`{"facetName":"type"}`))
	if err != nil {
		t.Fatal(err)
	}
	up.res = &Response{Status: 200, Body: []byte(`{"facetHits":[{"value":"LORA","count":3}]}`)}
	if ans, err = Compute(context.Background(), up, req, signedOut); err != nil || string(ans.Body) != `{"facetHits":[{"value":"LORA","count":3}]}` {
		t.Errorf("facet search: %s %v", ans.Body, err)
	}
	if up.path != "/indexes/models_v9/facet-search" {
		t.Errorf("facet path %q", up.path)
	}
}

// A backend that does not answer 200 with JSON, or does not answer, is handed back to Node.
func TestComputeUpstreamFailures(t *testing.T) {
	req, err := ParseBody(RouteSearch, ToolsIndex, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		up   *fakeUpstream
		want string
	}{
		{&fakeUpstream{err: errors.New("dial")}, "search-upstream-unavailable"},
		{&fakeUpstream{res: &Response{Status: 400, Body: []byte(`{"code":"invalid_search_filter"}`)}}, "search-upstream-status"},
		{&fakeUpstream{res: &Response{Status: 503}}, "search-upstream-status"},
		{&fakeUpstream{res: &Response{Status: 200, Body: []byte(`{"hits":[`)}}, "search-upstream-shape"},
		{&fakeUpstream{res: &Response{Status: 200, Body: []byte("{\"q\":\"\xff\"}")}}, "search-upstream-shape"},
		{&fakeUpstream{res: &Response{Status: 200, Body: []byte(`[1]`)}}, "search-upstream-shape"},
	} {
		if _, err := Compute(context.Background(), c.up, req, Viewer{}); fallback.Reason(err) != c.want {
			t.Errorf("%+v: %v, want %s", c.up.res, err, c.want)
		}
	}
	multi, err := ParseBody(RouteMulti, "", []byte(`{"queries":[{"indexUid":"models_v9"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"results":null}`, `{"results":{}}`, `{"results":[null]}`, `{"results":[{"indexUid":3}]}`} {
		up := &fakeUpstream{res: &Response{Status: 200, Body: []byte(body)}}
		if _, err := Compute(context.Background(), up, multi, Viewer{}); fallback.Reason(err) != "search-upstream-shape" {
			t.Errorf("%s: %v, want search-upstream-shape", body, err)
		}
	}
}

// A retired or unknown index is Node's 403: handed back before any call.
func TestComputeRefusesUnsearchableIndexes(t *testing.T) {
	up := &fakeUpstream{res: &Response{Status: 200, Body: []byte(`{}`)}}
	req, _ := ParseBody(RouteSearch, ImagesIndex, []byte(`{}`))
	if _, err := Compute(context.Background(), up, req, Viewer{}); fallback.Reason(err) != "search-index" || up.path != "" {
		t.Errorf("images_v6: %v (called %q), want search-index without a call", err, up.path)
	}
	multi, _ := ParseBody(RouteMulti, "", []byte(`{"queries":[{"indexUid":"models_v9"},{"indexUid":"metrics_images_v1"}]}`))
	if _, err := Compute(context.Background(), up, multi, Viewer{}); fallback.Reason(err) != "search-index" || up.path != "" {
		t.Errorf("multi with a retired index: %v, want search-index without a call", err)
	}
}
