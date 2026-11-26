//go:build integration

package hydrate

// The version-showcase miss lookup (sqlShowcaseCurated) against a real Postgres
// (testdata/integration/schema.sql). Ids live in 1_175_000..1_175_999.

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// The fixture, as getVersionShowcaseCache's lookup reads it (rows not removed):
//
//	1175101 an Owner row: curated
//	1175102 a Community row: curated
//	1175103 a removed row only: uncurated
//	1175104 no row: uncurated
func TestIntegrationVersionShowcaseMissComputed(t *testing.T) {
	pool := integtest.Postgres(t)
	integtest.Exec(t, pool, `
		DELETE FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" BETWEEN 1175000 AND 1175999;
		INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", "imageId", source, removed) VALUES
		  (1175101, 1175201, 'Owner', false),
		  (1175102, 1175202, 'Community', false),
		  (1175103, 1175203, 'Owner', true);
	`)
	// No cache reader: every version is a miss, answered by the lookup.
	src := &Sources{Replica: pool, Compute: &MissCompute{}}
	for _, c := range []struct {
		name string
		ids  []int
		want Showcase
	}{
		{"an Owner row", []int{1175101}, ShowcaseCurated},
		{"a Community row", []int{1175102}, ShowcaseCurated},
		{"a removed row only", []int{1175103}, ShowcaseUncurated},
		{"no row", []int{1175104}, ShowcaseUncurated},
		{"uncurated together", []int{1175103, 1175104}, ShowcaseUncurated},
		{"one curated among them", []int{1175104, 1175103, 1175102}, ShowcaseCurated},
	} {
		got, err := src.VersionShowcase(integtest.Ctx(t), c.ids)
		if err != nil || got != c.want {
			t.Errorf("%s: %v (%v), want %v", c.name, got, err, c.want)
		}
	}
}
