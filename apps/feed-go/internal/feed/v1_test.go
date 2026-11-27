package feed

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestParseV1DefaultsAndTransforms(t *testing.T) {
	in, err := ParseV1("")
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 100 || in.Sort != "Most Reactions" || in.Period != "AllTime" || in.Nsfw != nil || in.BrowsingLevel != nil {
		t.Fatalf("defaults = %+v", in)
	}
	cases := []struct {
		query string
		nsfw  any // int or nil
	}{
		{"nsfw=None", 1},
		{"nsfw=Soft", 3},
		{"nsfw=Mature", 7},
		{"nsfw=X", 31},
		{"nsfw=Blocked", 32},
		{"nsfw=true", 60}, // nsfwBrowsingLevelsFlag: R|X|XXX|Blocked
		{"nsfw=false", nil},
	}
	for _, c := range cases {
		in, err := ParseV1(c.query)
		if err != nil {
			t.Errorf("%s: %v", c.query, err)
			continue
		}
		var got any
		if in.Nsfw != nil {
			got = *in.Nsfw
		}
		if got != c.nsfw {
			t.Errorf("%s: nsfw = %v, want %v", c.query, got, c.nsfw)
		}
	}
	in, err = ParseV1("modelId=3&modelVersionId=4&limit=0&page=2&browsingLevel=31&type=video&period=Week&sort=Newest&cursor=feed%3A1%3A2&username=a_b")
	if err != nil {
		t.Fatal(err)
	}
	if in.ModelID != 3 || in.ModelVersionID != 4 || in.Limit != 0 || in.Page != 2 || *in.BrowsingLevel != 31 ||
		in.Type != "video" || in.Period != "Week" || in.Sort != "Newest" || in.Cursor != "feed:1:2" || in.Username != "a_b" {
		t.Fatalf("parsed = %+v", in)
	}
}

func TestParseV1FallsBackOnShapesNotPorted(t *testing.T) {
	cases := map[string]string{
		"imageId=5":                 "v1-image-id",
		"ids=1&imageId=5":           "v1-image-id",
		"modelId=3":                 "v1-model-only",
		"ids=1&modelId=3":           "v1-model-only",
		"tags=5":                    "v1-tags",
		"baseModels=SDXL%201.0":     "v1-base-models",
		"withTags=1":                "v1-with-tags",
		"ids=1,0x10":                "v1-input-ids", // Number() reads hex; Node takes it
		"ids=1e3":                   "v1-input-ids",
		"ids=":                      "v1-input-ids",
		"ids=1,,2":                  "v1-input-ids",
		"ids=0":                     "v1-input-ids",
		"ids=-4":                    "v1-input-ids",
		"ids=2147483648":            "v1-input-ids", // past int4
		"ids=1&ids=2":               "v1-input-duplicate",
		"flatMeta=maybe":            "v1-input-bool",
		"ids=1,2":                   "",
		"withMeta=true&flatMeta=0":  "",
		"limit=1.5":                 "v1-input-number",
		"limit=201":                 "v1-input-number",
		"limit=":                    "v1-input-number",
		"modelVersionId=0x10":       "v1-input-number",
		"limit=5&limit=6":           "v1-input-duplicate",
		"sort=Random":               "v1-sort",
		"period=Decade":             "v1-input-period",
		"type=model":                "v1-input-type",
		"nsfw=maybe":                "v1-input-bool",
		"username=a-b":              "v1-input-username",
		"userId=0&username=a":       "v1-user-zero",
		"modelVersionId=%zz":        "v1-query-encoding",
		"withMeta=false&withTags=0": "",
	}
	for q, want := range cases {
		_, err := ParseV1(q)
		if got := fallback.Reason(err); got != want || (want == "" && err != nil) {
			t.Errorf("%s: reason %q (err %v), want %q", q, got, err, want)
		}
	}
}

func TestParseSearchIsReqQuery(t *testing.T) {
	got, err := ParseSearch("b=2&a=1&10=x&2=y&b=3&q=a+b%20c&&flag")
	if err != nil {
		t.Fatal(err)
	}
	// Object.keys order: array-index keys first (ascending), then insertion order; repeats collect.
	want := []QueryParam{
		{Key: "2", Values: []string{"y"}},
		{Key: "10", Values: []string{"x"}},
		{Key: "b", Values: []string{"2", "3"}},
		{Key: "a", Values: []string{"1"}},
		{Key: "q", Values: []string{"a b c"}},
		{Key: "flag", Values: []string{""}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearch:\n got %+v\nwant %+v", got, want)
	}
	// query-string's stringify: strict encoding, empty strings skipped, a repeat written twice.
	if s := QSStringify(got); s != "2=y&10=x&b=2&b=3&a=1&q=a%20b%20c" {
		t.Fatalf("QSStringify = %s", s)
	}
	if s := StrictURIEncode("a!'()*~-_.é/:"); s != "a%21%27%28%29%2A~-_.%C3%A9%2F%3A" {
		t.Fatalf("StrictURIEncode = %s", s)
	}
}

func TestNextPageURL(t *testing.T) {
	in, err := ParseV1("limit=50&page=2&modelVersionId=9")
	if err != nil {
		t.Fatal(err)
	}
	// A key outside the schema falls back in ParseV1 (input-unknown-key), but nextPage's own rule is
	// to keep every key of req.query in order, so it is exercised with one added after parsing.
	in.Query = append(in.Query, QueryParam{Key: "utm", Values: []string{"x"}})
	got, err := nextPageURL(in, "Civitai.Example:443", "/api/v1/images", true, true, "feed:1:2")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://civitai.example/api/v1/images?limit=50&page=3&modelVersionId=9&utm=x" {
		t.Fatalf("paging nextPage = %s", got)
	}
	in, _ = ParseV1("cursor=feed%3A1%3A1&limit=2")
	got, _ = nextPageURL(in, "civitai.example", "/api/v1/images", true, false, "feed:1:2")
	if got != "https://civitai.example/api/v1/images?cursor=feed%3A1%3A2&limit=2" {
		t.Fatalf("cursor nextPage (replaced in place) = %s", got)
	}
	got, _ = nextPageURL(in, "civitai.example", "/api/v1/images", false, false, "feed:1:2")
	if got != "http://localhost:3000/api/v1/images?cursor=feed%3A1%3A2&limit=2" {
		t.Fatalf("non-production nextPage = %s", got)
	}
	if _, err := nextPageURL(in, "civitai.example", "/api/v1/other", true, false, "x"); fallback.Reason(err) != "v1-path" {
		t.Fatalf("an unexpected path must fall back, got %v", err)
	}
}

func TestAssertFeedOffsetCursor(t *testing.T) {
	for c, ok := range map[string]bool{
		"": true, "feed:1700000000000:12": true, "500": true, "500|1724677401898": true, "5|anything": true,
		"-1": false, "abc": false, "3000000000": false, "feed:x:1": false, "1|2|3": false,
	} {
		err := AssertFeedOffsetCursor(c)
		if (err == nil) != ok {
			t.Errorf("%q: err %v, want ok=%v", c, err, ok)
		}
	}
}

const loc = "https://img.example/abc"

