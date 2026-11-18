//go:build integration

package hydrate

// The profile-picture miss query against the real Postgres: a picture with no rating (nsfwLevel 0)
// is not served, as in servableProfilePictureSql. Ids live in 1_170_000..1_170_999.

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

func TestIntegrationProfilePictureMissRequiresARating(t *testing.T) {
	ctx := integtest.Ctx(t)
	pg := integtest.Postgres(t)
	integtest.Exec(t, pg, `
		DELETE FROM "User" WHERE id BETWEEN 1170000 AND 1170999;
		DELETE FROM "Image" WHERE id BETWEEN 1170000 AND 1170999;
		INSERT INTO "Image" (id, name, url, "userId", type, metadata, "nsfwLevel", "nsfwLevelLocked", ingestion) VALUES
		  (1170101, 'rated', 'rated-url', 1170001, 'image', '{}', 1, false, 'Scanned'),
		  (1170102, 'unrated', 'unrated-url', 1170002, 'image', '{}', 0, false, 'Scanned'),
		  (1170103, 'locked-unrated', 'locked-url', 1170003, 'image', '{}', 0, true, 'Pending');
		INSERT INTO "User" (id, username, "profilePictureId") VALUES
		  (1170001, 'integ-pp-rated', 1170101),
		  (1170002, 'integ-pp-unrated', 1170102),
		  (1170003, 'integ-pp-locked-unrated', 1170103);
	`)
	t.Cleanup(func() {
		integtest.Exec(t, pg, `
			DELETE FROM "User" WHERE id BETWEEN 1170000 AND 1170999;
			DELETE FROM "Image" WHERE id BETWEEN 1170000 AND 1170999;`)
	})

	s := &Sources{Replica: pg}
	got, err := s.profilePicturesFrom(ctx, []int{1170001, 1170002, 1170003}, map[int]Entry{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got[1170001]; !ok {
		t.Errorf("a rated picture is served (control): got %v", got)
	}
	if p, ok := got[1170002]; ok {
		t.Errorf("an unrated picture is served on a miss: %v", p)
	}
	if p, ok := got[1170003]; ok {
		t.Errorf("a moderator lock at no rating serves the picture on a miss: %v", p)
	}
}
