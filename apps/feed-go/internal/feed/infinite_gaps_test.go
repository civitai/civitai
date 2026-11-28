package feed

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// image.getInfinite's `ids`, `reactions`, `newCreators` and the system user alone in
// `prioritizedUserIds`. Expected values are literals read from getInfiniteImagesSchema,
// requiresImageDbPath, getAllImagesUncaptured and the handler's withoutHeldFromViewer
// (src/server/schema/image.schema.ts, src/server/services/image.service.ts,
// src/server/controllers/image.controller.ts), never from this port.

func idList(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = strconv.Itoa(9000 + i)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// `ids` is z.array(z.number()).max(200).optional(): kept as sent; anything the schema refuses is its
// BAD_REQUEST (input-invalid); a number Postgres refuses as an int4 is ids-not-int4.
func TestParseInfiniteIDs(t *testing.T) {
	for _, c := range []struct {
		input string
		want  []int
	}{
		{`{}`, nil},
		{`{"ids":[]}`, []int{}},
		{`{"ids":[8001]}`, []int{8001}},
		{`{"ids":[3,1,3,-2,0]}`, []int{3, 1, 3, -2, 0}},
		{`{"ids":[2147483647,-2147483648]}`, []int{2147483647, -2147483648}},
		{`{"ids":[1.0]}`, []int{1}},
	} {
		in, err := ParseInfinite(parseObj(t, c.input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", c.input, fallback.Reason(err), err)
			continue
		}
		if !reflect.DeepEqual(in.IDs, c.want) {
			t.Errorf("ParseInfinite %s: IDs = %#v, want %#v", c.input, in.IDs, c.want)
		}
	}
	// The schema's max: 200 parse, 201 are its BAD_REQUEST.
	in, err := ParseInfinite(parseObj(t, `{"ids":`+idList(200)+`}`))
	if err != nil || len(in.IDs) != 200 || in.IDs[199] != 9199 {
		t.Fatalf("200 ids: %v (err %v)", in, err)
	}
	for input, want := range map[string]string{
		`{"ids":` + idList(201) + `}`: "input-invalid",
		`{"ids":null}`:                "input-invalid",
		`{"ids":"8001"}`:              "input-invalid",
		`{"ids":8001}`:                "input-invalid",
		`{"ids":["8001"]}`:            "input-invalid",
		`{"ids":[8001,null]}`:         "input-invalid",
		`{"ids":[1.5]}`:               "ids-not-int4",
		`{"ids":[2147483648]}`:        "ids-not-int4",
		`{"ids":[-2147483649]}`:       "ids-not-int4",
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != want {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, want)
		}
	}
}

// `reactions` is z.array(z.enum(ReviewReactions)).optional(): kept as sent (order and repeats).
func TestParseInfiniteReactions(t *testing.T) {
	for _, c := range []struct {
		input string
		want  []string
	}{
		{`{}`, nil},
		{`{"reactions":[]}`, []string{}},
		{`{"reactions":["Like"]}`, []string{"Like"}},
		{`{"reactions":["Heart","Like","Heart","Dislike","Laugh","Cry"]}`, []string{"Heart", "Like", "Heart", "Dislike", "Laugh", "Cry"}},
	} {
		in, err := ParseInfinite(parseObj(t, c.input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v)", c.input, fallback.Reason(err), err)
			continue
		}
		if !reflect.DeepEqual(in.Reactions, c.want) {
			t.Errorf("ParseInfinite %s: Reactions = %#v, want %#v", c.input, in.Reactions, c.want)
		}
	}
	for _, input := range []string{
		`{"reactions":["Love"]}`, `{"reactions":["like"]}`, `{"reactions":null}`, `{"reactions":"Like"}`,
		`{"reactions":[1]}`, `{"reactions":["Like",null]}`,
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != "input-invalid" {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want input-invalid", input, fallback.Reason(err), err)
		}
	}
}

// `newCreators` is z.boolean().optional(): not coerced, and a null is refused too.
func TestParseInfiniteNewCreators(t *testing.T) {
	for input, want := range map[string]bool{`{}`: false, `{"newCreators":true}`: true, `{"newCreators":false}`: false} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil || in.NewCreators != want {
			t.Errorf("ParseInfinite %s: %v (err %v), want NewCreators %v", input, in, err, want)
		}
	}
	for _, input := range []string{`{"newCreators":null}`, `{"newCreators":"true"}`, `{"newCreators":1}`} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != "input-invalid" {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want input-invalid", input, fallback.Reason(err), err)
		}
	}
}