func TestEdgeURL(t *testing.T) {
	cases := []struct {
		name, src string
		o         EdgeOptions
		still     bool
		want      string
	}{
		{"original image, extension replaced", "img-uuid.png", EdgeOptions{Type: "image", Original: boolPtr(true)}, false,
			loc + "/img-uuid.png/original=true/img-uuid.jpeg"},
		{"original video", "vid-uuid", EdgeOptions{Type: "video", Original: boolPtr(true)}, false,
			loc + "/vid-uuid/original=true/vid-uuid.mp4"},
		{"percent signs dropped from the name only", "a%20b", EdgeOptions{Type: "image", Original: boolPtr(true)}, false,
			loc + "/a%20b/original=true/a20b.jpeg"},
		{"passthrough", "https://elsewhere.example/x.png", EdgeOptions{Type: "image"}, false, "https://elsewhere.example/x.png"},
		{"custom thumbnail still", "thumb-uuid", EdgeOptions{Type: "image", Anim: boolPtr(false)}, true,
			loc + "/thumb-uuid/anim=false,optimized=true/thumb-uuid.jpeg"},
		{"video still with a skip", "vid-uuid", EdgeOptions{Type: "image", Anim: boolPtr(false), Transcode: true, Skip: func() *float64 { f := 4.0; return &f }()}, true,
			loc + "/vid-uuid/anim=false,transcode=true,optimized=true,skip=4/vid-uuid.jpeg"},
	}
	for _, c := range cases {
		got := EdgeURL(loc, c.src, c.o)
		if c.still {
			got = stillURL(loc, c.src, c.o)
		}
		if got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

func TestSkipValue(t *testing.T) {
	four, two := 4.0, 2.0
	cases := []struct {
		meta string
		want *float64
	}{
		{`{"width":640,"height":360,"duration":45}`, &four},
		{`{"width":640,"height":360,"duration":45,"thumbnailFrame":2}`, &two},
		{`{"width":640,"height":360,"duration":45,"thumbnailFrame":null}`, &four}, // nullish
		{`{"width":640,"height":360,"duration":30}`, nil},                         // not longer than an animation
		{`{"width":640,"height":360}`, nil},
		{`{"height":360,"duration":45}`, nil},                               // width is required
		{`{"width":640,"height":360,"duration":45,"size":null}`, nil},       // optional() refuses null
		{`{"width":640,"height":360,"duration":45,"audio":"yes"}`, nil},     // wrong type
		{`{"width":640,"height":360,"duration":45,"extra":{"x":1}}`, &four}, // unknown keys are stripped
		{`null`, nil},
		{``, nil},
	}
	for _, c := range cases {
		got := SkipValue(json.RawMessage(c.meta))
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %v, want %v", c.meta, deref(got), deref(c.want))
		}
	}
}

func deref(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}

func strp(s string) *string { return &s }
func intp(n int) *int       { return &n }

var published = time.Date(2024, 3, 1, 9, 0, 0, 0, time.UTC)

func row(id, postID int, typ, url string, nsfw int, meta string) RawImage {
	r := RawImage{
		ID: id, PostID: postID, UserID: 5, Type: typ, URL: strp(url), NsfwLevel: nsfw,
		Width: intp(512), Height: intp(768), Hash: strp("H"), PublishedAt: &published,
		SortAt: time.Date(2024, 3, 1, 10, 0, 0, 123_456_000, time.UTC),
	}
	if meta != "" {
		r.Metadata = json.RawMessage(meta)
	}
	return r
}

type fakeV1Sources struct {
	users     map[int]hydrate.BasicUser
	thumbs    map[int]hydrate.Thumbnail
	metrics   map[int]hydrate.Metrics
	resources map[int][]hydrate.ImageResource
	posts     map[int]int
	versions  map[int]int
	usernames map[string]int
	meta      map[int]any
	// metaAsked is each V1Page call's MetaIDs.
	metaAsked [][]int
	// follows answers UserFollows (absent: no follows); followsErr fails it; followsAsked is each
	// call's user id.
	follows      map[int][]int
	followsErr   error
	followsAsked []int
	// collections answers CollectionPermission per collection id (absent: no such collection), with
	// the contributor permissions of contributors[collection][viewer]; collectionsErr fails it;
	// collectionsAsked is each call's [collection, viewer].
	collections      map[int]hydrate.CollectionPermission
	contributors     map[int]map[int][]string
	collectionsErr   error
	collectionsAsked [][2]int
	// showcase answers VersionShowcase (zero: ShowcaseUncurated), with no error, unless
	// showcaseFrom is set, which then answers it (a real cache read and miss computation);
	// showcaseAsked is each call's ids.
	showcase      hydrate.Showcase
	showcaseFrom  *hydrate.Sources
	showcaseAsked [][]int
}

func pickIDs[V any](m map[int]V, ids []int) map[int]V {
	out := map[int]V{}
	for _, id := range ids {
		if v, ok := m[id]; ok {
			out[id] = v
		}
	}
	return out
}

func (f *fakeV1Sources) V1Page(_ context.Context, req hydrate.V1PageRequest) (*hydrate.V1Page, error) {
	f.metaAsked = append(f.metaAsked, req.MetaIDs)
	p := &hydrate.V1Page{
		Basic: pickIDs(f.users, req.UserIDs), Thumbs: pickIDs(f.thumbs, req.VideoIDs),
		Metrics: pickIDs(f.metrics, req.ImageIDs), Resources: pickIDs(f.resources, req.ImageIDs),
	}
	if len(req.MetaIDs) > 0 {
		p.Meta = pickIDs(f.meta, req.MetaIDs)
	}
	return p, nil
}
func (f *fakeV1Sources) PostVersions(_ context.Context, ids []int) (map[int]int, error) {
	return pickIDs(f.posts, ids), nil
}
func (f *fakeV1Sources) VersionModels(_ context.Context, ids []int) (map[int]int, error) {
	return pickIDs(f.versions, ids), nil
}
func (f *fakeV1Sources) UserIDByUsername(_ context.Context, u string) (int, bool, error) {
	id, ok := f.usernames[u]
	return id, ok, nil
}
func (f *fakeV1Sources) UserFollows(_ context.Context, userID int) ([]int, error) {
	f.followsAsked = append(f.followsAsked, userID)
	if f.followsErr != nil {
		return nil, f.followsErr
	}
	if v, ok := f.follows[userID]; ok {
		return v, nil
	}
	return []int{}, nil
}
func (f *fakeV1Sources) CollectionPermission(_ context.Context, collectionID, viewerID int) (*hydrate.CollectionPermission, error) {
	f.collectionsAsked = append(f.collectionsAsked, [2]int{collectionID, viewerID})
	if f.collectionsErr != nil {
		return nil, f.collectionsErr
	}
	c, ok := f.collections[collectionID]
	if !ok {
		return nil, nil
	}
	c.CollectionID = collectionID
	c.Contributor = []string{}
	if viewerID != 0 && f.contributors[collectionID][viewerID] != nil {
		c.Contributor = f.contributors[collectionID][viewerID]
	}
	return &c, nil
}

func (f *fakeV1Sources) VersionShowcase(ctx context.Context, ids []int) (hydrate.Showcase, error) {
	f.showcaseAsked = append(f.showcaseAsked, ids)
	if f.showcaseFrom != nil {
		return f.showcaseFrom.VersionShowcase(ctx, ids)
	}
	return f.showcase, nil
}

type fakeV1Gallery struct {
	settings map[int]*GallerySettings
	withheld map[int]bool
}

func (g *fakeV1Gallery) SettingsMany(_ context.Context, ids []int) (map[int]*GallerySettings, error) {
	return pickIDs(g.settings, ids), nil
}
func (g *fakeV1Gallery) Withheld(_ context.Context, ids []int, _ int) (bool, error) {
	for _, id := range ids {
		if g.withheld[id] {
			return true, nil
		}
	}
	return false, nil
}

type v1Feed struct {
	ans     feedsvc.Answer
	queries []string
}

func (f *v1Feed) Fetch(_ context.Context, q string) (feedsvc.Answer, error) {
	f.queries = append(f.queries, q)
	return f.ans, nil
}

type v1Fixture struct {
	deps    *V1Deps
	feed    *v1Feed
	src     *fakeV1Sources
	gallery *fakeV1Gallery
	hq      []ImagesQuery
	trivial []bool // V1Answer.Trivial per served call
}

func newV1Fixture(rows []RawImage) *v1Fixture {
	f := &v1Fixture{
		feed: &v1Feed{ans: feedsvc.Answer{Status: 200, IDs: []int{11, 10}, NextCursor: "1700000000000|10"}},
		src: &fakeV1Sources{
			users:   map[int]hydrate.BasicUser{5: {ID: 5, Username: "alice"}},
			thumbs:  map[int]hydrate.Thumbnail{10: {URL: "thumb-uuid", NsfwLevel: 1, Width: int64(320), Height: int64(180), Servable: true}},
			metrics: map[int]hydrate.Metrics{10: {"Like": 3}, 11: {"Heart": 2, "commentCount": 1}},
			resources: map[int][]hydrate.ImageResource{11: {
				{ModelVersionID: 9, Detected: true, ModelType: "Checkpoint", BaseModel: "SDXL 1.0"},
				{ModelVersionID: 12, Detected: false, ModelType: "LORA", BaseModel: "Pony"},
			}},
			posts:    map[int]int{100: 9, 101: 0},
			versions: map[int]int{9: 7},
		},
		gallery: &fakeV1Gallery{settings: map[int]*GallerySettings{7: nil}},
	}
	f.deps = &V1Deps{
		Feed: f.feed, Sources: f.src, Gallery: f.gallery,
		Rows: func(_ context.Context, q ImagesQuery) ([]RawImage, error) {
			f.hq = append(f.hq, q)
			// `i."id" = ANY(ids)`: each row once, in the order the rows are listed (the SQL's).
			var out []RawImage
			for _, r := range rows {
				for _, id := range q.IDs {
					if r.ID == id {
						out = append(out, r)
						break
					}
				}
			}
			return out, nil
		},
		Addons: func(context.Context) []browsing.Addon {
			return []browsing.Addon{{Type: "some", NsfwLevels: []int{1}, ExcludedTagIDs: []int{5, 5}}}
		},
		ImageLocation:  loc,
		NodeProduction: true,
		Now:            func() time.Time { return published.Add(24 * time.Hour) },
	}
	return f
}

func serveV1(t *testing.T, f *v1Fixture, query string, viewer *Viewer) (string, error) {
	t.Helper()
	return serveV1As(t, f, query, viewer, "")
}

// serveV1As is serveV1 with the session user's name.
func serveV1As(t *testing.T, f *v1Fixture, query string, viewer *Viewer, username string) (string, error) {
	t.Helper()
	in, err := ParseV1With(query, f.deps.Ports)
	if err != nil {
		t.Fatalf("parse %q: %v", query, err)
	}
	ans, err := ServeV1(context.Background(), f.deps, V1Request{Input: in, Viewer: viewer, ViewerUsername: username, Host: "civitai.example", Path: "/api/v1/images"})
	if err != nil {
		return "", err
	}
	f.trivial = append(f.trivial, ans.Trivial)
	b, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b), nil
}

