package feed

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// image.getInfinite's `prioritizedUserIds` (getAllImages' prioritizeUser branch, version cache off)
// and `pending`, as the model page's showcase carousel sends them: modelVersionId, the model owner's id
// alone, AllTime, Most Reactions, a limit, pending, `include: []`, withMeta false, the browsing level
// and filters (src/pages/models/[id]/[[...slug]].tsx, ModelCarousel.tsx). Expected values are
// literals read from image.service.ts, never from this port.

// carouselInput is that request for version 60 (model 50) and owner 5.
func carouselInput() map[string]any {
	return map[string]any{
		"modelVersionId": num("60"), "prioritizedUserIds": []any{num("5")}, "period": "AllTime",
		"sort": "Most Reactions", "limit": num("3"), "pending": true, "include": []any{}, "withMeta": false,
		"browsingLevel": num("1"), "excludedTagIds": []any{}, "disablePoi": false, "disableMinor": false,
	}
}

// newCarouselFixture is newInfFixture with model 50's gallery settings cached, unheld (the gates read
// them for a non-moderator).
func newCarouselFixture(t *testing.T) *infFixture {
	t.Helper()
	f := newInfFixture(t)
	f.cache.SetString("model:gallery-settings:50", []byte(`{"sfwHeld":false,"pinnedPosts":{}}`))
	return f
}

func TestServeInfinitePrioritizedCarouselIsThePostgresPage(t *testing.T) {
	f := newCarouselFixture(t)
	// The rows in the order the page query returns them; the fourth is the look-ahead row.
	f.rows = []RawImage{infRow(31, 700), infRow(30, 700), infRow(42, 701), infRow(29, 702)}
	j, _, ans, err := serveInf(t, f, carouselInput(), InfiniteRequest{})
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if len(f.feed.queries) != 0 {
		t.Fatalf("prioritizedUserIds with a version must not ask the feed: %v", f.feed.queries)
	}
	// The query's order kept, the look-ahead row's id as the cursor (getCursor's prop is still i."id"),
	// the handler's source.
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{31, 30, 42}) || j["nextCursor"] != float64(29) || j["source"] != "db" || ans.Trivial {
		t.Fatalf("answer ids %v next %v source %v trivial %v", got, j["nextCursor"], j["source"], ans.Trivial)
	}
	if len(f.sql) != 1 {
		t.Fatalf("page queries = %d, want 1", len(f.sql))
	}
	sql := f.sql[0]
	mustContain(t, sql,
		`FROM "Image" i`,
		`p."modelVersionId" = $`,
		`i."userId" = ANY($`,
		`i."id" "cursorId"`,
		`ORDER BY (i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`,
	)
	for _, absent := range []string{`ImageResourceNew`, `irr.`, `(p."publishedAt" < now())`} {
		if strings.Contains(sql, absent) {
			t.Errorf("the prioritized pending query carries %q:\n%s", absent, sql)
		}
	}
	var owners, version bool
	for _, a := range f.sqlArgs[0] {
		owners = owners || reflect.DeepEqual(a, []int{5})
		version = version || a == 60
	}
	if !owners || !version {
		t.Fatalf("the owner list [5] (%v) or the version 60 (%v) is not bound: %v", owners, version, f.sqlArgs[0])
	}
	// Signed out, pending is not the pending view: the reviewed visibility stays.
	mustContain(t, sql, `i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`)
}

// The pending view: a signed-in viewer's own-content and managed-collection carve-outs, a moderator's
// unrated images; neither keeps the reviewed visibility.
func TestServeInfinitePendingViews(t *testing.T) {
	f := newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"}); err != nil {
		t.Fatalf("signed in: %v", err)
	}
	mustContain(t, f.sql[0],
		`(i."needsReview" IS NULL OR i."userId" = $`,
		`(i."acceptableMinor" = FALSE OR i."userId" = $`,
		`OR i."nsfwLevel" = 0 OR (`,
		`p."collectionId" IS NOT NULL AND i."nsfwLevel" NOT IN (0, $`,
		`cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]`,
	)
	if strings.Contains(f.sql[0], `i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`) {
		t.Fatalf("the signed-in pending view kept the reviewed visibility:\n%s", f.sql[0])
	}
	if !hasArg(f.sqlArgs[0], 32) {
		t.Fatalf("NsfwLevel.Blocked (32) is not bound: %v", f.sqlArgs[0])
	}

	f = newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{Viewer: &Viewer{ID: 9, IsModerator: true}}); err != nil {
		t.Fatalf("moderator: %v", err)
	}
	mustContain(t, f.sql[0], `) != 0 OR i."nsfwLevel" = 0)`)
	for _, absent := range []string{`i."needsReview" IS NULL`, `"CollectionContributor"`, `p."availability" != 'Private'`} {
		if strings.Contains(f.sql[0], absent) {
			t.Errorf("the moderator's pending view carries %q", absent)
		}
	}
}