// Only image.getInfinite answers the three keys: the posts gallery still hands each back by name.
func TestParseGalleryStillFallsBackOnInfiniteGaps(t *testing.T) {
	for input, want := range map[string]string{
		`{"ids":[1]}`:            "input-ids",
		`{"reactions":["Like"]}`: "input-reactions",
		`{"newCreators":true}`:   "input-newCreators",
	} {
		if _, err := Parse(parseObj(t, input)); fallback.Reason(err) != want {
			t.Errorf("Parse %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, want)
		}
	}
}

// requiresImageDbPath: a non-empty `ids` or `reactions` is the Postgres path; an empty list is not
// (`?.length`). `newCreators` routes nowhere by itself.
func TestInfiniteDBPathForIDsAndReactions(t *testing.T) {
	for input, want := range map[string]bool{
		`{"ids":[1]}`:               true,
		`{"ids":[]}`:                false,
		`{"reactions":["Like"]}`:    true,
		`{"reactions":[]}`:          false,
		`{"newCreators":true}`:      false,
		`{"ids":[],"reactions":[]}`: false,
	} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got := in.dbPath(); got != want {
			t.Errorf("%s: dbPath %v, want %v", input, got, want)
		}
	}
}

// The reaction clause: only with a viewer, bound as the viewer and the kinds as sent, after the
// prioritizeUser branch and before tools; personalized (a version gallery otherwise cached is not).
func TestBuildReactions(t *testing.T) {
	base := ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 60, Reactions: []string{"Like", "Cry"}}
	if b := base.Build(); strings.Contains(b.SQL, `"ImageReaction"`) || b.CacheTTL == 0 {
		t.Fatalf("signed out: no reaction clause and the version's cache policy; got ttl %v\n%s", b.CacheTTL, b.SQL)
	}
	q := base
	q.ViewerID = 9
	q.Tools = []int{4}
	b := q.Build()
	clause := `i.id = ANY(ARRAY(
      SELECT ir."imageId" FROM "ImageReaction" ir
      WHERE ir."userId" = $`
	i := strings.Index(b.SQL, clause)
	if i < 0 {
		t.Fatalf("SQL lacks the reaction clause:\n%s", b.SQL)
	}
	if !strings.Contains(b.SQL, `AND ir.reaction = ANY($`) || !strings.Contains(b.SQL, `::text[]::"ReviewReactions"[])`) {
		t.Fatalf("the kinds are not bound as ReviewReactions:\n%s", b.SQL)
	}
	if j := strings.Index(b.SQL, `"ImageTool"`); j < i {
		t.Fatalf("the reaction clause must precede tools (Node's order)")
	}
	var kinds, viewer bool
	for _, a := range b.Args {
		kinds = kinds || reflect.DeepEqual(a, []string{"Like", "Cry"})
		viewer = viewer || a == 9
	}
	if !kinds || !viewer {
		t.Fatalf("kinds %v viewer %v bound: %v", kinds, viewer, b.Args)
	}
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("a reaction filter is personalized: ttl %v tags %v", b.CacheTTL, b.CacheTags)
	}
	empty := q
	empty.Reactions = []string{}
	if b := empty.Build(); strings.Contains(b.SQL, `"ImageReaction"`) {
		t.Fatal("an empty reactions list adds no clause")
	}
}