func TestServeV1VersionGallery(t *testing.T) {
	f := newV1Fixture([]RawImage{
		row(10, 100, "video", "vid-uuid", 1, `{"width":640,"height":360,"duration":45}`),
		row(11, 101, "image", "img-uuid.png", 1, ""),
	})
	got, err := serveV1(t, f, "modelVersionId=9&limit=2&sort=Newest", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"items":[` +
		`{"id":11,"url":"https://img.example/abc/img-uuid.png/original=true/img-uuid.jpeg","hash":"H","width":512,"height":768,` +
		`"nsfwLevel":"None","type":"image","nsfw":false,"browsingLevel":1,"createdAt":"2024-03-01T10:00:00.123Z","postId":101,` +
		`"thumbnail":null,"stats":{"cryCount":0,"laughCount":0,"likeCount":0,"dislikeCount":0,"heartCount":2,"commentCount":1},` +
		`"meta":null,"username":"alice","baseModel":"SDXL 1.0","modelVersionIds":[9]},` +
		`{"id":10,"url":"https://img.example/abc/vid-uuid/original=true/vid-uuid.mp4","hash":"H","width":512,"height":768,` +
		`"nsfwLevel":"None","type":"video","nsfw":false,"browsingLevel":1,"createdAt":"2024-03-01T10:00:00.123Z","postId":100,` +
		`"thumbnail":{"url":"https://img.example/abc/thumb-uuid/anim=false,optimized=true/thumb-uuid.jpeg","width":320,"height":180},` +
		`"stats":{"cryCount":0,"laughCount":0,"likeCount":3,"dislikeCount":0,"heartCount":0,"commentCount":0},` +
		`"meta":null,"username":"alice","baseModel":null,"modelVersionIds":[]}],` +
		`"metadata":{"nextCursor":"feed:1700000000000:10",` +
		`"nextPage":"https://civitai.example/api/v1/images?modelVersionId=9&limit=2&sort=Newest&cursor=feed%3A1700000000000%3A10"}}`
	if got != want {
		t.Fatalf("body:\n got %s\nwant %s", got, want)
	}
	if !reflect.DeepEqual(f.trivial, []bool{false}) {
		t.Fatalf("a hydrated page is not trivial: %v", f.trivial)
	}
	// The feed query: the addon tags (deduped), the version, minor and POI always excluded on this route.
	if q := f.feed.queries; len(q) != 1 || q[0] != "levels=1&excludedTags=5&versionIds=9&excludeMinor=1&excludePoi=1&sort=newest&limit=2" {
		t.Fatalf("feed queries = %v", q)
	}
	// The hydrate: exactly the feed's ids, without the model scope or the period, timeouts thrown.
	h := f.hq[0]
	if !reflect.DeepEqual(h.IDs, []int{11, 10}) || h.Limit != 2 || h.ModelVersionID != 0 || h.Period != "AllTime" ||
		!h.ThrowOnStatementTimeout || !reflect.DeepEqual(h.ExcludedTagIDs, []int{5}) || !h.DisablePoi || !h.DisableMinor {
		t.Fatalf("hydrate query = %+v", h)
	}
}

func TestServeV1PagingMetadata(t *testing.T) {
	f := newV1Fixture([]RawImage{row(11, 101, "image", "img-uuid", 1, "")})
	f.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11}}
	got, err := serveV1(t, f, "page=2&limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	// No feed cursor: no nextCursor and no nextPage, but the paging keys are reported.
	if !strings.HasSuffix(got, `"metadata":{"currentPage":2,"pageSize":1}}`) {
		t.Fatalf("metadata of %s", got)
	}
	// `page` does not reach the feed (the mapper reads `offset`, which this route never sets).
	if f.feed.queries[0] != "levels=1&excludedTags=5&excludeMinor=1&excludePoi=1&sort=reactions&limit=1" {
		t.Fatalf("feed query = %s", f.feed.queries[0])
	}
	if _, err := serveV1(t, f, "page=11&limit=100", nil); fallback.Reason(err) != "v1-page-limit" {
		t.Fatalf("page*limit > 1000 (Node's 429) must fall back, got %v", err)
	}
}

// withoutHeldImages: an image above its post's held model level is left out, even off the gallery.
func TestServeV1LeavesOutHeldImages(t *testing.T) {
	f := newV1Fixture([]RawImage{
		row(10, 100, "image", "a", 4, ""), // post 100 → version 9 → model 7, held at PG
		row(11, 101, "image", "b", 4, ""), // post 101 has no version
	})
	f.gallery.settings[7] = &GallerySettings{SfwHeld: boolPtr(true), Level: intp(browsing.PG)}
	f.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{10, 11}}
	got, err := serveV1(t, f, "browsingLevel=31", nil)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Items []struct {
			ID int `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(got), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].ID != 11 {
		t.Fatalf("items = %+v, want only 11", body.Items)
	}
	// Positive control: unheld, both are served.
	f.gallery.settings[7] = nil
	got, _ = serveV1(t, f, "browsingLevel=31", nil)
	if !strings.Contains(got, `"id":10`) || !strings.Contains(got, `"id":11`) {
		t.Fatalf("unheld body = %s", got)
	}
}

