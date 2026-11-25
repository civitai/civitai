package listingread

import (
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// Literal ceilings, each worked from listingMediaCeiling / redHostMediaCeiling in
// listing-media-audience.ts (PG 1, PG-13 2, R 4, X 8, XXX 16, Blocked 32).
func TestListingMediaCeiling(t *testing.T) {
	main := func(level int64) Viewer { return Viewer{BrowsingLevel: level} }
	red := func(level int64) Viewer { return Viewer{RedCapable: true, BrowsingLevel: level} }
	for _, c := range []struct {
		name   string
		v      Viewer
		rating string
		want   int64
	}{
		{"main, pg", main(31), "pg", 1},
		{"main, pg13", main(31), "pg13", 3},
		{"main, pg-13 spelling", main(0), "pg-13", 3},
		// Off a red host the ceiling is SFW whatever the rating or the viewer.
		{"main, r", main(31), "r", 3},
		{"main, x", main(31), "x", 3},
		{"main, xxx", main(31), "xxx", 3},
		// null, g and anything unknown fail closed to PG; the lookup is case-sensitive.
		{"main, null", main(31), "", 1},
		{"main, g", main(31), "g", 1},
		{"main, upper-case R", main(31), "R", 1},
		{"main, unknown", main(31), "nc17", 1},
		// A red host adds the viewer's levels to that ceiling, and never takes away.
		{"red anonymous, pg", red(0), "pg", 1},
		{"red anonymous, pg13", red(0), "pg13", 3},
		{"red, negative level is the public floor", red(-1), "pg13", 3},
		{"red PG-13 viewer, pg", red(2), "pg", 3},
		{"red R-only viewer, pg", red(4), "pg", 5},
		{"red X viewer, r", red(15), "r", 15},
		{"red X viewer, null", red(15), "", 15},
		{"red everything incl. Blocked, pg", red(63), "pg", 31},
	} {
		if got := listingMediaCeiling(c.v, c.rating); got != c.want {
			t.Errorf("%s: ceiling %d, want %d", c.name, got, c.want)
		}
	}
}

func TestMatureRatingGate(t *testing.T) {
	for _, c := range []struct {
		name  string
		red   bool
		level int64
		want  store.Mature
	}{
		{"main, every level", false, 31, store.Mature{}},
		{"red, PG only", true, 1, store.Mature{}},
		{"red, no level", true, 0, store.Mature{}},
		{"red, R", true, 4, store.Mature{R: true}},
		{"red, X", true, 8, store.Mature{X: true}},
		{"red, XXX", true, 16, store.Mature{XXX: true}},
		{"red, Blocked only", true, 32, store.Mature{}},
		{"red, all", true, 31, store.Mature{R: true, X: true, XXX: true}},
	} {
		if got := matureRatingsAllowed(c.red, c.level); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
	// The listing gate's rating rule is store.Mature.Admits (TestMatureAdmits pins it), reached
	// through Admits with an X-only viewer.
	xOnly := Viewer{Scope: ScopeFull, RedCapable: true, BrowsingLevel: levelPG | levelX}
	for _, c := range []struct {
		rating string
		want   bool
	}{
		{"", true}, {"mystery", true}, {"g", true}, {"pg", true}, {"pg13", true}, {"pg-13", true},
		{"r", false}, {"R", false}, {"x", true}, {"X", true}, {"xxx", false}, {"XXX", false},
	} {
		l := store.Listing{Kind: "onsite", ListingContentRating: c.rating}
		if got := Admits(l, xOnly); got != c.want {
			t.Errorf("rating %q with X only: %v, want %v", c.rating, got, c.want)
		}
	}
}

func TestScopeGate(t *testing.T) {
	for _, c := range []struct {
		scope, kind string
		want        bool
	}{
		{"full", "onsite", true}, {"full", "offsite", true},
		{"public-external", "onsite", false}, {"public-external", "offsite", true},
		{"none", "offsite", false}, {"", "offsite", false}, {"FULL", "offsite", false},
	} {
		if got := scopeAdmitsKind(NarrowScope(c.scope), c.kind); got != c.want {
			t.Errorf("scope %q kind %s: %v, want %v", c.scope, c.kind, got, c.want)
		}
	}
}