// The new-creators clause: after the follow list and before the tag scope, the board bound as given;
// `1 = 0` for an empty board; the cache policy kept (not personalized).
func TestBuildNewCreators(t *testing.T) {
	q := ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 60, NewCreators: true,
		NewCreatorUserIDs: []int{7, 3}}
	b := q.Build()
	if b.CacheTTL == 0 {
		t.Fatal("the board is global: the version gallery stays cacheable")
	}
	if !strings.Contains(b.SQL, `i."userId" = ANY($`) || !hasIntSlice(b.Args, []int{7, 3}) {
		t.Fatalf("the board is not bound as a creator list:\n%s\n%v", b.SQL, b.Args)
	}
	withTags := q
	withTags.TagIDs = []int{11}
	withTags.FollowedUserIDs = []int{8}
	sql := withTags.Build().SQL
	follow, board, tags := strings.Index(sql, `i."userId" = ANY($`), strings.LastIndex(sql, `i."userId" = ANY($`), strings.Index(sql, `"TagsOnImageDetails"`)
	if follow >= board || board > tags {
		t.Fatalf("order follow %d < board %d < tags %d broken:\n%s", follow, board, tags, sql)
	}
	empty := q
	empty.NewCreatorUserIDs = nil
	sql = empty.Build().SQL
	if !strings.Contains(sql, ` AND 1 = 0 AND `) || strings.Contains(sql, `i."userId" = ANY(`) {
		t.Fatalf("an empty board is `1 = 0`, never the unfiltered gallery:\n%s", sql)
	}
	off := q
	off.NewCreators = false
	if sql := off.Build().SQL; strings.Contains(sql, `1 = 0`) || strings.Contains(sql, `i."userId" = ANY(`) {
		t.Fatalf("no newCreators, no clause:\n%s", sql)
	}
}

func hasIntSlice(args []any, want []int) bool {
	for _, a := range args {
		if reflect.DeepEqual(a, want) {
			return true
		}
	}
	return false
}

// The system user alone without a post on the version: no creator clause, the IIF ahead of the sort's
// order; with a post (PrioritizedSystemOrder off) the ordinary prioritized branch.
func TestBuildPrioritizedSystemOrder(t *testing.T) {
	q := ImagesQuery{Limit: 5, Sort: SortMostReactions, BrowsingLevel: 1, ModelVersionID: 60, PrioritizedUserIDs: []int{-1},
		PrioritizedSystemOrder: true}
	sql := q.Build().SQL
	mustContain(t, sql, `p."modelVersionId" = $`, `ORDER BY IIF(i."userId" IN (-1), i.index, 1000),  i."id" DESC`, `i."id" "cursorId"`)
	if strings.Contains(sql, `i."userId" = ANY(`) || strings.Contains(sql, `irr.`) {
		t.Fatalf("the IIF order has no creator clause and no model join:\n%s", sql)
	}
	oldest := q
	oldest.Sort = SortOldest
	mustContain(t, oldest.Build().SQL, `ORDER BY IIF(i."userId" IN (-1), i.index, 1000),  i."id" ASC`)
	post := q
	post.PostID, post.IndexOrder = 700, true
	mustContain(t, post.Build().SQL, `ORDER BY IIF(i."userId" IN (-1), i.index, 1000),  i."index", i."id"`, `i."index" "cursorId"`)
	own := q
	own.PrioritizedSystemOrder = false
	sql = own.Build().SQL
	mustContain(t, sql, `i."userId" = ANY($`, `ORDER BY (i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`)
	if strings.Contains(sql, `IIF(`) {
		t.Fatalf("the system user's own posts are ordered like any creator's:\n%s", sql)
	}
}

