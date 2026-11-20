//go:build integration

package feed

// The minor content rule on the image query against the real Postgres. Ids live in
// 2_107_000..2_107_999.

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// Post 2107501 (by 2107901) on version 2107601: 2107001 minor-flagged R, 2107002 minor-flagged X,
// 2107003 unflagged R, 2107004 minor-flagged PG-13. The minor-flagged mature images are shown only to
// their owner and to moderators, on the version gallery, the feed-service hydrate (ids) and the post
// completion (postIds) alike, with DisableMinor off.
func TestIntegrationImagesQueryMinorContentRule(t *testing.T) {
	pool := integtest.Postgres(t)
	integtest.Exec(t, pool, `
		DELETE FROM "Image" WHERE id BETWEEN 2107000 AND 2107999;
		DELETE FROM "Post" WHERE id BETWEEN 2107000 AND 2107999;
		DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2107000 AND 2107999;
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt", availability) VALUES
		  (2107501, 2107901, 2107601, '2021-02-01 00:00:00', 'Public');
		INSERT INTO "Image" (id, url, "userId", type, "nsfwLevel", "postId", ingestion, minor) VALUES
		  (2107001, 'u1', 2107901, 'image', 4, 2107501, 'Scanned', true),
		  (2107002, 'u2', 2107901, 'image', 8, 2107501, 'Scanned', true),
		  (2107003, 'u3', 2107901, 'image', 4, 2107501, 'Scanned', false),
		  (2107004, 'u4', 2107901, 'image', 2, 2107501, 'Scanned', true);
		INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES
		  (2107001, 2107601), (2107002, 2107601), (2107003, 2107601), (2107004, 2107601);`)
	t.Cleanup(func() {
		integtest.Exec(t, pool, `
			DELETE FROM "Image" WHERE id BETWEEN 2107000 AND 2107999;
			DELETE FROM "Post" WHERE id BETWEEN 2107000 AND 2107999;
			DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2107000 AND 2107999;`)
	})

	everything := []int{2107004, 2107003, 2107002, 2107001}
	controls := []int{2107004, 2107003}
	reads := map[string]ImagesQuery{
		"version gallery": {Limit: 10, BrowsingLevel: browsing.AllLevels, ModelVersionID: 2107601},
		"hydrate":         {Limit: 10, BrowsingLevel: browsing.AllLevels, IDs: []int{2107001, 2107002, 2107003, 2107004}},
		"post completion": {Limit: 10, BrowsingLevel: browsing.AllLevels, PostIDs: []int{2107501}},
	}
	for name, q := range reads {
		for _, c := range []struct {
			viewer      string
			id          int
			isModerator bool
			want        []int
		}{
			{"owner", 2107901, false, everything},
			{"moderator", 2107904, true, everything},
			{"another viewer", 2107903, false, controls},
			{"signed out", 0, false, controls},
		} {
			v := q
			v.ViewerID, v.IsModerator = c.id, c.isModerator
			if got := integIDs(integRun(t, pool, v)); !reflect.DeepEqual(got, c.want) {
				t.Errorf("%s, %s = %v, want %v", name, c.viewer, got, c.want)
			}
		}
	}
}
