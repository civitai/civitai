//go:build integration

package feed

// Integration tests against a real Postgres (testdata/integration/schema.sql) and a real Redis
// Cluster (see internal/integtest and .github/workflows/feed-go.yml). Expected values are literals
// written here, never values computed by the code under test.
//
// Ids in this file live in 2_100_000..2_199_999 (internal/hydrate's integration tests use 1_1xx_xxx).

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// integSeedImages resets the 2_101_xxx image fixture. Every column of image 2101001 holds a distinct,
// recognisable value, so a scan that swaps two columns shows up as a wrong field.
//
//	2101001 post 2101501 (owner 2101901, Unsearchable) video, poi, blockedFor set — the full-row image
//	2101002 post 2101501 owner 2101901          type image
//	2101003 post 2101501 user 2101902           tagged 2101801 (enabled)
//	2101004 post 2101501 user 2101902           minor
//	2101005 post 2101501 user 2101902           tagged 2101801 (disabled)
//	2101006 post 2101502 (user 2101902)         poi
//	2101007 post 2101504 (user 2101902)         blockedFor set
//	2101008 post 2101503 (user 2101902, Private)
//	2101009 post 2101504 (user 2101902)         txt2img
//
// Resources: 2101001 and 2101009 used version 2101601, 2101005 version 2101602; both versions belong
// to model 2101651. Every other image column passes every global filter of the image query, so a
// moderator sees all nine (the positive control for the filter tests).
func integSeedImages(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "Image" WHERE id BETWEEN 2101000 AND 2101999;
		DELETE FROM "Post" WHERE id BETWEEN 2101000 AND 2101999;
		DELETE FROM "TagsOnImageDetails" WHERE "imageId" BETWEEN 2101000 AND 2101999;
		DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2101000 AND 2101999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 2101000 AND 2101999;
		INSERT INTO "Post" (id, title, "userId", "modelVersionId", "model3dId", "publishedAt", metadata, availability) VALUES
		  (2101501, 'integ-post-title', 2101901, 2101601, 2101701, '2021-03-04 05:06:07.008', '{"unpublishedAt": "integ-unpublished-at"}', 'Unsearchable'),
		  (2101502, NULL, 2101902, NULL, NULL, '2021-02-01 00:00:00', NULL, 'Public'),
		  (2101503, NULL, 2101902, NULL, NULL, '2021-02-01 00:00:00', NULL, 'Private'),
		  (2101504, NULL, 2101902, NULL, NULL, '2021-02-01 00:00:00', NULL, 'Public');
		INSERT INTO "Image" (id, name, url, "userId", "createdAt", meta, hash, height, width, type, metadata, "nsfwLevel",
		    "postId", "needsReview", "hideMeta", index, "scannedAt", "mimeType", ingestion, "blockedFor", minor, poi, "acceptableMinor")
		  VALUES (2101001, 'integ-name', 'integ-url', 2101901, '2021-01-02 03:04:05.006',
		    '{"civitaiResources": [], "extra": {"remixOfId": 2101077}}', 'integ-hash', 853, 641, 'video',
		    '{"integKey": "integ-metadata"}', 2, 2101501, NULL, false, 7, '2021-05-06 07:08:09.010', 'integ/mime',
		    'Scanned', 'integ-blocked-for', false, true, false);
		INSERT INTO "Image" (id, url, "userId", type, "nsfwLevel", "postId", ingestion, minor, poi, "blockedFor", "generationProcess") VALUES
		  (2101002, 'integ-u2', 2101901, 'image', 2, 2101501, 'Scanned', false, false, NULL, NULL),
		  (2101003, 'integ-u3', 2101902, 'video', 2, 2101501, 'Scanned', false, false, NULL, NULL),
		  (2101004, 'integ-u4', 2101902, 'video', 2, 2101501, 'Scanned', true, false, NULL, NULL),
		  (2101005, 'integ-u5', 2101902, 'video', 2, 2101501, 'Scanned', false, false, NULL, NULL),
		  (2101006, 'integ-u6', 2101902, 'video', 2, 2101502, 'Scanned', false, true, NULL, NULL),
		  (2101007, 'integ-u7', 2101902, 'video', 2, 2101504, 'Scanned', false, false, 'integ-other-blocked', NULL),
		  (2101008, 'integ-u8', 2101902, 'video', 2, 2101503, 'Scanned', false, false, NULL, NULL),
		  (2101009, 'integ-u9', 2101902, 'video', 2, 2101504, 'Scanned', false, false, NULL, 'txt2img');
		INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", disabled) VALUES (2101003, 2101801, false), (2101005, 2101801, true);
		INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES (2101001, 2101601), (2101009, 2101601), (2101005, 2101602);
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (2101601, 2101651), (2101602, 2101651);`)
}

var integAllIDs = []int{2101001, 2101002, 2101003, 2101004, 2101005, 2101006, 2101007, 2101008, 2101009}

func integRun(t *testing.T, pool *pgxpool.Pool, q ImagesQuery) []RawImage {
	t.Helper()
	b := q.Build()
	rows, err := pool.Query(integtest.Ctx(t), b.SQL, b.Args...)
	if err != nil {
		t.Fatalf("query: %v\n%s", err, b.SQL)
	}
	out, err := scanRows(rows, b.Collection)
	if err != nil {
		t.Fatalf("scan: %v\n%s", err, b.SQL)
	}
	return out
}

func integIDs(rows []RawImage) []int {
	out := make([]int, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

func integTime(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04:05.000", s)
	if err != nil {
		panic(err)
	}
	return t
}

func integS(s string) *string { return &s }
func integI(n int) *int       { return &n }
func integB(b bool) *bool     { return &b }

func integTimeP(s string) *time.Time { t := integTime(s); return &t }

// integWantRow compares every field through its JSON form (RawMessage compacted, times as RFC 3339 in
// UTC) and names each field that differs.
func integWantRow(t *testing.T, got, want RawImage) {
	t.Helper()
	asMap := func(r RawImage) map[string]any {
		r.CreatedAt, r.SortAt = r.CreatedAt.UTC(), r.SortAt.UTC()
		for _, p := range []**time.Time{&r.ScannedAt, &r.PublishedAt} {
			if *p != nil {
				u := (*p).UTC()
				*p = &u
			}
		}
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatalf("marshal %+v: %v", r, err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	g, w := asMap(got), asMap(want)
	var diffs []string
	for k, wv := range w {
		if !reflect.DeepEqual(g[k], wv) {
			diffs = append(diffs, fmt.Sprintf("%s: got %v, want %v", k, g[k], wv))
		}
	}
	sort.Strings(diffs)
	if len(diffs) > 0 {
		t.Fatalf("row %d differs in %d field(s):\n%v", want.ID, len(diffs), diffs)
	}
}

// integFullRow is image 2101001 as the SELECT must return it.
var integFullRow = RawImage{
	ID: 2101001, Name: integS("integ-name"), URL: integS("integ-url"), NsfwLevel: 2, Width: integI(641), Height: integI(853),
	Hash: integS("integ-hash"), HideMeta: false, HasMeta: true, HasPositivePrompt: false, OnSite: integB(true),
	RemixOfID: json.RawMessage(`2101077`), CreatedAt: integTime("2021-01-02 03:04:05.006"),
	SortAt: integTime("2021-05-06 07:08:09.010"), MimeType: integS("integ/mime"), Type: "video",
	Metadata: json.RawMessage(`{"integKey":"integ-metadata"}`), Ingestion: "Scanned", BlockedFor: integS("integ-blocked-for"),
	ScannedAt: integTimeP("2021-05-06 07:08:09.010"), NeedsReview: nil, UserID: 2101901, PostID: 2101501,
	PostTitle: integS("integ-post-title"), Index: integI(7), PublishedAt: integTimeP("2021-03-04 05:06:07.008"),
	UnpublishedAt: integS("integ-unpublished-at"), ModelVersionID: integI(2101601), Model3DID: integI(2101701),
	Availability: "Unsearchable", Minor: false, Poi: true, AcceptableMinor: false, CursorID: 2101001,
}

func TestIntegrationScanRowsColumnOrder(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)

	rows := integRun(t, pool, ImagesQuery{IDs: []int{2101001}, Limit: 5, IsModerator: true, BrowsingLevel: browsing.AllLevels})
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	integWantRow(t, rows[0], integFullRow)

	// The same row through the model-version gallery shape (FROM "ImageResourceNew", cursor irr.imageId).
	rows = integRun(t, pool, ImagesQuery{ModelVersionID: 2101601, IDs: []int{2101001}, Limit: 5, IsModerator: true, BrowsingLevel: browsing.AllLevels})
	if len(rows) != 1 {
		t.Fatalf("model-version shape: got %d rows, want 1", len(rows))
	}
	integWantRow(t, rows[0], integFullRow)

	// And through the public endpoint's hydrate shape (feedHydrateQuery: the viewer is the owner).
	rows = integRun(t, pool, ImagesQuery{
		IDs: []int{2101001}, Limit: 1, Sort: SortMostReactions, Period: "AllTime", PeriodMode: "published",
		BrowsingLevel: browsing.AllLevels, Types: []string{"video"}, DisablePoi: true, DisableMinor: true,
		ExcludedTagIDs: []int{2101801}, ViewerID: 2101901, PostID: 2101501, TargetUserID: 2101901, ThrowOnStatementTimeout: true,
	})
	if len(rows) != 1 {
		t.Fatalf("hydrate shape: got %d rows, want 1", len(rows))
	}
	integWantRow(t, rows[0], integFullRow)
}

func TestIntegrationImagesQueryFilters(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	all := ImagesQuery{IDs: integAllIDs, Limit: 20, BrowsingLevel: browsing.AllLevels}

	mod := all
	mod.IsModerator = true
	if got, want := integIDs(integRun(t, pool, mod)), []int{2101009, 2101008, 2101007, 2101006, 2101005, 2101004, 2101003, 2101002, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("moderator (positive control) = %v, want %v", got, want)
	}

	filtered := all
	filtered.Types = []string{"video"}
	filtered.DisablePoi, filtered.DisableMinor = true, true
	filtered.ExcludedTagIDs = []int{2101801, 2101801}
	filtered.ViewerID = 2101901
	if got, want := integIDs(integRun(t, pool, filtered)), []int{2101009, 2101005, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("owner with every filter = %v, want %v", got, want)
	}

	signedOut := filtered
	signedOut.ViewerID = 0 // the viewer binds as NULL::int: no owner carve-out matches
	if got, want := integIDs(integRun(t, pool, signedOut)), []int{2101009, 2101005}; !reflect.DeepEqual(got, want) {
		t.Fatalf("signed out = %v, want %v", got, want)
	}

	creator := filtered
	creator.TargetUserID, creator.PostID = 2101901, 2101501
	b := creator.Build()
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("a creator query is personalized: CacheTTL %v tags %v, want 0 / nil", b.CacheTTL, b.CacheTags)
	}
	if got, want := integIDs(integRun(t, pool, creator)), []int{2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("creator + post = %v, want %v", got, want)
	}

	excludedUsers := mod
	excludedUsers.ExcludedUsers = []int{2101902}
	if got, want := integIDs(integRun(t, pool, excludedUsers)), []int{2101002, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("excluded users = %v, want %v", got, want)
	}

	posts := mod
	posts.PostIDs = []int{2101502, 2101503}
	if got, want := integIDs(integRun(t, pool, posts)), []int{2101008, 2101006}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post ids = %v, want %v", got, want)
	}

	limited := mod
	limited.Limit = 1 // LIMIT limit+1: the look-ahead row
	if got, want := integIDs(integRun(t, pool, limited)), []int{2101009, 2101008}; !reflect.DeepEqual(got, want) {
		t.Fatalf("limit 1 = %v, want %v", got, want)
	}
}

// The REST endpoint's `ids` batch (the legacy path): the ids' own order whatever the request's, a
// repeated id once, OFFSET before the look-ahead LIMIT (`page`), and the inclusive id cursor.
func TestIntegrationLegacyIDsPaging(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	q := ImagesQuery{IDs: []int{2101003, 2101009, 2101001, 2101009, 2101005, 2101999}, Limit: 2, IsModerator: true, BrowsingLevel: browsing.AllLevels}
	if got, want := integIDs(integRun(t, pool, q)), []int{2101009, 2101005, 2101003}; !reflect.DeepEqual(got, want) {
		t.Fatalf("first page = %v, want %v (by id descending, the look-ahead row last)", got, want)
	}
	skipped := q
	skipped.Skip = 2
	if b := skipped.Build(); !strings.Contains(b.SQL, "OFFSET 2\n    LIMIT $") {
		t.Fatalf("OFFSET not before LIMIT:\n%s", b.SQL)
	}
	if got, want := integIDs(integRun(t, pool, skipped)), []int{2101003, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("page 2 = %v, want %v", got, want)
	}
	cursor := q
	cursor.Cursor = 2101005
	if got, want := integIDs(integRun(t, pool, cursor)), []int{2101005, 2101003, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("from the cursor = %v, want %v", got, want)
	}
}

// image.getInfinite's scopes against the real schema: the tag subquery (an enabled tag only) and a
// post's media in index order, paged on the nullable index (Postgres sorts NULL last ascending).
func TestIntegrationInfiniteScopes(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	mod := ImagesQuery{Limit: 20, IsModerator: true, BrowsingLevel: browsing.AllLevels, Sort: SortNewest}

	tagged := mod
	tagged.TagIDs = []int{2101801}
	if got, want := integIDs(integRun(t, pool, tagged)), []int{2101003}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tag scope = %v, want %v (2101005's tag is disabled)", got, want)
	}
	tagged.TagIDs = []int{2101899}
	if got := integIDs(integRun(t, pool, tagged)); len(got) != 0 {
		t.Fatalf("an unused tag = %v, want none", got)
	}

	post := mod
	post.PostID, post.IndexOrder = 2101501, true
	rows := integRun(t, pool, post)
	if got, want := integIDs(rows), []int{2101001, 2101002, 2101003, 2101004, 2101005}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post in index order = %v, want %v", got, want)
	}
	if rows[0].CursorNull || rows[0].CursorID != 7 || !rows[1].CursorNull || rows[1].CursorID != 0 {
		t.Fatalf("cursor columns = (%d, null %v), (%d, null %v); want the index 7, then NULL",
			rows[0].CursorID, rows[0].CursorNull, rows[1].CursorID, rows[1].CursorNull)
	}
	post.Cursor = 7 // inclusive on the index
	if got, want := integIDs(integRun(t, pool, post)), []int{2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post from index 7 = %v, want %v", got, want)
	}
}

// getAllImages' `tools` clause against the real schema: an image holding EVERY listed tool (order
// and repeats in the list do not matter), never one with no tool row, and the cache policy of the
// query it joins unchanged. Tool ids live in 2_102_0xx.
func TestIntegrationToolsFilter(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	integtest.Exec(t, pool, `
		DELETE FROM "ImageTool" WHERE "imageId" BETWEEN 2101000 AND 2101999;
		INSERT INTO "ImageTool" ("imageId", "toolId") VALUES
		  (2101001, 2102001), (2101001, 2102002),
		  (2101002, 2102002),
		  (2101003, 2102003), (2101003, 2102002), (2101003, 2102001),
		  (2101009, 2102004);`)
	mod := ImagesQuery{IDs: integAllIDs, Limit: 20, IsModerator: true, BrowsingLevel: browsing.AllLevels}
	for _, c := range []struct {
		name  string
		tools []int
		want  []int
	}{
		// Positive control: without the filter the moderator sees all nine.
		{"no tools", nil, []int{2101009, 2101008, 2101007, 2101006, 2101005, 2101004, 2101003, 2101002, 2101001}},
		{"one tool", []int{2102002}, []int{2101003, 2101002, 2101001}},
		{"all of two", []int{2102001, 2102002}, []int{2101003, 2101001}},
		{"all of three, out of order", []int{2102003, 2102001, 2102002}, []int{2101003}},
		{"a repeated tool", []int{2102002, 2102002}, []int{2101003, 2101002, 2101001}},
		{"a tool and one nobody holds with it", []int{2102004, 2102001}, []int{}},
		{"a zero id (bound as sent)", []int{0}, []int{}},
	} {
		q := mod
		q.Tools = c.tools
		if got := integIDs(integRun(t, pool, q)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	// On a version gallery the query stays cached under the version's tag.
	version := ImagesQuery{ModelVersionID: 2101601, Limit: 20, IsModerator: true, BrowsingLevel: browsing.AllLevels, Tools: []int{2102001}}
	if b := version.Build(); b.CacheTTL != 10*time.Minute || !reflect.DeepEqual(b.CacheTags, []string{"images-modelVersion:2101601"}) {
		t.Fatalf("version gallery with tools: CacheTTL %v tags %v, want 10m / [images-modelVersion:2101601]", b.CacheTTL, b.CacheTags)
	}
	if got, want := integIDs(integRun(t, pool, version)), []int{2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("version gallery with tools = %v, want %v (2101009 used the version but holds another tool)", got, want)
	}
}

func TestIntegrationImagesQueryModelScopes(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	base := ImagesQuery{Limit: 20, IsModerator: true, BrowsingLevel: browsing.AllLevels}

	version := base
	version.ModelVersionID = 2101601
	b := version.Build()
	if b.CacheTTL != 10*time.Minute || !reflect.DeepEqual(b.CacheTags, []string{"images-modelVersion:2101601"}) {
		t.Fatalf("version scope caching: %v %v", b.CacheTTL, b.CacheTags)
	}
	rows := integRun(t, pool, version)
	if got, want := integIDs(rows), []int{2101009, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("model version = %v, want %v", got, want)
	}
	for _, r := range rows {
		if r.CursorID != r.ID {
			t.Fatalf("cursorId %d for image %d: want irr.imageId", r.CursorID, r.ID)
		}
	}

	model := base
	model.ModelID = 2101651
	if got, want := integIDs(integRun(t, pool, model)), []int{2101009, 2101005, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("model = %v, want %v", got, want)
	}

	oldest := model
	oldest.Sort, oldest.Cursor = SortOldest, 2101005
	if got, want := integIDs(integRun(t, pool, oldest)), []int{2101005, 2101009}; !reflect.DeepEqual(got, want) {
		t.Fatalf("oldest from cursor 2101005 = %v, want %v", got, want)
	}

	newestCursor := base
	newestCursor.IDs, newestCursor.Cursor = integAllIDs, 2101003
	if got, want := integIDs(integRun(t, pool, newestCursor)), []int{2101003, 2101002, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("newest from cursor 2101003 = %v, want %v", got, want)
	}

	week := base
	week.IDs, week.Period = []int{2101001, 2101009}, "Week" // 2101001 was created in 2021, 2101009 now
	if got, want := integIDs(integRun(t, pool, week)), []int{2101009}; !reflect.DeepEqual(got, want) {
		t.Fatalf("period Week = %v, want %v", got, want)
	}

	gen := base
	gen.IDs, gen.Generation = integAllIDs, []string{"txt2img", "img2img"}
	if got, want := integIDs(integRun(t, pool, gen)), []int{2101009}; !reflect.DeepEqual(got, want) {
		t.Fatalf("generation = %v, want %v", got, want)
	}

	m3d := base
	m3d.Model3DID = 2101701
	if got, want := integIDs(integRun(t, pool, m3d)), []int{2101005, 2101004, 2101003, 2101002, 2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("model3d = %v, want %v", got, want)
	}

	withMeta := base
	withMeta.IDs, withMeta.WithMeta = integAllIDs, true
	if got, want := integIDs(integRun(t, pool, withMeta)), []int{2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("withMeta = %v, want %v", got, want)
	}
	fromPlatform := withMeta
	fromPlatform.WithMeta, fromPlatform.FromPlatform = false, true
	if got, want := integIDs(integRun(t, pool, fromPlatform)), []int{2101001}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fromPlatform = %v, want %v", got, want)
	}
}

func TestIntegrationPostImageCounts(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	got, err := PostImageCounts(integtest.Ctx(t), pool, []int{2101501, 2101504, 2101599})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[int]int{2101501: 5, 2101504: 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("counts = %v, want %v", got, want)
	}
}

// integCacheQuery is a cached page query (a model version and a 3D model scope: two bust tags) whose
// only row is 2101001.
func integCacheQuery() Built {
	return (&ImagesQuery{ModelVersionID: 2101601, Model3DID: 2101701, Limit: 10, IsModerator: true, BrowsingLevel: browsing.AllLevels}).Build()
}

func TestIntegrationFetchRowsCachesInCluster(t *testing.T) {
	pool := integtest.Postgres(t)
	c := integtest.Cluster(t)
	integSeedImages(t, pool)
	ctx := integtest.Ctx(t)
	cache := &QueryCache{Redis: c, Prefix: integtest.Prefix(t), Enabled: true}
	b := integCacheQuery()
	if want := []string{"images-modelVersion:2101601", "images-model3d:2101701"}; b.CacheTTL != 10*time.Minute || !reflect.DeepEqual(b.CacheTags, want) {
		t.Fatalf("caching policy = %v %v, want 10m %v", b.CacheTTL, b.CacheTags, want)
	}
	key := cache.Key(b)
	tagKeys := []string{cache.Prefix + "tag:images-modelVersion:2101601", cache.Prefix + "tag:images-model3d:2101701"}
	integtest.Del(t, c, append([]string{key}, tagKeys...)...)

	rows, err := FetchRows(ctx, pool, cache, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != 2101001 || *rows[0].Name != "integ-name" {
		t.Fatalf("miss = %+v, want image 2101001 named integ-name", rows)
	}

	ttl, err := c.TTL(ctx, key).Result()
	if err != nil || ttl <= 9*time.Minute || ttl > 10*time.Minute {
		t.Fatalf("entry TTL = %v, %v; want (9m, 10m]", ttl, err)
	}
	slots := map[int64]bool{}
	for _, k := range append([]string{key}, tagKeys...) {
		slot, err := c.ClusterKeySlot(ctx, k).Result()
		if err != nil {
			t.Fatal(err)
		}
		slots[slot] = true
	}
	if len(slots) < 2 {
		t.Fatalf("entry and tag sets share one slot; the write is not cross-slot")
	}
	for _, tk := range tagKeys {
		members, err := c.SMembers(ctx, tk).Result()
		if err != nil || !reflect.DeepEqual(members, []string{key}) {
			t.Fatalf("SMEMBERS %s = %v, %v; want [%s]", tk, members, err, key)
		}
	}

	// A hit is served from Redis: a change in Postgres is not seen until the entry goes.
	integtest.Exec(t, pool, `UPDATE "Image" SET name = 'integ-renamed' WHERE id = 2101001`)
	rows, err = FetchRows(ctx, pool, cache, b)
	if err != nil || len(rows) != 1 || *rows[0].Name != "integ-name" {
		t.Fatalf("hit = %+v, %v; want the cached integ-name", rows, err)
	}
	integWantRow(t, rows[0], integFullRow) // the JSON round trip through Redis keeps every field

	if err := c.Set(ctx, key, "not json", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	rows, err = FetchRows(ctx, pool, cache, b)
	if err != nil || len(rows) != 1 || *rows[0].Name != "integ-renamed" {
		t.Fatalf("after an undecodable entry = %+v, %v; want the database's integ-renamed", rows, err)
	}
	raw, err := c.Get(ctx, key).Bytes()
	if err != nil {
		t.Fatal(err)
	}
	var cached []RawImage
	if err := json.Unmarshal(raw, &cached); err != nil || len(cached) != 1 || *cached[0].Name != "integ-renamed" {
		t.Fatalf("rewritten entry = %s (%v); want the integ-renamed row", raw, err)
	}
}

func TestIntegrationFetchRowsCacheOff(t *testing.T) {
	pool := integtest.Postgres(t)
	c := integtest.Cluster(t)
	integSeedImages(t, pool)
	ctx := integtest.Ctx(t)
	prefix := integtest.Prefix(t)

	off := &QueryCache{Redis: c, Prefix: prefix, Enabled: false}
	b := integCacheQuery()
	uncached := (&ImagesQuery{IDs: []int{2101001}, Limit: 1, IsModerator: true, BrowsingLevel: browsing.AllLevels}).Build()
	on := &QueryCache{Redis: c, Prefix: prefix, Enabled: true}
	keys := []string{off.Key(b), on.Key(uncached), prefix + "tag:images-modelVersion:2101601", prefix + "tag:images-model3d:2101701"}
	integtest.Del(t, c, keys...)

	for _, run := range []struct {
		cache *QueryCache
		b     Built
	}{{off, b}, {on, uncached}} {
		rows, err := FetchRows(ctx, pool, run.cache, run.b)
		if err != nil || len(rows) != 1 || rows[0].ID != 2101001 {
			t.Fatalf("rows = %+v, %v; want image 2101001", rows, err)
		}
	}
	for _, k := range keys { // one EXISTS per key: a multi-key EXISTS across slots is a CROSSSLOT error
		n, err := c.Exists(ctx, k).Result()
		if err != nil || n != 0 {
			t.Fatalf("EXISTS %s = %d, %v: a disabled cache, or an uncached query, wrote", k, n, err)
		}
	}
}

func integGallery(t *testing.T) (*GalleryStore, *redis.ClusterClient, *pgxpool.Pool) {
	t.Helper()
	c := integtest.Cluster(t)
	pool := integtest.Postgres(t)
	return &GalleryStore{Cache: c, Prefix: integtest.Prefix(t), DB: pool}, c, pool
}

func TestIntegrationGallerySettings(t *testing.T) {
	g, c, _ := integGallery(t)
	ctx := integtest.Ctx(t)
	values := map[int]string{
		2102001: `{"level":3,"sfwHeld":true,"pinnedPosts":{"2102501":[2102601,2102602]},"users":[]}`,
		2102002: `{"none":true}`,
		2102003: `{"level":5}`,
		2102005: `null`,
		2102006: `{"sfwHeld":false,"pinnedPosts":{}}`,
	}
	keys := make([]string, 0, len(values))
	for id := range values {
		keys = append(keys, g.Prefix+"model:gallery-settings:"+strconv.Itoa(id))
	}
	integtest.Del(t, c, keys...)
	for id, v := range values {
		if err := c.Set(ctx, g.Prefix+"model:gallery-settings:"+strconv.Itoa(id), v, 0).Err(); err != nil {
			t.Fatal(err)
		}
	}

	s, err := g.Settings(ctx, 2102001)
	if err != nil || s == nil {
		t.Fatalf("2102001 = %+v, %v", s, err)
	}
	if lvl, held := s.HeldLevel(); lvl != 3 || !held {
		t.Fatalf("held level = %d, %v; want 3, true", lvl, held)
	}
	if pins := s.PinnedFor(2102501); !reflect.DeepEqual(pins, []int{2102601, 2102602}) {
		t.Fatalf("pinned = %v", pins)
	}
	if s, err := g.Settings(ctx, 2102002); s != nil || err != nil {
		t.Fatalf("none = %+v, %v; want nil, nil", s, err)
	}
	for id, reason := range map[int]string{2102003: "gallery-settings-stale", 2102004: "gallery-settings-miss", 2102005: "gallery-settings-stale"} {
		_, err := g.Settings(ctx, id)
		if got := fallback.Reason(err); got != reason {
			t.Fatalf("%d: err %v (reason %q), want %q", id, err, got, reason)
		}
	}

	many, err := g.SettingsMany(ctx, []int{2102001, 2102002, 2102006})
	if err != nil {
		t.Fatal(err)
	}
	if len(many) != 3 || many[2102002] != nil {
		t.Fatalf("many = %+v", many)
	}
	if lvl, held := many[2102001].HeldLevel(); lvl != 3 || !held {
		t.Fatalf("many 2102001 held = %d, %v", lvl, held)
	}
	if _, held := many[2102006].HeldLevel(); held {
		t.Fatal("many 2102006 must not be held")
	}
	_, err = g.SettingsMany(ctx, []int{2102001, 2102004})
	if got := fallback.Reason(err); got != "gallery-settings-miss" {
		t.Fatalf("many with a miss: err %v (reason %q)", err, got)
	}
}

func TestIntegrationGalleryVersionModelAndWithheld(t *testing.T) {
	g, _, pool := integGallery(t)
	integtest.Exec(t, pool, `DELETE FROM "ModelVersion" WHERE id BETWEEN 2102700 AND 2102799;
		DELETE FROM "Model" WHERE id BETWEEN 2102800 AND 2102899;
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (2102701, 2102801);
		INSERT INTO "Model" (id, "userId", mode) VALUES (2102801, 2102901, 'TakenDown'), (2102802, 2102902, NULL), (2102803, 2102903, 'Archived');`)
	ctx := integtest.Ctx(t)

	if m, err := g.VersionModel(ctx, 2102701); err != nil || m != 2102801 {
		t.Fatalf("version model = %d, %v; want 2102801", m, err)
	}
	if m, err := g.VersionModel(ctx, 2102799); err != nil || m != 0 {
		t.Fatalf("unknown version = %d, %v; want 0", m, err)
	}
	cases := []struct {
		models []int
		viewer int
		want   bool
	}{
		{[]int{2102801}, 0, true},
		{[]int{2102801}, 2102901, false}, // the owner
		{[]int{2102802, 2102803}, 0, false},
		{[]int{2102803, 2102801}, 2102902, true},
		{nil, 0, false},
	}
	for _, c := range cases {
		got, err := g.Withheld(ctx, c.models, c.viewer)
		if err != nil || got != c.want {
			t.Fatalf("withheld(%v, %d) = %v, %v; want %v", c.models, c.viewer, got, err, c.want)
		}
	}
}

func TestIntegrationGalleryReviews(t *testing.T) {
	g, _, pool := integGallery(t)
	integtest.Exec(t, pool, `DELETE FROM "ResourceReview" WHERE id BETWEEN 2103000 AND 2103999;
		DELETE FROM "Post" WHERE id BETWEEN 2103000 AND 2103999;
		INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (2103501, 2103901, '2021-01-01 00:00:00'), (2103502, 2103902, NULL);
		INSERT INTO "ResourceReview" (id, "modelId", "modelVersionId", rating, recommended, details, "userId", "postId") VALUES
		  (2103201, 2103001, 2103101, 3, true, 'integ-ok', 2103901, NULL),
		  (2103202, 2103001, 2103101, 5, false, NULL, 2103901, 2103501),
		  (2103203, 2103001, 2103101, 4, true, 'integ-unpublished', 2103902, 2103502),
		  (2103204, 2103001, 2103102, 2, true, 'integ-other-version', 2103903, NULL),
		  (2103205, 2103002, 2103101, 1, true, 'integ-other-model', 2103904, NULL);`)
	ctx := integtest.Ctx(t)
	users := []int{2103901, 2103902, 2103903, 2103904}

	got, err := g.Reviews(ctx, users, 2103001, 2103101, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]Review{2103901: {Rating: 5, Details: nil, Recommended: false, ID: 2103202}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("signed out = %+v, want %+v", got, want)
	}

	got, err = g.Reviews(ctx, users, 2103001, 2103101, 2103902)
	if err != nil {
		t.Fatal(err)
	}
	want[2103902] = Review{Rating: 4, Details: integS("integ-unpublished"), Recommended: true, ID: 2103203}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("viewer 2103902 (own unpublished review) = %+v, want %+v", got, want)
	}

	got, err = g.Reviews(ctx, users, 2103001, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	want = map[int]Review{
		2103901: {Rating: 5, Details: nil, Recommended: false, ID: 2103202},
		2103903: {Rating: 2, Details: integS("integ-other-version"), Recommended: true, ID: 2103204},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("model scope = %+v, want %+v", got, want)
	}
}

func TestIntegrationGalleryPromotions(t *testing.T) {
	g, _, pool := integGallery(t)
	now := time.Now()
	ts := func(d time.Duration) string { return now.Add(d).UTC().Format("2006-01-02 15:04:05.000") }
	const live = `{"postId": 2104501, "days": 3, "modelVersionIds": [2104201], "imageIds": [2104601, 2104602]}`
	integtest.Exec(t, pool, `DELETE FROM "Placement" WHERE id BETWEEN 2104000 AND 2104999;
		DELETE FROM "Model" WHERE id BETWEEN 2104000 AND 2104999;
		INSERT INTO "Model" (id, "userId", minor, "sfwOnly", "gallerySettings") VALUES
		  (2104001, 2104901, false, false, '{"level": 6, "users": []}'),
		  (2104002, 2104902, true, true, '{"users": []}');`)
	integtest.Exec(t, pool, fmt.Sprintf(`INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, "resolvedAt", data) VALUES
		  (2104101, 'galleryPromotion', 'model', 2104001, 'approved', '%[1]s', '%[3]s'),
		  (2104102, 'galleryPromotion', 'model', 2104001, 'approved', '%[2]s', '%[3]s'),
		  (2104103, 'galleryPromotion', 'model', 2104001, 'pending', '%[1]s', '%[3]s'),
		  (2104104, 'otherSurface', 'model', 2104001, 'approved', '%[1]s', '%[3]s'),
		  (2104105, 'galleryPromotion', 'model', 2104002, 'approved', '%[1]s', '%[3]s'),
		  (2104106, 'galleryPromotion', 'user', 2104001, 'approved', '%[1]s', '%[3]s');`,
		ts(-24*time.Hour), ts(-8*24*time.Hour), live))
	ctx := integtest.Ctx(t)

	rows, err := g.LiveGalleryPromotions(ctx, 2104001, now.Add(-maxRun))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != 2104101 {
		t.Fatalf("live rows = %+v, want only placement 2104101", rows)
	}
	if rows[0].ResolvedAt == nil || rows[0].ResolvedAt.Sub(now.Add(-24*time.Hour)).Abs() > time.Second {
		t.Fatalf("resolvedAt = %v, want ~%v (bound and read as UTC wall clock)", rows[0].ResolvedAt, now.Add(-24*time.Hour).UTC())
	}
	var gotData, wantData any
	if json.Unmarshal(rows[0].Data, &gotData) != nil || json.Unmarshal([]byte(live), &wantData) != nil || !reflect.DeepEqual(gotData, wantData) {
		t.Fatalf("data = %s, want %s", rows[0].Data, live)
	}

	m, err := g.PromotionModel(ctx, 2104001)
	if err != nil || m == nil || m.Minor || m.SfwOnly || string(m.GalleryLevel) != "6" {
		t.Fatalf("promotion model 2104001 = %+v, %v; want level 6, not minor, not sfwOnly", m, err)
	}
	m, err = g.PromotionModel(ctx, 2104002)
	if err != nil || m == nil || !m.Minor || !m.SfwOnly || m.GalleryLevel != nil {
		t.Fatalf("promotion model 2104002 = %+v, %v; want minor, sfwOnly, no level", m, err)
	}
	if m, err := g.PromotionModel(ctx, 2104099); err != nil || m != nil {
		t.Fatalf("unknown model = %+v, %v; want nil, nil", m, err)
	}

	pick, err := SponsoredGalleryPost(ctx, g, 2104001, 2104201, now)
	if err != nil {
		t.Fatal(err)
	}
	want := &SponsoredPick{PlacementID: 2104101, PostID: 2104501, ImageIDs: []int{2104601, 2104602}, ServingLevel: 6}
	if !reflect.DeepEqual(pick, want) {
		t.Fatalf("sponsored = %+v, want %+v", pick, want)
	}
	if pick, err := SponsoredGalleryPost(ctx, g, 2104001, 2104299, now); err != nil || pick != nil {
		t.Fatalf("other version = %+v, %v; want nil", pick, err)
	}
}

func TestIntegrationGalleryImageResources(t *testing.T) {
	g, _, pool := integGallery(t)
	integtest.Exec(t, pool, `DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2105000 AND 2105999;
		INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES (2105001, 2105101), (2105001, 2105102), (2105002, 2105103);`)
	got, err := g.ImageResources(integtest.Ctx(t), []int{2105001, 2105002, 2105003})
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range got {
		sort.Ints(v) // no ORDER BY
	}
	if want := map[int][]int{2105001: {2105101, 2105102}, 2105002: {2105103}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("resources = %v, want %v", got, want)
	}
}

func TestIntegrationAddonSource(t *testing.T) {
	c := integtest.Cluster(t)
	ctx := integtest.Ctx(t)
	const key = "system:browsing-setting-addons"
	integtest.Del(t, c, key)
	a := &AddonSource{Sys: c}

	if got := a.Addons(ctx); !reflect.DeepEqual(got, browsing.DefaultAddons) {
		t.Fatalf("absent key = %+v, want the defaults", got)
	}

	if err := c.Set(ctx, key, `[{"type":"some","nsfwLevels":[4,8],"disableMinor":true,"excludedTagIds":[2106001,2106002]},{"type":"none","nsfwLevels":[16],"scope":"newCreators"}]`, 0).Err(); err != nil {
		t.Fatal(err)
	}
	yes := true
	want := []browsing.Addon{
		{Type: "some", NsfwLevels: []int{4, 8}, DisableMinor: &yes, ExcludedTagIDs: []int{2106001, 2106002}},
		{Type: "none", NsfwLevels: []int{16}, Scope: "newCreators"},
	}
	if got := a.Addons(ctx); !reflect.DeepEqual(got, want) {
		t.Fatalf("valid = %+v, want %+v", got, want)
	}

	for _, bad := range []string{"not json", "null", `{"type":"some"}`} {
		if err := c.Set(ctx, key, bad, 0).Err(); err != nil {
			t.Fatal(err)
		}
		if got := a.Addons(ctx); !reflect.DeepEqual(got, browsing.DefaultAddons) {
			t.Fatalf("%q = %+v, want the defaults", bad, got)
		}
	}
}