// addGalleryRoutes adds the owner and system-post reads to an infFixture's replica: owners maps a
// model id to its owner; systemPosts lists the versions the system user has a post on.
func addGalleryRoutes(f *infFixture, owners map[int]int, systemPosts map[int]bool, ownerReads, systemReads *int) {
	db := f.deps.Gallery.DB.(*testkit.DB)
	db.Routes = append([]testkit.Route{
		{Match: `SELECT id, "userId" FROM "Model" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			*ownerReads++
			var rows [][]any
			for _, id := range args[0].([]int) {
				if o, ok := owners[id]; ok {
					rows = append(rows, []any{id, o})
				}
			}
			return testkit.NewRows([]string{"id", "userId"}, rows...), nil
		}},
		{Match: `SELECT id FROM "Post" WHERE "userId" = -1 AND "modelVersionId" = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			*systemReads++
			if systemPosts[args[0].(int)] {
				return testkit.NewRows([]string{"id"}, []any{77}), nil
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
	}, db.Routes...)
}

// withoutHeldFromViewer on a page picked by id: post 700's version 60 belongs to model 50, held at
// PG|PG-13; post 701 has no version. An R image on 700 is left out for anyone but the model's owner
// and moderators; the R image on 701 is kept; order is kept.
func TestServeInfiniteIDsHeldByPost(t *testing.T) {
	rows := func() []RawImage {
		r1, r2, r3 := infRow(33, 700), infRow(32, 700), infRow(31, 701)
		r2.NsfwLevel, r3.NsfwLevel = 4, 4
		return []RawImage{r1, r2, r3}
	}
	for _, c := range []struct {
		name       string
		viewer     *Viewer
		want       []float64
		ownerReads int
	}{
		{"signed out", nil, []float64{33, 31}, 1},
		{"another viewer", &Viewer{ID: 9}, []float64{33, 31}, 1},
		{"the model's owner", &Viewer{ID: 41}, []float64{33, 32, 31}, 1},
		{"a moderator", &Viewer{ID: 9, IsModerator: true}, []float64{33, 32, 31}, 0},
	} {
		f := newInfFixture(t)
		f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":true,"level":3,"pinnedPosts":{}}`))
		var ownerReads, systemReads int
		addGalleryRoutes(f, map[int]int{50: 41}, nil, &ownerReads, &systemReads)
		f.rows = rows()
		j, _, ans, err := serveInf(t, f, map[string]any{"ids": []any{num("33"), num("32"), num("31")}, "sort": "Newest"},
			InfiniteRequest{Viewer: c.viewer})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := itemIDs(j); !reflect.DeepEqual(got, c.want) || j["source"] != "db" || ans.Trivial {
			t.Errorf("%s: ids %v source %v trivial %v, want %v from db", c.name, got, j["source"], ans.Trivial, c.want)
		}
		if ownerReads != c.ownerReads || len(f.feed.queries) != 0 {
			t.Errorf("%s: owner reads %d (want %d), feed queries %v", c.name, ownerReads, c.ownerReads, f.feed.queries)
		}
		if len(f.sql) != 1 || !strings.Contains(f.sql[0], `i."id" = ANY($`) || !hasIntSlice(f.sqlArgs[0], []int{33, 32, 31}) {
			t.Errorf("%s: the ids clause is not on the page query: %v", c.name, f.sqlArgs)
		}
	}
	// An unheld model: nothing left out, and no owner read.
	f := newInfFixture(t)
	f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":false,"pinnedPosts":{}}`))
	var ownerReads, systemReads int
	addGalleryRoutes(f, map[int]int{50: 41}, nil, &ownerReads, &systemReads)
	f.rows = rows()
	j, _, _, err := serveInf(t, f, map[string]any{"ids": []any{num("33")}}, InfiniteRequest{Viewer: &Viewer{ID: 9}})
	if err != nil || !reflect.DeepEqual(itemIDs(j), []float64{33, 32, 31}) || ownerReads != 0 {
		t.Fatalf("unheld: %v %v owner reads %d", itemIDs(j), err, ownerReads)
	}
	// A held model whose settings carry no level: the gallery gate's reason.
	f = newInfFixture(t)
	f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":true,"pinnedPosts":{}}`))
	addGalleryRoutes(f, map[int]int{50: 41}, nil, &ownerReads, &systemReads)
	f.rows = rows()
	if _, _, _, err := serveInf(t, f, map[string]any{"ids": []any{num("33")}}, InfiniteRequest{}); fallback.Reason(err) != "held-level-unset" {
		t.Fatalf("no level: reason %q (%v), want held-level-unset", fallback.Reason(err), err)
	}
	// Without ids (the global DB page) no image is held by its post here: the gallery gate does that.
	f = newInfFixture(t)
	f.deps.Config.ImageIndexFeed = false
	f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":true,"level":3,"pinnedPosts":{}}`))
	addGalleryRoutes(f, map[int]int{50: 41}, nil, &ownerReads, &systemReads)
	f.rows = rows()
	if j, _, _, err := serveInf(t, f, map[string]any{}, InfiniteRequest{}); err != nil || len(itemIDs(j)) != 3 {
		t.Fatalf("no ids: %v %v", itemIDs(j), err)
	}
}

// postsAsked records each post→version lookup.
type postsAsked struct {
	*fakeV1Sources
	asked [][]int
}

func (p *postsAsked) PostVersions(ctx context.Context, ids []int) (map[int]int, error) {
	p.asked = append(p.asked, append([]int(nil), ids...))
	return p.fakeV1Sources.PostVersions(ctx, ids)
}

// An image with no post is never held and never looked up (`postId` filtered by isDefined first).
// The fake maps post 0 to held version 60, so a lookup for it would also drop the post-less R image.
func TestServeInfiniteIDsPostlessImage(t *testing.T) {
	for _, c := range []struct {
		name  string
		rows  func() []RawImage
		want  []float64
		asked [][]int
	}{
		{"only post-less images", func() []RawImage {
			r := infRow(35, 0)
			r.NsfwLevel = 4
			return []RawImage{r}
		}, []float64{35}, nil},
		{"beside a held post", func() []RawImage {
			r1, r2 := infRow(35, 0), infRow(32, 700)
			r1.NsfwLevel, r2.NsfwLevel = 4, 4
			return []RawImage{r1, r2}
		}, []float64{35}, [][]int{{700}}},
	} {
		f := newInfFixture(t)
		f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":true,"level":3,"pinnedPosts":{}}`))
		src := &postsAsked{fakeV1Sources: f.deps.Sources.(*fakeV1Sources)}
		src.posts[0] = 60
		f.deps.Sources = src
		var ownerReads, systemReads int
		addGalleryRoutes(f, map[int]int{50: 41}, nil, &ownerReads, &systemReads)
		f.rows = c.rows()
		j, _, _, err := serveInf(t, f, map[string]any{"ids": []any{num("35"), num("32")}}, InfiniteRequest{Viewer: &Viewer{ID: 9}})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := itemIDs(j); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ids %v, want %v", c.name, got, c.want)
		}
		if !reflect.DeepEqual(src.asked, c.asked) {
			t.Errorf("%s: post lookups %v, want %v (never post 0)", c.name, src.asked, c.asked)
		}
	}
}

// `reactions` signed out: the Postgres page with no reaction clause; signed in: the clause.
func TestServeInfiniteReactions(t *testing.T) {
	f := newInfFixture(t)
	f.rows = []RawImage{infRow(31, 702)}
	if _, _, _, err := serveInf(t, f, map[string]any{"reactions": []any{"Like"}}, InfiniteRequest{Cap: 1}); err != nil {
		t.Fatalf("signed out: %v", err)
	}
	if len(f.feed.queries) != 0 || len(f.sql) != 1 || strings.Contains(f.sql[0], `"ImageReaction"`) {
		t.Fatalf("signed out: feed %v, sql %v", f.feed.queries, f.sql)
	}
	f = newInfFixture(t)
	f.rows = []RawImage{infRow(31, 702)}
	if _, _, _, err := serveInf(t, f, map[string]any{"reactions": []any{"Like", "Heart"}}, InfiniteRequest{Viewer: &Viewer{ID: 9}}); err != nil {
		t.Fatalf("signed in: %v", err)
	}
	if len(f.sql) != 1 || !strings.Contains(f.sql[0], `ir."userId" = $`) || !hasArg(f.sqlArgs[0], 9) {
		t.Fatalf("signed in: no reaction clause for viewer 9: %v", f.sql)
	}
}

func packedBoard(data any, cachedAt float64) []byte {
	return jspack.Pack(jspack.O("data", data, "cachedAt", cachedAt))
}

// The board entry: fresh (within the hour) is answered; absent, expired, unreadable, or not a list of
// integers falls back; a read error too.
func TestNewCreatorBoards(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	ms := float64(now.UnixMilli())
	cache := testkit.NewRedis()
	b := &NewCreatorBoards{Cache: cache, Prefix: "ns:", Now: func() time.Time { return now }}
	ctx := context.Background()
	if _, err := b.UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-miss" {
		t.Fatalf("absent: %v", err)
	}
	cache.SetString("ns:packed:caches:new-creators:images-new", packedBoard([]any{7, 3, 7}, ms-59*60_000))
	if got, err := b.UserIDs(ctx, "images-new"); err != nil || !reflect.DeepEqual(got, []int{7, 3, 7}) {
		t.Fatalf("fresh: %v %v", got, err)
	}
	// Exactly an hour old is still fresh (`now - ttl > cachedAt` is false); a millisecond more is not.
	cache.SetString("ns:packed:caches:new-creators:images-new", packedBoard([]any{7}, ms-3600_000))
	if _, err := b.UserIDs(ctx, "images-new"); err != nil {
		t.Fatalf("an hour old: %v", err)
	}
	cache.SetString("ns:packed:caches:new-creators:images-new", packedBoard([]any{7}, ms-3600_001))
	if _, err := b.UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-stale" {
		t.Fatalf("expired: %v", err)
	}
	cache.SetString("ns:packed:caches:new-creators:images-new", packedBoard([]any{}, ms))
	if got, err := b.UserIDs(ctx, "images-new"); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("an empty board is an empty list: %v %v", got, err)
	}
	for name, raw := range map[string][]byte{
		"not msgpack":     []byte{0xc1},
		"no data":         jspack.Pack(jspack.O("cachedAt", ms)),
		"cachedAt a text": jspack.Pack(jspack.O("data", []any{1}, "cachedAt", "x")),
	} {
		cache.SetString("ns:packed:caches:new-creators:images-new", raw)
		if _, err := b.UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-miss" {
			t.Errorf("%s: %v, want new-creators-miss", name, err)
		}
	}
	for name, data := range map[string]any{"null": nil, "a fraction": []any{1.5}, "a text": []any{"7"}} {
		cache.SetString("ns:packed:caches:new-creators:images-new", packedBoard(data, ms))
		if _, err := b.UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-stale" {
			t.Errorf("%s: %v, want new-creators-stale", name, err)
		}
	}
	cache.KeyErr = func(string) error { return errors.New("shard down") }
	if _, err := b.UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-read-failed" {
		t.Fatalf("read error: %v", err)
	}
	if _, err := (*NewCreatorBoards)(nil).UserIDs(ctx, "images-new"); fallback.Reason(err) != "new-creators-unconfigured" {
		t.Fatalf("unconfigured: %v", err)
	}
	if NewCreatorBoardID("red") != "images-new-red" || NewCreatorBoardID("blue") != "images-new" || NewCreatorBoardID("") != "images-new" {
		t.Fatal("board ids")
	}
}

