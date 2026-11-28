//go:build integration

package feed

// A model scope read per version (ImagesQuery.PerVersionTopN) against the real Postgres: the same
// rows, in the same order, as getAllImages' single join over the model's resource rows. Ids live in
// 2_111_000..2_111_999.

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// Model 2111701 has versions 2111601 (most of the gallery), 2111602 and 2111603; version 2111609 is
// another model's. Every image is PG on post 2111501, except 2111015 (X, outside the PG level).
// 2111016 used 2111601 and 2111602, 2111012 used 2111603 and 2111601: each is two rows of the page.
// 2111011 used only the other model's version. So at PG, newest first, the model's rows are
//
//	2111020 2111019 2111018 2111017 2111016 2111016 2111014 2111013 2111012 2111012 2111010
//
// and version 2111601 alone holds the first four: a page past them must read more than limit+1 rows
// of that version.
func TestIntegrationImagesQueryModelScopePerVersion(t *testing.T) {
	pool := integtest.Postgres(t)
	clean := `
		DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2111000 AND 2111999;
		DELETE FROM "Image" WHERE id BETWEEN 2111000 AND 2111999;
		DELETE FROM "Post" WHERE id BETWEEN 2111000 AND 2111999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 2111000 AND 2111999;`
	integtest.Exec(t, pool, clean+`
		INSERT INTO "ModelVersion" (id, "modelId") VALUES
		  (2111601, 2111701), (2111602, 2111701), (2111603, 2111701), (2111609, 2111702);
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt", availability) VALUES
		  (2111501, 2111901, 2111601, '2021-02-01 00:00:00', 'Public');
		INSERT INTO "Image" (id, url, "userId", type, "nsfwLevel", "postId", ingestion) VALUES
		  (2111020, 'u20', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111019, 'u19', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111018, 'u18', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111017, 'u17', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111016, 'u16', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111015, 'u15', 2111901, 'image', 8, 2111501, 'Scanned'),
		  (2111014, 'u14', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111013, 'u13', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111012, 'u12', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111011, 'u11', 2111901, 'image', 1, 2111501, 'Scanned'),
		  (2111010, 'u10', 2111901, 'image', 1, 2111501, 'Scanned');
		INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES
		  (2111020, 2111601), (2111019, 2111601), (2111018, 2111601), (2111017, 2111601),
		  (2111016, 2111601), (2111016, 2111602), (2111015, 2111601), (2111014, 2111602),
		  (2111013, 2111601), (2111012, 2111603), (2111012, 2111601), (2111011, 2111609),
		  (2111010, 2111602);`)
	t.Cleanup(func() { integtest.Exec(t, pool, clean) })

	for _, c := range []struct {
		name                string
		sort                string
		limit, skip, cursor int
		want                []int // the page plus its look-ahead row (LIMIT limit+1)
	}{
		{"first page", SortNewest, 3, 0, 0, []int{2111020, 2111019, 2111018, 2111017}},
		{"page 2 inside one version", SortNewest, 2, 2, 0, []int{2111018, 2111017, 2111016}},
		{"page across the shared image", SortNewest, 3, 3, 0, []int{2111017, 2111016, 2111016, 2111014}},
		{"an engagement sort", SortMostReactions, 4, 5, 0, []int{2111016, 2111014, 2111013, 2111012, 2111012}},
		{"cursor on the shared image", SortNewest, 2, 0, 2111016, []int{2111016, 2111016, 2111014}},
		{"the last rows", SortNewest, 5, 8, 0, []int{2111012, 2111012, 2111010}},
		{"oldest", SortOldest, 3, 0, 0, []int{2111010, 2111012, 2111012, 2111013}},
		{"oldest page 3", SortOldest, 2, 4, 0, []int{2111014, 2111016, 2111016}},
		{"oldest cursor", SortOldest, 2, 0, 2111013, []int{2111013, 2111014, 2111016}},
		{"limit 0", SortNewest, 0, 0, 0, []int{2111020}},
	} {
		q := ImagesQuery{Limit: c.limit, Skip: c.skip, Cursor: c.cursor, Sort: c.sort, Period: "AllTime",
			PeriodMode: "published", BrowsingLevel: browsing.PG, ModelID: 2111701, DisablePoi: true, DisableMinor: true}
		join := integRun(t, pool, q)
		q.PerVersionTopN = true
		perVersion := integRun(t, pool, q)
		if got := integIDs(perVersion); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: per version = %v, want %v", c.name, got, c.want)
		}
		// getAllImages' own join over the same tables: the same rows, field for field.
		if !reflect.DeepEqual(perVersion, join) {
			t.Errorf("%s: per version %v, the join %v", c.name, integIDs(perVersion), integIDs(join))
		}
	}
}