func TestServeV1GalleryGates(t *testing.T) {
	f := newV1Fixture(nil)
	f.gallery.withheld = map[int]bool{7: true}
	got, err := serveV1(t, f, "modelVersionId=9", &Viewer{ID: 99, IsModerator: true})
	if err != nil {
		t.Fatal(err)
	}
	// Taken down: empty for everyone on this route, a moderator included, and no feed call.
	if got != `{"items":[],"metadata":{}}` || len(f.feed.queries) != 0 || !f.trivial[0] {
		t.Fatalf("withheld: body %s, feed calls %d, trivial %v", got, len(f.feed.queries), f.trivial)
	}
	f = newV1Fixture(nil)
	if got, _ := serveV1(t, f, "modelVersionId=404", nil); got != `{"items":[],"metadata":{}}` {
		t.Fatalf("unknown version: %s", got)
	}
	if got, _ := serveV1(t, f, "postId=404", nil); got != `{"items":[],"metadata":{}}` {
		t.Fatalf("unknown post: %s", got)
	}
	// Held at PG, asked for R only: nothing left.
	f.gallery.settings[7] = &GallerySettings{SfwHeld: boolPtr(true), Level: intp(browsing.PG)}
	if got, _ := serveV1(t, f, "modelVersionId=9&browsingLevel=4", nil); got != `{"items":[],"metadata":{}}` {
		t.Fatalf("held to nothing: %s", got)
	}
	// Held at PG, asked for PG|R: the feed is asked at PG only.
	f.feed.ans = feedsvc.Answer{Status: 200}
	if _, err := serveV1(t, f, "modelVersionId=9&browsingLevel=5", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.feed.queries[len(f.feed.queries)-1]; !strings.HasPrefix(q, "levels=1&") {
		t.Fatalf("held feed query = %s", q)
	}
	f.gallery.settings[7] = &GallerySettings{SfwHeld: boolPtr(true)}
	if _, err := serveV1(t, f, "modelVersionId=9", nil); fallback.Reason(err) != "v1-held-level-unset" {
		t.Fatalf("a held model without a level must fall back, got %v", err)
	}
}

func TestServeV1ViewerAndCreator(t *testing.T) {
	f := newV1Fixture([]RawImage{row(11, 101, "image", "b", 1, "")})
	f.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11}}
	f.src.usernames = map[string]int{"alice": 5}
	if _, err := serveV1(t, f, "username=alice", &Viewer{ID: 5}); err != nil {
		t.Fatal(err)
	}
	// A username is resolved for the feed; the viewer's own `username` does not make it their own feed
	// (only a userId does), so the addon tags stay.
	if q := f.feed.queries[0]; q != "levels=1&excludedTags=5&userIds=5&excludeMinor=1&excludePoi=1&viewerId=5&sort=reactions&limit=100" {
		t.Fatalf("username feed query = %s", q)
	}
	if f.hq[0].TargetUserID != 5 || f.hq[0].ViewerID != 5 {
		t.Fatalf("hydrate = %+v", f.hq[0])
	}
	if _, err := serveV1(t, f, "userId=5", &Viewer{ID: 5}); err != nil {
		t.Fatal(err)
	}
	if q := f.feed.queries[1]; q != "levels=1&userIds=5&excludeMinor=1&excludePoi=1&viewerId=5&sort=reactions&limit=100" {
		t.Fatalf("own feed query (no addon tags) = %s", q)
	}
	if _, err := serveV1(t, f, "username=bob", nil); fallback.Reason(err) != "v1-username-miss" {
		t.Fatalf("an unknown username must fall back (Node reads the primary next), got %v", err)
	}
}

func TestServeV1FeedAnswers(t *testing.T) {
	f := newV1Fixture(nil)
	// A shape the feed cannot express is an empty page; with a feed cursor it is a 400.
	if got, err := serveV1(t, f, "requiringMeta=true", nil); err != nil || got != `{"items":[],"metadata":{}}` {
		t.Fatalf("requiringMeta: %s %v", got, err)
	}
	if _, err := serveV1(t, f, "requiringMeta=true&cursor=feed%3A1%3A2", nil); fallback.Reason(err) != "feed-refused" {
		t.Fatalf("refused feed cursor: %v", err)
	}
	if _, err := serveV1(t, f, "cursor=abc", nil); fallback.Reason(err) != "v1-cursor" {
		t.Fatalf("malformed cursor: %v", err)
	}
	if got, err := serveV1(t, f, "limit=0", nil); err != nil || got != `{"items":[],"metadata":{}}` || len(f.feed.queries) != 0 {
		t.Fatalf("limit 0: %s %v, feed calls %d", got, err, len(f.feed.queries))
	}
	// requiringMeta's empty page and limit=0 are both trivial answers.
	if !reflect.DeepEqual(f.trivial, []bool{true, true}) {
		t.Fatalf("trivial = %v, want [true true]", f.trivial)
	}
	f.feed.ans = feedsvc.Answer{Status: 503}
	if _, err := serveV1(t, f, "", nil); fallback.Reason(err) != "feed-status" {
		t.Fatalf("feed 503: %v", err)
	}
	// Every id filtered out at the hydrate (here: an unpublished post) is not the end of the feed.
	f = newV1Fixture([]RawImage{{ID: 11, PostID: 101, UserID: 5, Type: "image"}})
	f.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11}}
	if _, err := serveV1(t, f, "", nil); fallback.Reason(err) != "feed-hydrate-empty" {
		t.Fatalf("empty hydrate: %v", err)
	}
	// ... unless it is the viewer's own.
	if _, err := serveV1(t, f, "", &Viewer{ID: 5}); err != nil {
		t.Fatalf("own unpublished image: %v", err)
	}
	f.deps.Feed = nil
	if _, err := serveV1(t, f, "", nil); fallback.Reason(err) != "index-feed-unconfigured" {
		t.Fatalf("no feed service: %v", err)
	}
}