// getNewCreatorBoardId('models', domain): the models boards are their own (new_creators, and
// new_creators-red for red), never the images ones.
func TestNewCreatorModelBoardID(t *testing.T) {
	for color, want := range map[string]string{"red": "new_creators-red", "blue": "new_creators", "green": "new_creators", "": "new_creators"} {
		if got := NewCreatorModelBoardID(color); got != want {
			t.Errorf("%q: %q, want %q", color, got, want)
		}
	}
}

// newCreatorsFixture is newInfFixture with both boards cached fresh and the addons holding an entry
// scoped to the boards.
func newCreatorsFixture(t *testing.T, sfw, red []any) *infFixture {
	t.Helper()
	f := newInfFixture(t)
	now := f.deps.Now()
	ms := float64(now.UnixMilli())
	if sfw != nil {
		f.cache.SetString("packed:caches:new-creators:images-new", packedBoard(sfw, ms))
	}
	if red != nil {
		f.cache.SetString("packed:caches:new-creators:images-new-red", packedBoard(red, ms))
	}
	f.deps.NewCreators = &NewCreatorBoards{Cache: f.cache, Now: f.deps.Now}
	sys := testkit.NewRedis()
	sys.SetString("system:browsing-setting-addons", []byte(`[{"type":"some","nsfwLevels":[1,2],"disablePoi":true,"excludedTagIds":[9901]},`+
		`{"type":"some","nsfwLevels":[1,2],"scope":"newCreators","excludedTagIds":[9921]}]`))
	f.deps.Addons = &AddonSource{Sys: sys}
	return f
}

