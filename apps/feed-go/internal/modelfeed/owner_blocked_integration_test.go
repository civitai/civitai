//go:build integration

package modelfeed

// getImagesForModelVersion's block term (imageBlockedForConditions, src/server/common/
// image-visibility.ts) against a real Postgres. Ids live in 3_104_000..3_104_999 (this package's
// range, integration_test.go).

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// The fixture: model 3104001 (owner 3104901), its versions each with one published post by the owner,
// every image Scanned at level 1:
//
//	3104101  3104201 index 0 blockedFor CSAM; 3104202 index 1 clean (the next image)
//	3104102  3104203 index 0 blockedFor AiNotVerified (a hold: exempt)
//	3104103  3104204 index 0 clean
func TestIntegrationAssocOwnerBlockedMedia(t *testing.T) {
	pool := integtest.Postgres(t)
	integtest.Exec(t, pool, `
		DELETE FROM "Image" WHERE id BETWEEN 3104000 AND 3104999;
		DELETE FROM "Post" WHERE id BETWEEN 3104000 AND 3104999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 3104000 AND 3104999;
		DELETE FROM "Model" WHERE id BETWEEN 3104000 AND 3104999;
		INSERT INTO "Model" (id, "userId") VALUES (3104001, 3104901);
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (3104101, 3104001), (3104102, 3104001), (3104103, 3104001);
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
		  (3104301, 3104901, 3104101, '2021-02-01 00:00:00'),
		  (3104302, 3104901, 3104102, '2021-02-01 00:00:00'),
		  (3104303, 3104901, 3104103, '2021-02-01 00:00:00');
		INSERT INTO "Image" (id, url, "userId", "nsfwLevel", "postId", index, ingestion, "blockedFor") VALUES
		  (3104201, 'integ-aob1', 3104901, 1, 3104301, 0, 'Scanned', 'CSAM'),
		  (3104202, 'integ-aob2', 3104901, 1, 3104301, 1, 'Scanned', NULL),
		  (3104203, 'integ-aob3', 3104901, 1, 3104302, 0, 'Scanned', 'AiNotVerified'),
		  (3104204, 'integ-aob4', 3104901, 1, 3104303, 0, 'Scanned', NULL);`)
	versions := []int{3104101, 3104102, 3104103}
	for _, c := range []struct {
		name string
		q    assocImageQuery
		want map[int]int // version -> its image
	}{
		// Positive control: no block term.
		{"moderator", assocImageQuery{VersionIDs: versions, ViewerID: 3104999, IsModerator: true, Level: 1},
			map[int]int{3104101: 3104201, 3104102: 3104203, 3104103: 3104204}},
		{"signed out", assocImageQuery{VersionIDs: versions, Level: 1},
			map[int]int{3104101: 3104202, 3104103: 3104204}},
		{"another user", assocImageQuery{VersionIDs: versions, ViewerID: 3104902, Level: 1},
			map[int]int{3104101: 3104202, 3104103: 3104204}},
		// The owner: the CSAM-blocked image gives way to the next one; the hold stays theirs.
		{"owner", assocImageQuery{VersionIDs: versions, ViewerID: 3104901, Level: 1},
			map[int]int{3104101: 3104202, 3104102: 3104203, 3104103: 3104204}},
	} {
		rows, err := assocImages(integtest.Ctx(t), pool, c.q)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		got := map[int]int{}
		for v, imgs := range rows {
			if len(imgs) != 1 {
				t.Fatalf("%s: version %d has %d images, want 1", c.name, v, len(imgs))
			}
			got[v] = int(imgs[0]["id"].(int64))
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s = %v, want %v", c.name, got, c.want)
		}
	}
}
