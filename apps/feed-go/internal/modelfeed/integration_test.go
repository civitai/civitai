//go:build integration

package modelfeed

// Integration tests of model.getAll's SQL against a real Postgres (testdata/integration/schema.sql).
// Expected values are literals written here, never values computed by the code under test.
//
// Ids in this file live in 3_100_000..3_199_999 (internal/feed uses 2_1xx_xxx, internal/hydrate
// 1_1xx_xxx). The model tables this package reads (ModelMetric, ModelBaseModelMetric, TagsOnModels,
// PaidAccess, ModelFile, the sale tables) are written by no other package.

import (
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// integSeedModels resets the fixture:
//
//	3101001 owner 3101901 Checkpoint  thumbsUp 50 download 10  2026-06-12 10:00:00.25  Pony + SDXL metrics, tag 3101801, SafeTensor file, timed early access
//	3101002 owner 3101902 LORA        thumbsUp 50 download 10  2026-06-11 10:00:00.125 SDXL metrics, permanent paid access on sale, allowCommercialUse {None}
//	3101003 owner 3101902 Checkpoint  thumbsUp 40 download 30  2026-06-10              Archived
//	3101004 owner 3101902 Checkpoint  thumbsUp 30 download 40  2026-06-09              Private
//	3101005 owner 3101901 Checkpoint  thumbsUp 20 download 50  NULL                    nsfwLevel 4 (R), Pony metrics
//	3101006 owner 3101902 Checkpoint  thumbsUp 10 download  5  2026-06-08              Draft
func integSeedModels(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "Model" WHERE id BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelMetric" WHERE "modelId" BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelBaseModelMetric" WHERE "modelId" BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 3101000 AND 3101999;
		DELETE FROM "TagsOnModels" WHERE "modelId" BETWEEN 3101000 AND 3101999;
		DELETE FROM "Tag" WHERE id BETWEEN 3101000 AND 3101999;
		DELETE FROM "PaidAccess" WHERE "entityId" BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelFile" WHERE id BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelVersionSale" WHERE id BETWEEN 3101000 AND 3101999;
		DELETE FROM "ModelVersionSaleItem" WHERE "saleId" BETWEEN 3101000 AND 3101999;
		INSERT INTO "Model" (id, "userId", name, type, "nsfwLevel", status, "createdAt", "publishedAt", meta, availability, "allowCommercialUse") VALUES
		  (3101001, 3101901, 'Integ One', 'Checkpoint', 1, 'Published', '2026-06-01 00:00:00', '2026-06-02 00:00:00', '{"metricVisibility":{"buzz":"hide"}}', 'Public', '{Image,Sell}'),
		  (3101002, 3101902, 'Integ Two', 'LORA', 1, 'Published', '2026-06-01 00:00:00', '2026-06-02 00:00:00', '{}', 'Public', '{None}'),
		  (3101003, 3101902, 'Integ Three', 'Checkpoint', 1, 'Published', '2026-06-01 00:00:00', NULL, '{}', 'Public', '{Sell}'),
		  (3101004, 3101902, 'Integ Four', 'Checkpoint', 1, 'Published', '2026-06-01 00:00:00', NULL, '{}', 'Private', '{Sell}'),
		  (3101005, 3101901, 'Integ Five', 'Checkpoint', 4, 'Published', '2026-06-01 00:00:00', NULL, '{}', 'Public', '{Sell}'),
		  (3101006, 3101902, 'Integ Six', 'Checkpoint', 1, 'Draft', '2026-06-01 00:00:00', NULL, '{}', 'Public', '{Sell}');
		UPDATE "Model" SET "sfwName" = 'Safe One', "coverImageId" = 3101701 WHERE id = 3101001;
		INSERT INTO "ModelMetric" ("modelId", "userId", "thumbsUpCount", "downloadCount", "thumbsDownCount", "commentCount",
		    "collectedCount", "tippedAmountCount", "nsfwLevel", status, availability, mode, "lastVersionAt", "hotScore") VALUES
		  (3101001, 3101901, 50, 10, 1, 2, 3, 4, 1, 'Published', 'Public', NULL, '2026-06-12 10:00:00.25', 9),
		  (3101002, 3101902, 50, 10, 0, 0, 0, 0, 1, 'Published', 'Public', NULL, '2026-06-11 10:00:00.125', 9),
		  (3101003, 3101902, 40, 30, 0, 0, 0, 0, 1, 'Published', 'Public', 'Archived', '2026-06-10 00:00:00', 5),
		  (3101004, 3101902, 30, 40, 0, 0, 0, 0, 1, 'Published', 'Private', NULL, '2026-06-09 00:00:00', 4),
		  (3101005, 3101901, 20, 50, 0, 0, 0, 0, 4, 'Published', 'Public', NULL, NULL, 3),
		  (3101006, 3101902, 10, 5, 0, 0, 0, 0, 1, 'Draft', 'Public', NULL, '2026-06-08 00:00:00', 2);
		INSERT INTO "ModelVersion" (id, "modelId", "baseModel", status, "trainingStatus") VALUES
		  (3101601, 3101001, 'Pony', 'Published', 'Approved'),
		  (3101602, 3101002, 'SDXL 1.0', 'Published', NULL),
		  (3101603, 3101003, 'Pony', 'Published', NULL),
		  (3101605, 3101005, 'Pony', 'Published', NULL);
		INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount", "downloadCount", "imageCount", status, availability, "nsfwLevel") VALUES
		  (3101001, 'Pony', 50, 10, 1, 'Published', 'Public', 1),
		  (3101001, 'SDXL 1.0', 5, 1, 1, 'Published', 'Public', 1),
		  (3101002, 'SDXL 1.0', 50, 10, 1, 'Published', 'Public', 1),
		  (3101005, 'Pony', 20, 50, 1, 'Published', 'Public', 4);
		INSERT INTO "Tag" (id, name) VALUES (3101801, 'integ-anime');
		INSERT INTO "TagsOnModels" ("modelId", "tagId") VALUES (3101001, 3101801);
		INSERT INTO "PaidAccess" ("entityType", "entityId", "ownerId", "endsAt", "timeframeDays") VALUES
		  ('ModelVersion', 3101601, 3101901, '2099-01-01 00:00:00', 7),
		  ('ModelVersion', 3101602, 3101902, NULL, NULL);
		INSERT INTO "ModelFile" (id, type, "modelVersionId", metadata) VALUES
		  (3101501, 'Model', 3101601, '{"format": "SafeTensor", "fp": "fp16"}'),
		  (3101502, 'Model', 3101602, '{"format": "GGUF"}');
		INSERT INTO "ModelVersionSale" (id, "userId", "startsAt", "endsAt") VALUES (3101401, 3101902, '2020-01-01', '2099-01-01');
		INSERT INTO "ModelVersionSaleItem" ("saleId", "modelVersionId") VALUES (3101401, 3101602);
	`)
}

// integPage runs one page query and returns its rows.
func integPage(t *testing.T, pool *pgxpool.Pool, q PageQuery) []modelRow {
	t.Helper()
	stmt, err := q.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	rows, err := pool.Query(integtest.Ctx(t), stmt.Text, stmt.Args...)
	if err != nil {
		t.Fatalf("query: %v\n%s", err, stmt.Text)
	}
	out, err := scanModelRows(rows)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	return out
}

func integIDs(rows []modelRow) []int {
	ids := make([]int, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids
}

func integCursors(rows []modelRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		c := "<nil>"
		if r.CursorID != nil {
			c = *r.CursorID
		}
		out = append(out, c)
	}
	return out
}

func integWant[T any](t *testing.T, what string, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

// Every column scans, with the values the seed wrote; the default page keeps only the published,
// public, unarchived models at the level, ties broken by id.
func TestIntegrationModelPageColumnsAndOrder(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	rows := integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1})
	integWant(t, "ids", integIDs(rows), []int{3101001, 3101002})
	integWant(t, "cursors", integCursors(rows), []string{"50|10|3101001", "50|10|3101002"})
	r := rows[0]
	if r.Name != "Integ One" || r.SfwName == nil || *r.SfwName != "Safe One" || r.CoverImageID == nil || *r.CoverImageID != 3101701 ||
		r.SfwCoverImageID != nil || r.Type != "Checkpoint" || r.Status != "Published" || r.Availability != "Public" ||
		r.Mode != nil || r.NsfwLevel != 1 || r.UserID != 3101901 || r.Locked || r.Nsfw {
		t.Fatalf("row %+v", r)
	}
	if !r.CreatedAt.Equal(time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)) || r.LastVersionAt == nil ||
		!r.LastVersionAt.Equal(time.Date(2026, 6, 12, 10, 0, 0, 250_000_000, time.UTC)) {
		t.Fatalf("times %v %v", r.CreatedAt, r.LastVersionAt)
	}
	integWant(t, "rank", parseRank(r.Rank), map[string]any{"downloadCount": int64(10), "thumbsUpCount": int64(50),
		"thumbsDownCount": int64(1), "commentCount": int64(2), "collectedCount": int64(3), "tippedAmountCount": int64(4)})
	integWant(t, "meta", parseMetaPrivacy(r.Meta).visibility, [3]string{"hide", "", ""})
	// The archived model with archived on; a moderator sees the private one too.
	integWant(t, "archived", integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, Archived: true})),
		[]int{3101001, 3101002, 3101003})
	integWant(t, "moderator", integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, IsModerator: true})),
		[]int{3101001, 3101002, 3101004})
}

// The split cursor: the lookahead row is the cursor, the next page starts at it (equality branch,
// inclusive), and a tie on every head field is broken by id.
func TestIntegrationModelPageCursors(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	rows := integPage(t, pool, PageQuery{Take: 1, Sort: SortHighestRated, BrowsingLevel: 31})
	integWant(t, "page 1 + lookahead", integIDs(rows), []int{3101001, 3101002})
	integWant(t, "page 2", integIDs(integPage(t, pool, PageQuery{Take: 1, Sort: SortHighestRated, BrowsingLevel: 31, Cursor: "50|10|3101002"})),
		[]int{3101002, 3101005})
	integWant(t, "from the first", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHighestRated, BrowsingLevel: 31, Cursor: "50|10|3101001"})),
		[]int{3101001, 3101002, 3101005})

	// Newest: timestamp tokens as Postgres writes them (the fraction's trailing zeros trimmed), the
	// NULL lastVersionAt last (and its cursor `|id`).
	newest := integPage(t, pool, PageQuery{Take: 5, Sort: SortNewest, BrowsingLevel: 31})
	integWant(t, "newest", integIDs(newest), []int{3101001, 3101002, 3101005})
	integWant(t, "newest cursors", integCursors(newest), []string{"2026-06-12 10:00:00.25|3101001", "2026-06-11 10:00:00.125|3101002", "|3101005"})
	// A 2-digit fraction (250 ms written ".25") binds 250 ms, as Node reads it since #9075: the
	// equality branch finds the cursor row (read as 25 ms it would start at the next one).
	integWant(t, "newest from a .25 cursor", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortNewest, BrowsingLevel: 31, Cursor: "2026-06-12 10:00:00.25|3101001"})),
		[]int{3101001, 3101002})
	// A 3-digit fraction is served, and binds the instant the row holds: the equality branch finds the
	// cursor row itself (a misread millisecond would find nothing: the row is not before it either).
	// The NULL lastVersionAt row is not reached from a timestamp cursor, in Node's SQL as here.
	integWant(t, "newest from a cursor", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortNewest, BrowsingLevel: 31, Cursor: "2026-06-11 10:00:00.125|3101002"})),
		[]int{3101002})
	// Oldest takes the OR predicate.
	integWant(t, "oldest", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortOldest, BrowsingLevel: 31, Cursor: "2026-06-11 10:00:00.125|3101002"})),
		[]int{3101002, 3101001})
	// Hot: hotScore DESC, id ASC.
	integWant(t, "hot", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 31, Cursor: "9|3101002"})),
		[]int{3101002, 3101005})
}

// The three base-model paths: one base model drives from its own table, several either sum per base
// model (capped at the model's own count) or, for Newest, drive from ModelMetric.
func TestIntegrationModelPageBaseModels(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	single := integPage(t, pool, PageQuery{Take: 5, Sort: SortHighestRated, BrowsingLevel: 31, BaseModels: []string{"Pony"}})
	integWant(t, "single", integIDs(single), []int{3101001, 3101005})
	integWant(t, "single cursors", integCursors(single), []string{"50|10|3101001", "20|50|3101005"})
	multi := integPage(t, pool, PageQuery{Take: 5, Sort: SortHighestRated, BrowsingLevel: 1, BaseModels: []string{"Pony", "SDXL 1.0"}})
	integWant(t, "aggregate", integIDs(multi), []int{3101001, 3101002})
	// 50+5 and 10+1 summed, capped at ModelMetric's 50 and 10.
	integWant(t, "aggregate rank", parseRank(multi[0].Rank)["downloadCount"], any(int64(10)))
	integWant(t, "aggregate cursor", integCursors(multi)[0], "50|10|3101001")
	lateral := integPage(t, pool, PageQuery{Take: 5, Sort: SortNewest, BrowsingLevel: 1, BaseModels: []string{"Pony", "SDXL 1.0"}})
	integWant(t, "lateral", integIDs(lateral), []int{3101001, 3101002})
	integWant(t, "lateral rank", parseRank(lateral[0].Rank)["downloadCount"], any(int64(10)))
}

// Each filter against rows that pass and fail it.
func TestIntegrationModelPageFilters(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	base := func() PageQuery { return PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1} }
	no := false
	cases := []struct {
		name string
		set  func(*PageQuery)
		want []int
	}{
		{"tag", func(q *PageQuery) { q.TagID = 3101801 }, []int{3101001}},
		{"creator", func(q *PageQuery) { q.TargetUserID = 3101902 }, []int{3101002}},
		{"types", func(q *PageQuery) { q.Types = []string{"LORA"} }, []int{3101002}},
		{"excluded tag, signed out", func(q *PageQuery) { q.ExcludedTagIDs = []int{3101801} }, []int{3101002}},
		{"excluded tag, its owner", func(q *PageQuery) { q.ExcludedTagIDs = []int{3101801}; q.ViewerID = 3101901 }, []int{3101001, 3101002}},
		{"excluded users", func(q *PageQuery) { q.ExcludedUserIDs = []int{3101901} }, []int{3101002}},
		{"from the platform", func(q *PageQuery) { q.FromPlatform = true }, []int{3101001}},
		{"period", func(q *PageQuery) { q.PeriodCutoff = time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }, []int{3101001}},
		{"commercial use", func(q *PageQuery) { q.AllowCommercialUse = []string{"None"} }, []int{3101002}},
		{"derivatives false", func(q *PageQuery) { q.AllowDerivatives = &no }, []int{}},
		{"checkpoint type", func(q *PageQuery) { q.CheckpointType = "Trained" }, []int{3101002}},
		{"early access", func(q *PageQuery) { q.EarlyAccess = true }, []int{3101001}},
		{"paid access", func(q *PageQuery) { q.PaidAccess = true }, []int{3101002}},
		{"hide paid", func(q *PageQuery) { q.HidePaid = true }, []int{}},
		{"on sale", func(q *PageQuery) { q.OnSale = true }, []int{3101002}},
		{"file formats", func(q *PageQuery) { q.FileFormats = []string{"SafeTensor"} }, []int{3101001}},
		{"level", func(q *PageQuery) { q.BrowsingLevel = 4 }, []int{3101005}},
	}
	for _, c := range cases {
		q := base()
		c.set(&q)
		integWant(t, c.name, integIDs(integPage(t, pool, q)), c.want)
	}
	// The poi and minor switches, with the owner's carve-out.
	integtest.Exec(t, pool, `UPDATE "ModelMetric" SET poi = true, minor = true WHERE "modelId" = 3101001`)
	integWant(t, "poi", integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, DisablePoi: true})), []int{3101002})
	integWant(t, "poi owner", integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, DisablePoi: true, ViewerID: 3101901})),
		[]int{3101001, 3101002})
	integWant(t, "minor", integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, DisableMinor: true})), []int{3101002})
	// A taken-down model is its owner's and moderators' alone (modelNotWithheldSql).
	integtest.Exec(t, pool, `UPDATE "ModelMetric" SET mode = 'TakenDown' WHERE "modelId" = 3101002`)
	takenDown := func(viewer int, mod bool) []int {
		return integIDs(integPage(t, pool, PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 1, ViewerID: viewer, IsModerator: mod}))
	}
	integWant(t, "taken down, signed out", takenDown(0, false), []int{3101001})
	integWant(t, "taken down, another viewer", takenDown(3101901, false), []int{3101001})
	integWant(t, "taken down, its owner", takenDown(3101902, false), []int{3101001, 3101002})
	integWant(t, "taken down, a moderator", takenDown(3101903, true), []int{3101001, 3101002, 3101004})
}

// The lookups next to the page query: paid-access gates, a tag by name (citext).
func TestIntegrationModelLookups(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	gates, err := paidAccessGates(integtest.Ctx(t), pool, []int{3101001, 3101002, 3101003})
	if err != nil {
		t.Fatal(err)
	}
	if len(gates) != 2 || gates[3101002] == nil || gates[3101002].deadline != nil || gates[3101001] == nil ||
		gates[3101001].deadline == nil || !gates[3101001].deadline.Equal(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("gates %+v", gates)
	}
	for name, want := range map[string]int{"INTEG-ANIME": 3101801, "integ-anime": 3101801, "nope-" + strconv.Itoa(3101): 0} {
		id, _, err := hydrate.TagIDByName(integtest.Ctx(t), pool, name)
		if err != nil || id != want {
			t.Fatalf("tag %q: %d %v, want %d", name, id, err, want)
		}
	}
}

// integSeedCollections adds collections over integSeedModels' models:
//
//	3102001 Public   owner 3101901  items: 3101001 ACCEPTED, 3101002 REVIEW added by 3101903, 3101005 REJECTED
//	3102002 Private  owner 3101902  items: 3101001 ACCEPTED tag 3101811, 3101002 ACCEPTED tag 3101812;
//	                                contributors 3101903 {VIEW,ADD}, 3101904 {ADD}
//	3102003 Unlisted owner 3101902  items: 3101002 ACCEPTED
func integSeedCollections(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "Collection" WHERE id BETWEEN 3102000 AND 3102999;
		DELETE FROM "CollectionItem" WHERE id BETWEEN 3102000 AND 3102999;
		DELETE FROM "CollectionContributor" WHERE "collectionId" BETWEEN 3102000 AND 3102999;
		INSERT INTO "Collection" (id, "userId", read) VALUES
		  (3102001, 3101901, 'Public'),
		  (3102002, 3101902, 'Private'),
		  (3102003, 3101902, 'Unlisted');
		INSERT INTO "CollectionItem" (id, "collectionId", "modelId", "addedById", status, "tagId") VALUES
		  (3102101, 3102001, 3101001, 3101901, 'ACCEPTED', NULL),
		  (3102102, 3102001, 3101002, 3101903, 'REVIEW', NULL),
		  (3102103, 3102001, 3101005, 3101901, 'REJECTED', NULL),
		  (3102104, 3102002, 3101001, 3101902, 'ACCEPTED', 3101811),
		  (3102105, 3102002, 3101002, 3101902, 'ACCEPTED', 3101812),
		  (3102106, 3102003, 3101002, 3101902, 'ACCEPTED', NULL);
		INSERT INTO "CollectionContributor" ("userId", "collectionId", permissions) VALUES
		  (3101903, 3102002, '{VIEW,ADD}'),
		  (3101904, 3102002, '{ADD}');
	`)
}