// `newCreators` on the feed path: the board of the request's color as `userIds`, the scoped addon's
// tag excluded, and the hydrate keeping the board's creators.
func TestServeInfiniteNewCreatorsFeed(t *testing.T) {
	f := newCreatorsFixture(t, []any{5, 6}, []any{8})
	const q = "levels=1&excludedTags=9901%2C9921&userIds=5%2C6&excludePoi=1&sort=newest&limit=3"
	f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{10}}
	f.rows = []RawImage{infRow(10, 100)}
	j, _, _, err := serveInf(t, f, map[string]any{"newCreators": true, "sort": "Newest", "limit": num("3")}, InfiniteRequest{Cap: 1, BoardColor: "blue"})
	if err != nil || !reflect.DeepEqual(f.feed.queries, []string{q}) || !reflect.DeepEqual(itemIDs(j), []float64{10}) {
		t.Fatalf("feed: %v queries %v items %v", err, f.feed.queries, itemIDs(j))
	}
	if !strings.Contains(f.sql[0], `i."userId" = ANY($`) || !hasIntSlice(f.sqlArgs[0], []int{5, 6}) {
		t.Fatalf("the hydrate does not keep the board: %v", f.sqlArgs[0])
	}
	// The red host reads the red board.
	f = newCreatorsFixture(t, []any{5, 6}, []any{8})
	const qRed = "levels=1&excludedTags=9901%2C9921&userIds=8&excludePoi=1&sort=newest&limit=3"
	f.feed.answers[qRed] = feedsvc.Answer{Status: 200}
	if _, _, _, err := serveInf(t, f, map[string]any{"newCreators": true, "sort": "Newest", "limit": num("3")}, InfiniteRequest{Cap: 1, BoardColor: "red"}); err != nil ||
		!reflect.DeepEqual(f.feed.queries, []string{qRed}) {
		t.Fatalf("red: %v %v", err, f.feed.queries)
	}
	// Without newCreators the scoped addon does not apply and no board is read.
	f = newCreatorsFixture(t, nil, nil)
	const qOff = "levels=1&excludedTags=9901&excludePoi=1&sort=newest&limit=3"
	f.feed.answers[qOff] = feedsvc.Answer{Status: 200}
	if _, _, _, err := serveInf(t, f, map[string]any{"newCreators": false, "sort": "Newest", "limit": num("3")}, InfiniteRequest{Cap: 1}); err != nil ||
		!reflect.DeepEqual(f.feed.queries, []string{qOff}) {
		t.Fatalf("off: %v %v", err, f.feed.queries)
	}
}