func TestShapeV1VideoStillWithoutCustomThumbnail(t *testing.T) {
	r := row(10, 100, "video", "vid-uuid", 4, `{"width":640,"height":360,"duration":45}`)
	// The custom thumbnail is R and the request PG only: the video's own still is published.
	it, err := ShapeV1Image(r, V1Hydrated{Thumb: hydrate.Thumbnail{URL: "t", NsfwLevel: 4}, HasThumb: true}, browsing.PG, loc)
	if err != nil {
		t.Fatal(err)
	}
	thumb, _ := it.wire.Get("thumbnail")
	b, _ := superjson.Plain(thumb)
	if string(b) != `{"url":"https://img.example/abc/vid-uuid/anim=false,transcode=true,optimized=true,skip=4/vid-uuid.jpeg","width":512,"height":768}` {
		t.Fatalf("thumbnail = %s", b)
	}
	if lvl, _ := it.wire.Get("nsfwLevel"); lvl != "Mature" || it.browsingLevel != 4 {
		t.Fatalf("nsfwLevel = %v, browsingLevel %d", lvl, it.browsingLevel)
	}
	// A cached username that decoded as a number is published as a string.
	it, _ = ShapeV1Image(row(1, 1, "image", "x", 1, ""), V1Hydrated{User: hydrate.BasicUser{Username: int64(222)}, HasUser: true}, browsing.PG, loc)
	if u, _ := it.wire.Get("username"); u != "222" {
		t.Fatalf("username = %#v", u)
	}
}

// baseModel is getBaseModelFromResources from src/server/redis/caches.ts (what image.service.ts
// imports): `if (!resources) return null; return resources.find((r) => r.modelType ===
// 'Checkpoint')?.baseModel ?? null`. The raw value, never an ecosystem group, and null (not absent)
// without a checkpoint, unlike the same-named helper in generation.constants.ts, which would answer
// a group for the first case and vote one for the second.
func TestShapeV1BaseModelIsTheCachesHelper(t *testing.T) {
	cases := []struct {
		name string
		h    V1Hydrated
		want string
	}{
		{"checkpoint: its raw baseModel", V1Hydrated{HasResources: true, Resources: []hydrate.ImageResource{
			{ModelVersionID: 2, ModelType: "LORA", BaseModel: "Pony"},
			{ModelVersionID: 1, ModelType: "Checkpoint", BaseModel: "SDXL 1.0"},
		}}, `"SDXL 1.0"`},
		{"no checkpoint: null, no vote", V1Hydrated{HasResources: true, Resources: []hydrate.ImageResource{
			{ModelVersionID: 2, ModelType: "LORA", BaseModel: "Pony"},
			{ModelVersionID: 3, ModelType: "LORA", BaseModel: "Pony"},
		}}, `null`},
		{"no resources entry: null", V1Hydrated{}, `null`},
	}
	for _, c := range cases {
		it, err := ShapeV1Image(row(1, 1, "image", "x", 1, ""), c.h, browsing.PG, loc)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := superjson.Plain(it.wire)
		if !strings.Contains(string(b), `"baseModel":`+c.want+`,`) {
			t.Errorf("%s: %s", c.name, b)
		}
	}
}

func TestParseV1IDsAndMeta(t *testing.T) {
	// Each part trimmed, the request's order and repeats kept (the SQL dedupes and orders).
	in, err := ParseV1("ids=%203,1%09,3&withMeta=yes&flatMeta=false")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in.IDs, []int{3, 1, 3}) || !in.WithMeta || in.FlatMeta == nil || *in.FlatMeta {
		t.Fatalf("parsed = %+v (flatMeta %v)", in, in.FlatMeta)
	}
	// flatMeta absent is undefined (the path decides), not false.
	in, err = ParseV1("withMeta=1")
	if err != nil {
		t.Fatal(err)
	}
	if in.IDs != nil || !in.WithMeta || in.FlatMeta != nil {
		t.Fatalf("parsed = %+v", in)
	}
	// IMAGE_IDS_BATCH_MAX: 100 ids are a batch, 101 a 400.
	if in, err := ParseV1("ids=" + strings.Repeat("7,", 99) + "8"); err != nil || len(in.IDs) != 100 || in.IDs[99] != 8 {
		t.Fatalf("100 ids: %v", err)
	}
	if _, err := ParseV1("ids=" + strings.Repeat("7,", 100) + "8"); fallback.Reason(err) != "v1-input-ids" {
		t.Fatalf("101 ids: %v", err)
	}
}

// legacyRow is row with the image's own createdAt (not its sortAt, so which one is published shows)
// and the cursor column the legacy query selects.
func legacyRow(id, postID, cursor int) RawImage {
	r := row(id, postID, "image", "u"+strconv.Itoa(id), 1, "")
	r.CreatedAt = time.Date(2024, 2, 1, 8, 0, 0, 7_000_000, time.UTC)
	r.CursorID = cursor
	return r
}