// Without a model scope the request takes the feed path, whose query mapper refuses it: the empty page
// answerWithoutFeed gives a shape the feed cannot express, without a feed call. Likewise `pending`.
func TestServeInfinitePrioritizedOrPendingOnTheFeedPath(t *testing.T) {
	const want = `{"items":[],"source":"feed"}|{"nextCursor":["undefined"]}`
	for name, m := range map[string]map[string]any{
		"prioritizedUserIds":                  {"prioritizedUserIds": []any{num("5")}, "limit": num("2")},
		"prioritizedUserIds with a cursor":    {"prioritizedUserIds": []any{num("5")}, "cursor": "feed:1:2"},
		"prioritizedUserIds with a creator":   {"prioritizedUserIds": []any{num("5")}, "userId": num("5")},
		"pending":                             {"pending": true, "limit": num("2")},
		"pending with a version":              {"pending": true, "modelVersionId": num("60")},
		"the system user without a model":     {"prioritizedUserIds": []any{num("-1")}},
		"prioritizedUserIds and pending both": {"prioritizedUserIds": []any{num("5")}, "pending": true},
	} {
		f := newCarouselFixture(t)
		j, ann, ans, err := serveInf(t, f, m, InfiniteRequest{Cap: 1})
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		jb, _ := json.Marshal(j)
		ab, _ := json.Marshal(ann)
		if got := string(jb) + "|" + string(ab); got != want || !ans.Trivial {
			t.Errorf("%s: %s trivial=%v, want %s trivial=true", name, got, ans.Trivial, want)
		}
		if len(f.feed.queries) != 0 || len(f.sql) != 0 {
			t.Errorf("%s: feed queries %v, page queries %d; want none", name, f.feed.queries, len(f.sql))
		}
	}
}

// The prioritized sub-cases this port leaves to Node, each under its own reason.
func TestServeInfinitePrioritizedFallbacks(t *testing.T) {
	for _, c := range []struct {
		name string
		m    map[string]any
		want string
	}{
		// Node: BAD_REQUEST 'Cannot use cursor with prioritizedUserIds'.
		{"a numeric cursor", map[string]any{"modelVersionId": num("60"), "prioritizedUserIds": []any{num("5")}, "cursor": num("7")}, "prioritized-cursor"},
		{"a numeric string cursor", map[string]any{"modelVersionId": num("60"), "prioritizedUserIds": []any{num("5")}, "cursor": "7"}, "prioritized-cursor"},
		{"a cursor on a model alone", map[string]any{"modelId": num("50"), "prioritizedUserIds": []any{num("5")}, "cursor": num("7")}, "prioritized-cursor"},
		// Node reads whether the system user has a post on the version, then orders by an IIF.
		{"the system user alone", map[string]any{"modelVersionId": num("60"), "prioritizedUserIds": []any{num("-1")}}, "prioritized-system-user"},
	} {
		f := newCarouselFixture(t)
		_, _, _, err := serveInf(t, f, c.m, InfiniteRequest{})
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
		if len(f.sql) != 0 {
			t.Errorf("%s: %d page queries before falling back", c.name, len(f.sql))
		}
	}
	// A cursor of 0 is falsy in Node: no refusal, and no cursor clause.
	f := newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	m := carouselInput()
	m["cursor"] = num("0")
	if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); err != nil {
		t.Fatalf("cursor 0: %v", err)
	}
	if strings.Contains(f.sql[0], `(i."id" <= $`) {
		t.Fatalf("cursor 0 added a cursor clause:\n%s", f.sql[0])
	}
	// The system user beside another creator is not the system-user case: served.
	f = newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	m = carouselInput()
	m["prioritizedUserIds"] = []any{num("-1"), num("5")}
	if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); err != nil {
		t.Fatalf("[-1, 5]: %v", err)
	}
}