// An empty board, or a board beside a creator or `followed`, is an empty feed page with no hydrate;
// on the Postgres path an empty board is `1 = 0`.
func TestServeInfiniteNewCreatorsEmptyAnswers(t *testing.T) {
	for name, c := range map[string]struct {
		m     map[string]any
		board []any
		feed  int
	}{
		"an empty board":       {map[string]any{"newCreators": true}, []any{}, 0},
		"beside a creator":     {map[string]any{"newCreators": true, "userId": num("5")}, []any{5}, 0},
		"beside followed":      {map[string]any{"newCreators": true, "followed": true}, []any{5}, 0},
		"beside followed (in)": {map[string]any{"newCreators": true, "followed": true, "cursor": "feed:1:2"}, []any{5}, 0},
	} {
		f := newCreatorsFixture(t, c.board, nil)
		f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: {5}}
		j, _, ans, err := serveInf(t, f, c.m, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}})
		if err != nil || len(itemIDs(j)) != 0 || !ans.Trivial || len(f.feed.queries) != c.feed || len(f.sql) != 0 {
			t.Errorf("%s: %v items %v trivial %v feed %v sql %d", name, err, itemIDs(j), ans.Trivial, f.feed.queries, len(f.sql))
		}
	}
	f := newCreatorsFixture(t, []any{}, nil)
	f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":false,"pinnedPosts":{}}`))
	j, _, _, err := serveInf(t, f, map[string]any{"newCreators": true, "modelId": num("50")}, InfiniteRequest{Cap: 1})
	if err != nil || j["source"] != "db" || len(f.sql) != 1 || !strings.Contains(f.sql[0], ` AND 1 = 0 AND `) {
		t.Fatalf("db path, empty board: %v %v %v", err, j, f.sql)
	}
	// No board entry: the fallback, before any page query.
	f = newCreatorsFixture(t, nil, nil)
	if _, _, _, err := serveInf(t, f, map[string]any{"newCreators": true}, InfiniteRequest{Cap: 1}); fallback.Reason(err) != "new-creators-miss" ||
		len(f.feed.queries) != 0 || len(f.sql) != 0 {
		t.Fatalf("miss: %v feed %v sql %d", err, f.feed.queries, len(f.sql))
	}
}