// Who may read each collection: the configuration, the owner, a contributor row with VIEW; a moderator
// has no branch here (getModelsRaw passes no isModerator), and a missing collection reads for no one.
func TestIntegrationCollectionReadable(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	integSeedCollections(t, pool)
	for _, c := range []struct {
		collection, viewer int
		want               bool
	}{
		{3102001, 0, true},
		{3102003, 0, true},
		{3102003, 3101904, true},
		{3102002, 0, false},
		{3102002, 3101902, true},  // the owner
		{3102002, 3101903, true},  // VIEW
		{3102002, 3101904, false}, // ADD only
		{3102002, 3101905, false}, // no row
		{3102999, 3101902, false}, // no such collection
	} {
		got, err := collectionReadable(integtest.Ctx(t), pool, c.collection, c.viewer)
		if err != nil {
			t.Fatalf("collection %d viewer %d: %v", c.collection, c.viewer, err)
		}
		if got != c.want {
			t.Errorf("collection %d viewer %d: read %v, want %v", c.collection, c.viewer, got, c.want)
		}
	}
}

// The semi-join: accepted items only signed out, the viewer's own in-review items for them, never a
// rejected one; the collection tag narrows; the split cursor pages through a collection as through
// the feed.
func TestIntegrationModelPageCollection(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	integSeedCollections(t, pool)
	base := func() PageQuery { return PageQuery{Take: 10, Sort: SortHighestRated, BrowsingLevel: 31} }
	for _, c := range []struct {
		name string
		set  func(*PageQuery)
		want []int
	}{
		{"public, signed out", func(q *PageQuery) { q.CollectionID = 3102001 }, []int{3101001}},
		{"public, the adder of the in-review item", func(q *PageQuery) { q.CollectionID = 3102001; q.ViewerID = 3101903 }, []int{3101001, 3101002}},
		{"public, another viewer", func(q *PageQuery) { q.CollectionID = 3102001; q.ViewerID = 3101904 }, []int{3101001}},
		{"private", func(q *PageQuery) { q.CollectionID = 3102002; q.ViewerID = 3101902 }, []int{3101001, 3101002}},
		{"private, one tag", func(q *PageQuery) { q.CollectionID = 3102002; q.ViewerID = 3101902; q.CollectionTagID = 3101812 }, []int{3101002}},
		// SDXL 1.0's own counts: 3101002 50 thumbs up, 3101001 5.
		{"a base model", func(q *PageQuery) { q.CollectionID = 3102002; q.BaseModels = []string{"SDXL 1.0"} }, []int{3101002, 3101001}},
		{"several base models", func(q *PageQuery) { q.CollectionID = 3102002; q.BaseModels = []string{"Pony", "SDXL 1.0"} }, []int{3101001, 3101002}},
		{"empty", func(q *PageQuery) { q.CollectionID = 3102999 }, []int{}},
	} {
		q := base()
		c.set(&q)
		integWant(t, c.name, integIDs(integPage(t, pool, q)), c.want)
	}
	// Pagination: one model per page, the lookahead row its cursor, the next page from it.
	page1 := integPage(t, pool, PageQuery{Take: 1, Sort: SortHighestRated, BrowsingLevel: 31, CollectionID: 3102002})
	integWant(t, "page 1 + lookahead", integIDs(page1), []int{3101001, 3101002})
	integWant(t, "page 1 cursors", integCursors(page1), []string{"50|10|3101001", "50|10|3101002"})
	integWant(t, "page 2", integIDs(integPage(t, pool, PageQuery{Take: 1, Sort: SortHighestRated, BrowsingLevel: 31, CollectionID: 3102002, Cursor: "50|10|3101002"})),
		[]int{3101002})
}