// What the schema refuses (Node's own BAD_REQUEST) falls back as invalid input.
func TestParseInfinitePrioritizedAndPendingInvalid(t *testing.T) {
	for _, c := range []struct {
		name string
		m    map[string]any
	}{
		{"pending not a boolean", map[string]any{"pending": "yes"}},
		{"pending a number", map[string]any{"pending": num("1")}},
		{"prioritizedUserIds not a list", map[string]any{"prioritizedUserIds": num("5")}},
		{"a fractional user id", map[string]any{"prioritizedUserIds": []any{num("1.5")}}},
		{"a string user id", map[string]any{"prioritizedUserIds": []any{"5"}}},
	} {
		_, err := ParseInfinite(c.m)
		if got := fallback.Reason(err); got != "input-invalid" {
			t.Errorf("%s: reason %q (%v), want input-invalid", c.name, got, err)
		}
	}
	// Invariant guard (unchanged by this port): the gallery still falls back on all three.
	for m, want := range map[string]string{
		`{"prioritizedUserIds":[5]}`: "input-prioritizedUserIds",
		`{"pending":true}`:           "input-pending",
		`{"include":[]}`:             "input-include-no-cosmetics",
	} {
		if _, err := Parse(parseObj(t, m)); fallback.Reason(err) != want {
			t.Errorf("gallery Parse %s: reason %q, want %q", m, fallback.Reason(err), want)
		}
	}
}

func TestParseInfiniteReadsPrioritizedAndPending(t *testing.T) {
	in, err := ParseInfinite(carouselInput())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in.PrioritizedUserIDs, []int{5}) || !in.Pending || in.IncludeCosmetics || in.IncludeProfilePictures ||
		in.ModelVersionID != 60 || in.Limit != 3 {
		t.Fatalf("parsed = %+v", in)
	}
	// Absent, null (superjson's undefined) and empty are all "not sent".
	for _, m := range []map[string]any{{}, {"prioritizedUserIds": nil, "pending": nil}, {"prioritizedUserIds": []any{}, "pending": false}} {
		in, err := ParseInfinite(m)
		if err != nil {
			t.Fatal(err)
		}
		if in.prioritized() || in.Pending || !in.IncludeCosmetics {
			t.Fatalf("%v parsed as prioritized %v pending %v cosmetics %v", m, in.prioritized(), in.Pending, in.IncludeCosmetics)
		}
	}
	// requiresImageDbPath: prioritizedUserIds only with a model or version scope.
	for _, c := range []struct {
		in   InfiniteInput
		want bool
	}{
		{InfiniteInput{PrioritizedUserIDs: []int{5}, Input: Input{ModelVersionID: 60}}, true},
		{InfiniteInput{PrioritizedUserIDs: []int{5}, Input: Input{ModelID: 50, ModelVersionID: 60}}, true},
		{InfiniteInput{PrioritizedUserIDs: []int{5}, Input: Input{ModelID: 50}}, true},
		{InfiniteInput{PrioritizedUserIDs: []int{5}}, false},
		{InfiniteInput{PrioritizedUserIDs: []int{5}, UserID: 5}, false},
		{InfiniteInput{Pending: true, Input: Input{ModelVersionID: 60}}, false},
	} {
		if got := c.in.dbPath(); got != c.want {
			t.Errorf("dbPath(%+v) = %v, want %v", c.in, got, c.want)
		}
	}
}

// `include: []` reaches the hydration as no cosmetics; the default include keeps them.
func TestServeInfiniteIncludeWithoutCosmetics(t *testing.T) {
	f := newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{}); err != nil {
		t.Fatal(err)
	}
	if !f.hydrator.req.NoCosmetics || !f.hydrator.req.NoProfilePictures {
		t.Fatalf("include [] hydrated with %+v", f.hydrator.req)
	}
	m := carouselInput()
	delete(m, "include")
	if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); err != nil {
		t.Fatal(err)
	}
	if f.hydrator.req.NoCosmetics {
		t.Fatal("the default include (['cosmetics']) hydrated without cosmetics")
	}
}

// `use-model-version-cache-for-images` mirrored on: the cache-ordered branch is Node's.
func TestServeInfinitePrioritizedVersionCacheFallsBack(t *testing.T) {
	f := newCarouselFixture(t)
	f.deps.Config.PrioritizedVersionCache = true
	_, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{})
	if got := fallback.Reason(err); got != "prioritized-version-cache" {
		t.Fatalf("reason %q (%v), want prioritized-version-cache", got, err)
	}
	// The flag is read only on the prioritized Postgres path: the feed path's empty page is unchanged.
	j, _, _, err := serveInf(t, f, map[string]any{"prioritizedUserIds": []any{num("5")}}, InfiniteRequest{})
	if err != nil || j["source"] != "feed" {
		t.Fatalf("feed path with the mirror on: %v %v", j, err)
	}
}

