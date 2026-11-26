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

// A picture carrying a block marker, or a mature one made with a restricted base model, is not served
// on a miss either, as in servableProfilePictureSql.
func TestIntegrationProfilePictureMissLeavesOutBlockedAndRestricted(t *testing.T) {
	ctx := integtest.Ctx(t)
	pg := integtest.Postgres(t)
	integtest.Exec(t, pg, `
		DELETE FROM "User" WHERE id BETWEEN 1170010 AND 1170019;
		DELETE FROM "Image" WHERE id BETWEEN 1170110 AND 1170119;
		INSERT INTO "Image" (id, name, url, "userId", type, metadata, "nsfwLevel", "nsfwLevelLocked", ingestion, "blockedFor", "modelRestricted") VALUES
		  (1170110, 'clean', 'clean-url', 1170010, 'image', '{}', 1, false, 'Scanned', NULL, false),
		  (1170111, 'reason', 'reason-url', 1170011, 'image', '{}', 1, false, 'Scanned', 'tos', false),
		  (1170112, 'level', 'level-url', 1170012, 'image', '{}', 32, false, 'Scanned', NULL, false),
		  (1170113, 'restricted', 'restricted-url', 1170013, 'image', '{}', 4, false, 'Scanned', NULL, true),
		  (1170114, 'restricted-pg', 'restricted-pg-url', 1170014, 'image', '{}', 1, false, 'Scanned', NULL, true);
		INSERT INTO "User" (id, username, "profilePictureId") VALUES
		  (1170010, 'integ-pp-clean', 1170110),
		  (1170011, 'integ-pp-reason', 1170111),
		  (1170012, 'integ-pp-level', 1170112),
		  (1170013, 'integ-pp-restricted', 1170113),
		  (1170014, 'integ-pp-restricted-pg', 1170114);
	`)
	t.Cleanup(func() {
		integtest.Exec(t, pg, `
			DELETE FROM "User" WHERE id BETWEEN 1170010 AND 1170019;
			DELETE FROM "Image" WHERE id BETWEEN 1170110 AND 1170119;`)
	})

	s := &Sources{Replica: pg}
	got, err := s.profilePicturesFrom(ctx, []int{1170010, 1170011, 1170012, 1170013, 1170014}, map[int]Entry{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{1170010, 1170014} {
		if _, ok := got[id]; !ok {
			t.Errorf("user %d: a servable picture is served (control): got %v", id, got)
		}
	}
	for _, id := range []int{1170011, 1170012, 1170013} {
		if p, ok := got[id]; ok {
			t.Errorf("user %d: picture served on a miss: %v", id, p)
		}
	}
}