// `ids` takes the legacy path: no feed call, getAllImages' own page (the rows in the SQL's order,
// whatever the request's), the look-ahead row's id as a NUMBER nextCursor, the image's own createdAt.
func TestServeV1LegacyIDsBatch(t *testing.T) {
	f := newV1Fixture([]RawImage{legacyRow(12, 101, 12), legacyRow(11, 101, 11), legacyRow(10, 100, 10)})
	f.src.metrics[12] = hydrate.Metrics{"Like": 6}
	got, err := serveV1(t, f, "ids=10,12,11,10&limit=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"items":[` +
		`{"id":12,"url":"https://img.example/abc/u12/original=true/u12.jpeg","hash":"H","width":512,"height":768,` +
		`"nsfwLevel":"None","type":"image","nsfw":false,"browsingLevel":1,"createdAt":"2024-02-01T08:00:00.007Z","postId":101,` +
		`"thumbnail":null,"stats":{"cryCount":0,"laughCount":0,"likeCount":6,"dislikeCount":0,"heartCount":0,"commentCount":0},` +
		`"meta":null,"username":"alice","baseModel":null,"modelVersionIds":[]},` +
		`{"id":11,"url":"https://img.example/abc/u11/original=true/u11.jpeg","hash":"H","width":512,"height":768,` +
		`"nsfwLevel":"None","type":"image","nsfw":false,"browsingLevel":1,"createdAt":"2024-02-01T08:00:00.007Z","postId":101,` +
		`"thumbnail":null,"stats":{"cryCount":0,"laughCount":0,"likeCount":0,"dislikeCount":0,"heartCount":2,"commentCount":1},` +
		`"meta":null,"username":"alice","baseModel":"SDXL 1.0","modelVersionIds":[9]}],` +
		`"metadata":{"nextCursor":10,"nextPage":"https://civitai.example/api/v1/images?ids=10%2C12%2C11%2C10&limit=2&cursor=10"}}`
	if got != want {
		t.Fatalf("body:\n got %s\nwant %s", got, want)
	}
	if len(f.feed.queries) != 0 {
		t.Fatalf("the legacy path asked the feed: %v", f.feed.queries)
	}
	q := f.hq[0]
	if !reflect.DeepEqual(q.IDs, []int{10, 12, 11, 10}) || q.Limit != 2 || q.Skip != 0 || q.Cursor != 0 || q.Sort != SortMostReactions ||
		q.Period != "AllTime" || q.PeriodMode != "published" || q.ThrowOnStatementTimeout || q.IndexOrder || q.BrowsingLevel != browsing.PG ||
		!reflect.DeepEqual(q.ExcludedTagIDs, []int{5}) || !q.DisablePoi || !q.DisableMinor {
		t.Fatalf("legacy query = %+v", q)
	}
	if !reflect.DeepEqual(f.trivial, []bool{false}) {
		t.Fatalf("trivial = %v", f.trivial)
	}
}

// The request's paging, sort, period, type and scope reach getAllImages as its own inputs.
func TestServeV1LegacyQueryInputs(t *testing.T) {
	f := newV1Fixture([]RawImage{legacyRow(10, 100, 10)})
	last := func() ImagesQuery { return f.hq[len(f.hq)-1] }
	if _, err := serveV1(t, f, "ids=10,11&cursor=11&sort=Oldest&period=Week&type=video", nil); err != nil {
		t.Fatal(err)
	}
	if q := last(); q.Cursor != 11 || q.Sort != SortOldest || q.Period != "Week" || !reflect.DeepEqual(q.Types, []string{"video"}) || q.Skip != 0 {
		t.Fatalf("cursor query = %+v", q)
	}
	got, err := serveV1(t, f, "ids=10,11&page=3&limit=5", nil)
	if err != nil {
		t.Fatal(err)
	}
	if q := last(); q.Skip != 10 || q.Limit != 5 || q.Cursor != 0 {
		t.Fatalf("paged query = %+v, want skip (3-1)*5", q)
	}
	if !strings.HasSuffix(got, `"metadata":{"currentPage":3,"pageSize":5}}`) {
		t.Fatalf("paged metadata of %s", got)
	}
	if _, err := serveV1(t, f, "ids=10&postId=100", nil); err != nil {
		t.Fatal(err)
	}
	if q := last(); !q.IndexOrder || q.PostID != 100 {
		t.Fatalf("a post's own media: %+v", q)
	}
	if _, err := serveV1(t, f, "ids=10&postId=100&modelId=7&modelVersionId=9", nil); err != nil {
		t.Fatal(err)
	}
	if q := last(); q.IndexOrder || q.ModelID != 7 || q.ModelVersionID != 9 {
		t.Fatalf("a post under a model is not index-ordered: %+v", q)
	}
}

// The look-ahead row's cursor column is the nextCursor as is: a NULL index is null, an index of 0 is
// 0, and neither writes a nextPage (`!!nextCursor`); any other value does.
func TestServeV1LegacyNextCursorValues(t *testing.T) {
	cases := []struct {
		look RawImage
		want string
	}{
		{func() RawImage { r := legacyRow(11, 100, 0); r.CursorNull = true; return r }(), `"metadata":{"nextCursor":null}}`},
		{legacyRow(11, 100, 0), `"metadata":{"nextCursor":0}}`},
		{legacyRow(11, 100, 3), `"metadata":{"nextCursor":3,"nextPage":"https://civitai.example/api/v1/images?ids=10%2C11&postId=100&limit=1&cursor=3"}}`},
	}
	for _, c := range cases {
		f := newV1Fixture([]RawImage{legacyRow(10, 100, 0), c.look})
		got, err := serveV1(t, f, "ids=10,11&postId=100&limit=1", nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(got, c.want) || !strings.Contains(got, `"id":10,`) || strings.Contains(got, `"id":11,`) {
			t.Errorf("body %s, want one item and %s", got, c.want)
		}
	}
}

// The legacy path's addons read the session username: a `username` naming the viewer is their own
// feed (no tag exclusions). The feed path's viewer carries none, so there it is not.
func TestServeV1LegacyOwnScopeByUsername(t *testing.T) {
	f := newV1Fixture([]RawImage{legacyRow(10, 100, 10)})
	f.src.usernames = map[string]int{"alice": 5}
	cases := []struct {
		viewer   *Viewer
		username string
		excluded []int
	}{
		{&Viewer{ID: 5}, "ALICE", nil},
		{&Viewer{ID: 5}, "bob", []int{5}},
		{nil, "alice", []int{5}}, // a name without a session user (banned) is no one
	}
	for _, c := range cases {
		if _, err := serveV1As(t, f, "ids=10&username=alice", c.viewer, c.username); err != nil {
			t.Fatal(err)
		}
		if q := f.hq[len(f.hq)-1]; !reflect.DeepEqual(q.ExcludedTagIDs, c.excluded) || q.TargetUserID != 5 {
			t.Errorf("viewer %+v %q: excluded %v target %d, want %v 5", c.viewer, c.username, q.ExcludedTagIDs, q.TargetUserID, c.excluded)
		}
	}
	f.feed.ans = feedsvc.Answer{Status: 200}
	if _, err := serveV1As(t, f, "username=alice", &Viewer{ID: 5}, "alice"); err != nil {
		t.Fatal(err)
	}
	if q := f.feed.queries[0]; !strings.Contains(q, "excludedTags=5&") {
		t.Fatalf("feed path with the viewer's own username = %s, want the tag exclusions kept", q)
	}
}

func TestServeV1LegacyAnswersAndFallbacks(t *testing.T) {
	unpublished := legacyRow(13, 100, 13)
	unpublished.PublishedAt = nil
	f := newV1Fixture([]RawImage{legacyRow(10, 100, 10), unpublished})
	for _, c := range []string{"abc", "0", "feed%3A1%3A2", "2147483648"} {
		if _, err := serveV1(t, f, "ids=10&cursor="+c, nil); fallback.Reason(err) != "v1-legacy-cursor" {
			t.Errorf("cursor %s: %v", c, err)
		}
	}
	if len(f.hq) != 0 {
		t.Fatalf("a refused cursor queried: %+v", f.hq)
	}
	// Only unselectable levels: an empty page without a query.
	if got, err := serveV1(t, f, "ids=10&browsingLevel=32", nil); err != nil || got != `{"items":[],"metadata":{}}` || len(f.hq) != 0 {
		t.Fatalf("blocked-only level: %s %v, queries %d", got, err, len(f.hq))
	}
	// No row, or only a hidden one: an empty page (no read rescue on this path), and not trivial: its
	// query ran. The unselectable-level page above ran none, and is.
	for _, q := range []string{"ids=99", "ids=13"} {
		if got, err := serveV1(t, f, q, nil); err != nil || got != `{"items":[],"metadata":{}}` {
			t.Fatalf("%s: %s %v", q, got, err)
		}
	}
	if !reflect.DeepEqual(f.trivial, []bool{true, false, false}) {
		t.Fatalf("trivial = %v", f.trivial)
	}
	// The owner's unpublished image is served to them.
	if got, err := serveV1(t, f, "ids=13", &Viewer{ID: 5}); err != nil || !strings.Contains(got, `"id":13,`) {
		t.Fatalf("own unpublished: %s %v", got, err)
	}
	// requiringMeta empties a feed page (a shape the feed cannot express); getAllImages reads it as
	// its own clause (only AiNotVerified-blocked images, src/server/services/image.service.ts).
	if _, err := serveV1(t, f, "ids=10&requiringMeta=true", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.hq[len(f.hq)-1]; !q.RequiringMeta {
		t.Fatalf("requiringMeta on the legacy path: query %+v, want RequiringMeta", q)
	}
	if _, err := serveV1(t, f, "ids=10&requiringMeta=false", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.hq[len(f.hq)-1]; q.RequiringMeta {
		t.Fatalf("requiringMeta=false on the legacy path: query %+v", q)
	}
	if _, err := serveV1(t, f, "ids=10&username=bob", nil); fallback.Reason(err) != "v1-username-miss" {
		t.Fatalf("unknown username: %v", err)
	}
	f.deps.Rows = func(context.Context, ImagesQuery) ([]RawImage, error) { return nil, errors.New("replica down") }
	if _, err := serveV1(t, f, "ids=10", nil); fallback.Reason(err) != "v1-legacy-error" {
		t.Fatalf("query error: %v", err)
	}
}

// withMeta: the meta is read for the page's images only when asked; flat on the feed path and
// `{ id, meta }` on the legacy path unless flatMeta says otherwise. Each item's `meta` is decoded
// and compared whole, so a wrapped meta cannot pass for a flat one (or the reverse).
func TestServeV1WithMeta(t *testing.T) {
	meta := map[int]any{11: superjson.Object{{Key: "prompt", Val: "p11"}, {Key: "cfg", Val: 7.5}}, 10: nil}
	feedPage := newV1Fixture([]RawImage{row(10, 100, "image", "a", 1, ""), row(11, 101, "image", "b", 1, "")})
	legacy := newV1Fixture([]RawImage{legacyRow(11, 101, 11), legacyRow(10, 100, 10)})
	feedPage.src.meta, legacy.src.meta = meta, meta
	flat := map[int]string{11: `{"prompt":"p11","cfg":7.5}`, 10: `null`}
	wrapped := map[int]string{11: `{"id":11,"meta":{"prompt":"p11","cfg":7.5}}`, 10: `{"id":10,"meta":null}`}
	none := map[int]string{11: `null`, 10: `null`}
	cases := []struct {
		f     *v1Fixture
		query string
		want  map[int]string // item id -> its `meta`, as written
	}{
		{feedPage, "withMeta=true", flat},
		{feedPage, "withMeta=true&flatMeta=false", wrapped},
		{legacy, "ids=10,11&withMeta=true", wrapped},
		{legacy, "ids=10,11&withMeta=true&flatMeta=true", flat},
		{legacy, "ids=10,11&withMeta=false&flatMeta=true", none},
	}
	for _, c := range cases {
		got, err := serveV1(t, c.f, c.query, nil)
		if err != nil {
			t.Fatalf("%s: %v", c.query, err)
		}
		var body struct {
			Items []struct {
				ID   int             `json:"id"`
				Meta json.RawMessage `json:"meta"`
			} `json:"items"`
		}
		if err := json.Unmarshal([]byte(got), &body); err != nil {
			t.Fatalf("%s: %v", c.query, err)
		}
		metas := map[int]string{}
		for _, it := range body.Items {
			metas[it.ID] = string(it.Meta)
		}
		if !reflect.DeepEqual(metas, c.want) {
			t.Errorf("%s: metas %v, want %v", c.query, metas, c.want)
		}
	}
	// The meta ids asked: the page's images with withMeta, none without.
	if got := feedPage.src.metaAsked; !reflect.DeepEqual(got, [][]int{{11, 10}, {11, 10}}) {
		t.Fatalf("feed meta asked %v", got)
	}
	if got := legacy.src.metaAsked; !reflect.DeepEqual(got, [][]int{{11, 10}, {11, 10}, nil}) {
		t.Fatalf("legacy meta asked %v", got)
	}
}

// AddonLevel is `onlySelectableLevels(level || public) || public`.
func TestAddonLevel(t *testing.T) {
	for in, want := range map[int]int{0: 1, 32: 1, 33: 1, 3: 3, 6: 6, 63: 31} {
		if got := AddonLevel(in); got != want {
			t.Errorf("AddonLevel(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestShapeV1CustomThumbnailServable(t *testing.T) {
	r := row(10, 100, "video", "vid-uuid", 1, `{"width":640,"height":360,"duration":12}`)
	for _, servable := range []bool{true, false} {
		it, err := ShapeV1Image(r, V1Hydrated{Thumb: hydrate.Thumbnail{URL: "thumb-uuid", NsfwLevel: 1, Servable: servable}, HasThumb: true}, browsing.PG, loc)
		if err != nil {
			t.Fatal(err)
		}
		thumb, _ := it.wire.Get("thumbnail")
		b, _ := superjson.Plain(thumb)
		if custom := strings.Contains(string(b), "thumb-uuid"); custom != servable {
			t.Errorf("servable %v: thumbnail %s", servable, b)
		}
	}
}

// The legacy-path shapes behind their own switches (V1Ports): off, each keeps the reason it had before
// its port, whatever the other switch says; on, it parses. `imageId=0` is falsy in runImageSearch (no
// legacy path) and present to the feed mapper (an empty page): not ported, under its own reason.
func TestParseV1Ports(t *testing.T) {
	both := V1Ports{ImageID: true, ModelOnly: true}
	cases := []struct {
		query string
		ports V1Ports
		want  string // fallback reason, "" = parsed
	}{
		{"imageId=5", V1Ports{}, "v1-image-id"},
		{"imageId=5", V1Ports{ModelOnly: true}, "v1-image-id"},
		{"imageId=5", V1Ports{ImageID: true}, ""},
		{"imageId=5&tags=1", V1Ports{ImageID: true}, "v1-tags"},
		{"imageId=0", both, "v1-image-id-zero"},
		{"imageId=", both, "v1-input-number"},
		{"imageId=0x10", both, "v1-input-number"},
		{"imageId=1&imageId=2", both, "v1-input-duplicate"},
		{"modelId=3", V1Ports{}, "v1-model-only"},
		{"modelId=3", V1Ports{ImageID: true}, "v1-model-only"},
		{"modelId=3", V1Ports{ModelOnly: true}, ""},
		{"modelId=3&modelVersionId=0", V1Ports{ModelOnly: true}, ""},
		{"ids=1&modelId=3", V1Ports{ModelOnly: true}, ""},
		{"imageId=5&modelId=3", V1Ports{ImageID: true}, "v1-model-only"},
		{"imageId=5&modelId=3", both, ""},
	}
	for _, c := range cases {
		_, err := ParseV1With(c.query, c.ports)
		if got := fallback.Reason(err); got != c.want || (c.want == "" && err != nil) {
			t.Errorf("%s %+v: reason %q (err %v), want %q", c.query, c.ports, got, err, c.want)
		}
	}
	in, err := ParseV1With("imageId=42&modelId=7&limit=3", both)
	if err != nil {
		t.Fatal(err)
	}
	if in.ImageID != 42 || in.ModelID != 7 || in.ModelVersionID != 0 || in.Limit != 3 || !in.Legacy() {
		t.Fatalf("parsed = %+v (legacy %v)", in, in.Legacy())
	}
	// useLegacyMethod: ids, a truthy imageId, or a truthy modelId without a truthy version.
	for q, want := range map[string]bool{
		"":                             false,
		"modelId=7&modelVersionId=9":   false,
		"modelVersionId=9":             false,
		"modelId=7":                    true,
		"modelId=7&modelVersionId=0":   true,
		"imageId=4&modelVersionId=9":   true,
		"ids=1&modelVersionId=9":       true,
		"modelId=0&modelVersionId=0":   false,
		"postId=3&modelVersionId=9":    false,
		"username=a&modelVersionId=99": false,
	} {
		in, err := ParseV1With(q, both)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if in.Legacy() != want {
			t.Errorf("%s: legacy %v, want %v", q, in.Legacy(), want)
		}
	}
}

// An `imageId` and a model without a version take the legacy path as an `ids` batch does: no feed
// call, getAllImages' own page with the image clause or the model scope, the look-ahead row's cursor
// column as a NUMBER nextCursor, the image's own createdAt.
func TestServeV1LegacyImageIDAndModelOnly(t *testing.T) {
	f := newV1Fixture(nil)
	rows := []RawImage{legacyRow(12, 101, 12), legacyRow(11, 101, 11)}
	f.deps.Rows = func(_ context.Context, q ImagesQuery) ([]RawImage, error) {
		f.hq = append(f.hq, q)
		return rows, nil
	}
	f.deps.Ports = V1Ports{ImageID: true, ModelOnly: true}
	got, err := serveV1(t, f, "imageId=12&limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"items":[` +
		`{"id":12,"url":"https://img.example/abc/u12/original=true/u12.jpeg","hash":"H","width":512,"height":768,` +
		`"nsfwLevel":"None","type":"image","nsfw":false,"browsingLevel":1,"createdAt":"2024-02-01T08:00:00.007Z","postId":101,` +
		`"thumbnail":null,"stats":{"cryCount":0,"laughCount":0,"likeCount":0,"dislikeCount":0,"heartCount":0,"commentCount":0},` +
		`"meta":null,"username":"alice","baseModel":null,"modelVersionIds":[]}],` +
		`"metadata":{"nextCursor":11,"nextPage":"https://civitai.example/api/v1/images?imageId=12&limit=1&cursor=11"}}`
	if got != want {
		t.Fatalf("imageId body:\n got %s\nwant %s", got, want)
	}
	if len(f.feed.queries) != 0 {
		t.Fatalf("the legacy path asked the feed: %v", f.feed.queries)
	}
	q := f.hq[0]
	if q.ImageID != 12 || q.IDs != nil || q.ModelID != 0 || q.ModelVersionID != 0 || q.Limit != 1 || q.Cursor != 0 ||
		q.Sort != SortMostReactions || q.PeriodMode != "published" || q.IndexOrder || q.BrowsingLevel != browsing.PG ||
		!reflect.DeepEqual(q.ExcludedTagIDs, []int{5}) || !q.DisablePoi || !q.DisableMinor || q.ThrowOnStatementTimeout {
		t.Fatalf("imageId query = %+v", q)
	}

	// A model without a version: the model scope, the request's sort and inclusive cursor.
	got, err = serveV1(t, f, "modelId=7&sort=Oldest&cursor=12&limit=1&browsingLevel=3", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `{"items":[{"id":12,`) ||
		!strings.HasSuffix(got, `"metadata":{"nextCursor":11,"nextPage":"https://civitai.example/api/v1/images?modelId=7&sort=Oldest&cursor=11&limit=1&browsingLevel=3"}}`) {
		t.Fatalf("modelId body: %s", got)
	}
	q = f.hq[1]
	if q.ModelID != 7 || q.ModelVersionID != 0 || q.ImageID != 0 || q.IDs != nil || q.Sort != SortOldest || q.Cursor != 12 ||
		q.BrowsingLevel != browsing.PG|browsing.PG13 || q.IndexOrder {
		t.Fatalf("modelId query = %+v", q)
	}
	// A model with a post is not a post's own media (`postId && !modelId`).
	if _, err := serveV1(t, f, "modelId=7&postId=100", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.hq[2]; q.IndexOrder || q.ModelID != 7 || q.PostID != 100 {
		t.Fatalf("modelId with postId query = %+v", q)
	}
	if !reflect.DeepEqual(f.trivial, []bool{false, false, false}) {
		t.Fatalf("trivial = %v", f.trivial)
	}

	// The model's gallery gates run first, as for a version: a taken-down model is the empty answer
	// without a query, and a held one narrows the level.
	f.gallery.withheld = map[int]bool{7: true}
	if got, err := serveV1(t, f, "modelId=7", nil); err != nil || got != `{"items":[],"metadata":{}}` || len(f.hq) != 3 {
		t.Fatalf("withheld model: %s %v, queries %d", got, err, len(f.hq))
	}
	f.gallery.withheld = nil
	held, sfw := browsing.PG, true
	f.gallery.settings = map[int]*GallerySettings{7: {SfwHeld: &sfw, Level: &held}}
	if _, err := serveV1(t, f, "modelId=7&browsingLevel=31", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.hq[3]; q.BrowsingLevel != browsing.PG || q.ModelID != 7 {
		t.Fatalf("held model query = %+v, want the level held to PG", q)
	}
	// An `imageId` alone names no model: no gate is read for it (its post's hold drops it after).
	f.gallery.withheld = map[int]bool{7: true}
	if _, err := serveV1(t, f, "imageId=12&browsingLevel=31", nil); err != nil {
		t.Fatal(err)
	}
	if q := f.hq[4]; q.BrowsingLevel != browsing.PG|browsing.PG13|browsing.R|browsing.X|browsing.XXX || q.ImageID != 12 {
		t.Fatalf("imageId query = %+v, want the requested level", q)
	}
}

// boundAt is the value bound to the first `<clause>$n` in b's SQL (nil, false: no such clause).
func boundAt(b Built, clause string) (any, bool) {
	m := regexp.MustCompile(regexp.QuoteMeta(clause) + `\$(\d+)`).FindStringSubmatch(b.SQL)
	if m == nil {
		return nil, false
	}
	n, _ := strconv.Atoi(m[1])
	return b.Args[n-1], true
}

// getAllImagesUncaptured's `imageId` clause (`i.id = <imageId>`, after the post clauses and before the
// excluded creators; personalized, so never cached, a model scope's cache included) and its
// `requiringMeta` clause (`i."blockedFor" = 'AiNotVerified'`, after the visibility gates).
func TestImagesQueryImageIDAndRequiringMeta(t *testing.T) {
	b := (&ImagesQuery{Limit: 5, ImageID: 42, PostID: 7, ExcludedUsers: []int{9}}).Build()
	if v, ok := boundAt(b, `i.id = `); !ok || v != 42 {
		t.Fatalf("image clause binds %v (%v): %s", v, ok, b.SQL)
	}
	post, img, excl := strings.Index(b.SQL, `i."postId" = $`), strings.Index(b.SQL, `i.id = $`), strings.Index(b.SQL, `i."userId" != ALL(`)
	if post < 0 || excl < 0 || !(post < img && img < excl) {
		t.Fatalf("clause order post %d, image %d, excluded %d: %s", post, img, excl, b.SQL)
	}
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("an image lookup is cached: %v %v", b.CacheTTL, b.CacheTags)
	}
	if b := (&ImagesQuery{Limit: 5}).Build(); strings.Contains(b.SQL, `i.id = $`) {
		t.Fatalf("no imageId, yet an image clause: %s", b.SQL)
	}
	// A model without a version alone is cached under its bust tag; with an image it is not.
	if m := (&ImagesQuery{Limit: 5, ModelID: 3}).Build(); m.CacheTTL != 10*time.Minute || !reflect.DeepEqual(m.CacheTags, []string{"images-model:3"}) {
		t.Fatalf("model scope cache %v %v", m.CacheTTL, m.CacheTags)
	}
	if m := (&ImagesQuery{Limit: 5, ModelID: 3, ImageID: 4}).Build(); m.CacheTTL != 0 || m.CacheTags != nil {
		t.Fatalf("model scope with an image cached: %v %v", m.CacheTTL, m.CacheTags)
	}

	r := (&ImagesQuery{Limit: 5, RequiringMeta: true}).Build()
	if v, ok := boundAt(r, `i."blockedFor" = `); !ok || v != "AiNotVerified" {
		t.Fatalf("requiringMeta clause binds %v (%v): %s", v, ok, r.SQL)
	}
	if gate, meta := strings.Index(r.SQL, hydrate.ImageReviewedSQL("i")), strings.Index(r.SQL, `i."blockedFor" = $`); gate < 0 || meta < gate {
		t.Fatalf("requiringMeta clause at %d, the reviewed gate at %d: the gates stay, before it", meta, gate)
	}
	if b := (&ImagesQuery{Limit: 5}).Build(); strings.Contains(b.SQL, `i."blockedFor" = $`) {
		t.Fatalf("no requiringMeta, yet its clause: %s", b.SQL)
	}
}