func TestBuildPrioritized(t *testing.T) {
	// A model alone: no model scope at all (no join, no version clause), only the creators.
	b := (&ImagesQuery{Limit: 5, Sort: SortMostReactions, BrowsingLevel: 1, ModelID: 50, PrioritizedUserIDs: []int{5, 6}}).Build()
	for _, absent := range []string{`ImageResourceNew`, `mv."modelId"`, `p."modelVersionId" =`} {
		if strings.Contains(b.SQL, absent) {
			t.Errorf("a prioritized model-only query carries %q", absent)
		}
	}
	mustContain(t, b.SQL, `i."userId" = ANY($`, `i."id" "cursorId"`, `ORDER BY (i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`)
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("prioritizedUserIds is personalized (never cached): ttl %v tags %v", b.CacheTTL, b.CacheTags)
	}
	// Oldest: the order is still the prioritized one; the cursor column is the sort's.
	b = (&ImagesQuery{Limit: 5, Sort: SortOldest, BrowsingLevel: 1, ModelVersionID: 60, PrioritizedUserIDs: []int{5}}).Build()
	if strings.Contains(b.SQL, `ORDER BY i."id" ASC`) {
		t.Fatal("prioritizedUserIds replaces the sort's order")
	}
	mustContain(t, b.SQL, `i."id" "cursorId"`, `p."modelVersionId" = $`)
	// A post's media: the cursor column stays the index (getCursor ran on i."index").
	b = (&ImagesQuery{Limit: 5, BrowsingLevel: 1, PostID: 7, IndexOrder: true, PrioritizedUserIDs: []int{5}}).Build()
	mustContain(t, b.SQL, `i."index" "cursorId"`, `ORDER BY (i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`)

	// Pending signed out is not personalized: a version gallery stays cacheable, without the publish clause.
	b = (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, Pending: true}).Build()
	if b.CacheTTL != 10*time.Minute || strings.Contains(b.SQL, `p."publishedAt" < now()`) {
		t.Fatalf("signed-out pending: ttl %v, publish clause %v", b.CacheTTL, strings.Contains(b.SQL, `p."publishedAt" < now()`))
	}
	// The pending view (signed in, or a moderator) is.
	for _, q := range []ImagesQuery{
		{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, Pending: true, ViewerID: 9},
		{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, Pending: true, ViewerID: 9, IsModerator: true},
	} {
		if b := q.Build(); b.CacheTTL != 0 || b.CacheTags != nil {
			t.Errorf("pending view (moderator %v) cached: %v %v", q.IsModerator, b.CacheTTL, b.CacheTags)
		}
	}
	// Positive control: the same version gallery without pending keeps its publish clause.
	if b := (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60}).Build(); !strings.Contains(b.SQL, `(p."publishedAt" < now())`) {
		t.Fatal("control: the publish clause is missing without pending")
	}
}

// The owner's own image under an owner-hidden review hold (csam, minor) shows in their pending view,
// as on the Node path (pendingOthersImageConditions with the owner's view); another user's stays held.
func TestServeInfinitePendingViewShowsOwnHeldImages(t *testing.T) {
	f := newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700)}
	if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"}); err != nil {
		t.Fatalf("signed in: %v", err)
	}
	mustContain(t, f.sql[0],
		`(i."needsReview" IS NULL OR i."needsReview" NOT IN ($`,
		// Control: the owner keeps their other review states.
		`(i."needsReview" IS NULL OR i."userId" = $`,
	)
	// The hold is lifted for the viewer's own rows only.
	if !regexp.MustCompile(`i\."needsReview" NOT IN \(\$\d+, \$\d+\) OR i\."userId" = \$\d+\)`).MatchString(f.sql[0]) {
		t.Fatalf("the hold is not lifted for the owner's own rows: %s", f.sql[0])
	}
	bound := map[string]bool{}
	for _, a := range f.sqlArgs[0] {
		if s, ok := a.(string); ok {
			bound[s] = true
		}
	}
	if !bound["csam"] || !bound["minor"] {
		t.Fatalf("the owner-hidden review holds are not bound: %v", f.sqlArgs[0])
	}
	if bound["poi"] {
		t.Fatalf("poi is withheld from its owner: %v", f.sqlArgs[0])
	}
}