// The official pin's id filters against the real schema, on every base-model path and without one,
// composed with the other filters and with a split keyset cursor (each branch carries them).
func TestIntegrationModelPageOfficialPinFilters(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedModels(t, pool)
	integWant(t, "only, one base model", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 31,
		BaseModels: []string{"Pony"}, OnlyModelIDs: []int{3101005, 3101003, 3101999}})), []int{3101005})
	integWant(t, "exclude, one base model", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 31,
		BaseModels: []string{"Pony"}, ExcludeModelIDs: []int{3101001}})), []int{3101005})
	integWant(t, "only, several base models", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 1,
		BaseModels: []string{"Pony", "SDXL 1.0"}, OnlyModelIDs: []int{3101001}})), []int{3101001})
	integWant(t, "exclude, several base models", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 1,
		BaseModels: []string{"Pony", "SDXL 1.0"}, ExcludeModelIDs: []int{3101001}})), []int{3101002})
	// The private 3101004 stays out: neither filter relaxes the private-model filter.
	integWant(t, "only, no base model", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHighestRated, BrowsingLevel: 1,
		OnlyModelIDs: []int{3101002, 3101004}})), []int{3101002})
	integWant(t, "exclude, from a cursor", integIDs(integPage(t, pool, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 31,
		Cursor: "9|3101001", ExcludeModelIDs: []int{3101002}})), []int{3101001, 3101005})
}
