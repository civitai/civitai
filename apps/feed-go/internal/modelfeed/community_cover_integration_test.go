//go:build integration

package modelfeed

// The community-cover guard's read against a real Postgres (testdata/integration/schema.sql). Ids
// live in 3_103_000..3_103_999 (this package's range, integration_test.go).

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// The fixture, as getShowcaseCommunityCovers' first query reads it:
//
//	3103201 featured (Community, not removed) on 3103101, a version of model 3103001
//	3103202 featured on 3103101, removed
//	3103203 an Owner row on 3103101
//	3103204 featured on 3103101, no Image row (deleted)
//	3103205 featured on 3103102, a version of model 3103002
func TestIntegrationCommunityCoverGuard(t *testing.T) {
	pool := integtest.Postgres(t)
	integtest.Exec(t, pool, `
		DELETE FROM "ModelVersionShowcaseItem" WHERE "imageId" BETWEEN 3103000 AND 3103999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 3103000 AND 3103999;
		DELETE FROM "Image" WHERE id BETWEEN 3103000 AND 3103999;
		INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
		  (3103101, 3103001, 'Published'),
		  (3103102, 3103002, 'Published');
		INSERT INTO "Image" (id, url, "userId") VALUES
		  (3103201, 'u1', 3103901), (3103202, 'u2', 3103901), (3103203, 'u3', 3103901), (3103205, 'u5', 3103901);
		INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", "imageId", source, removed) VALUES
		  (3103101, 3103201, 'Community', false),
		  (3103101, 3103202, 'Community', true),
		  (3103101, 3103203, 'Owner', false),
		  (3103101, 3103204, 'Community', false),
		  (3103102, 3103205, 'Community', false);
	`)
	want := func(pairs ...[2]int) []coverWant {
		out := make([]coverWant, len(pairs))
		for i, p := range pairs {
			out[i] = coverWant{it: &feedItem{row: &modelRow{ID: p[0]}}, coverID: p[1]}
		}
		return out
	}
	for _, c := range []struct {
		name    string
		missing []coverWant
		reason  string
	}{
		{"featured", want([2]int{3103001, 3103201}), "model-community-cover"},
		{"featured on the other model", want([2]int{3103002, 3103205}), "model-community-cover"},
		{"featured among others", want([2]int{3103001, 3103202}, [2]int{3103002, 3103205}), "model-community-cover"},
		{"removed", want([2]int{3103001, 3103202}), ""},
		{"an Owner row", want([2]int{3103001, 3103203}), ""},
		{"no Image row", want([2]int{3103001, 3103204}), ""},
		{"featured on another model's version", want([2]int{3103001, 3103205}), ""},
		// Both images and both models are asked about; neither pair is featured.
		{"crossed pairs", want([2]int{3103001, 3103205}, [2]int{3103002, 3103201}), ""},
		{"never featured", want([2]int{3103001, 3103299}), ""},
	} {
		err := communityCoverGuard(integtest.Ctx(t), pool, nil, c.missing)
		if c.reason == "" {
			if err != nil {
				t.Errorf("%s: %v, want no fallback", c.name, err)
			}
			continue
		}
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %v (%q), want %q", c.name, err, got, c.reason)
		}
	}
}