// The system user alone in `prioritizedUserIds`: with a version, the system post decides the order;
// on a model without a version it still falls back, before any read.
func TestServeInfinitePrioritizedSystemUser(t *testing.T) {
	m := carouselInput()
	m["prioritizedUserIds"] = []any{num("-1")}
	for _, c := range []struct {
		name    string
		hasPost bool
		iif     bool
	}{{"no system post", false, true}, {"a system post", true, false}} {
		f := newCarouselFixture(t)
		var ownerReads, systemReads int
		addGalleryRoutes(f, nil, map[int]bool{60: c.hasPost}, &ownerReads, &systemReads)
		f.rows = []RawImage{infRow(31, 700)}
		if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if systemReads != 1 || len(f.sql) != 1 {
			t.Fatalf("%s: system reads %d, page queries %d", c.name, systemReads, len(f.sql))
		}
		if got := strings.Contains(f.sql[0], `ORDER BY IIF(i."userId" IN (-1), i.index, 1000),  `); got != c.iif {
			t.Errorf("%s: IIF order %v, want %v:\n%s", c.name, got, c.iif, f.sql[0])
		}
		if got := strings.Contains(f.sql[0], `i."userId" = ANY($`); got == c.iif {
			t.Errorf("%s: creator clause %v, want %v", c.name, got, !c.iif)
		}
	}
	// A failed system-post read is the request's error, not an answer.
	f := newCarouselFixture(t)
	db := f.deps.Gallery.DB.(*testkit.DB)
	db.Routes = append([]testkit.Route{{Match: `"userId" = -1`, Rows: func([]any) (*testkit.Rows, error) { return nil, errors.New("replica down") }}}, db.Routes...)
	if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); err == nil || len(f.sql) != 0 {
		t.Fatalf("a failed system-post read: %v, %d page queries", err, len(f.sql))
	}
	// A model without a version.
	f = newCarouselFixture(t)
	noVersion := carouselInput()
	delete(noVersion, "modelVersionId")
	noVersion["modelId"] = num("50")
	noVersion["prioritizedUserIds"] = []any{num("-1")}
	if _, _, _, err := serveInf(t, f, noVersion, InfiniteRequest{}); fallback.Reason(err) != "prioritized-system-user-no-version" || len(f.sql) != 0 {
		t.Fatalf("no version: %v, %d page queries", err, len(f.sql))
	}
	// [-1, 5] is not the system user alone: the ordinary branch, no system read.
	f = newCarouselFixture(t)
	var ownerReads, systemReads int
	addGalleryRoutes(f, nil, nil, &ownerReads, &systemReads)
	both := carouselInput()
	both["prioritizedUserIds"] = []any{num("-1"), num("5")}
	if _, _, _, err := serveInf(t, f, both, InfiniteRequest{}); err != nil || systemReads != 0 || strings.Contains(f.sql[0], "IIF(") {
		t.Fatalf("[-1, 5]: %v system reads %d", err, systemReads)
	}
}
