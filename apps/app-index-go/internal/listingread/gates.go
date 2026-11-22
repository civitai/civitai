// Package listingread answers the listing API (internal/api, GET /listings and
// GET /listings/{slug}) from the listings read model: the viewer gates, the per-request media
// projection, the store grid's sorts and keyset paging, and the card and detail shapes.
//
// Every rule here is a port of the store's database path, and names the function it mirrors. They
// must agree exactly: the web tier's shadow diff (LISTINGS-READ-MODEL.md, "Shadow diff") compares
// what this package returns with what the database path returns, and tolerates no media
// difference. testdata/media-parity.json pins the media rule on both sides (parity_test.go here,
// src/server/services/blocks/__tests__/listing-media-parity.test.ts on the site).
package listingread

import "github.com/civitai/civitai/apps/app-index-go/internal/store"

// NsfwLevel bits (src/server/common/enums.ts NsfwLevel).
const (
	levelPG   int64 = 1
	levelPG13 int64 = 2
	levelR    int64 = 4
	levelX    int64 = 8
	levelXXX  int64 = 16
)

// The browsing-level flags of src/shared/constants/browsingLevel.constants.ts.
const (
	// publicLevels is publicBrowsingLevelsFlag: PG.
	publicLevels = levelPG
	// sfwLevels is sfwBrowsingLevelsFlag: PG and PG-13.
	sfwLevels = levelPG | levelPG13
	// allLevels is allBrowsingLevelsFlag: PG to XXX, no Blocked bit.
	allLevels = levelPG | levelPG13 | levelR | levelX | levelXXX
)

// browsingLevels is browsingLevels, ascending.
var browsingLevels = []int64{levelPG, levelPG13, levelR, levelX, levelXXX}

// contentRatingLevel is orchestratorNsfwLevelMap: case-sensitive, as the site's lookup is.
var contentRatingLevel = map[string]int64{"pg": levelPG, "pg13": levelPG13, "pg-13": levelPG13, "r": levelR, "x": levelX, "xxx": levelXXX}

// nsfwLevelFromContentRating mirrors nsfwLevelFromContentRating: the highest level a listing of
// this rating may carry. Empty (null), `g` and anything unknown are PG: never widened on
// ambiguity.
func nsfwLevelFromContentRating(rating string) int64 {
	if rating == "" || rating == "g" {
		return levelPG
	}
	if l, ok := contentRatingLevel[rating]; ok {
		return l
	}
	return levelPG
}

// Store visibility scopes (src/shared/utils/store-visibility-scope.ts).
const (
	ScopeFull           = "full"
	ScopePublicExternal = "public-external"
	ScopeNone           = "none"
)

// NarrowScope mirrors narrowStoreScope: anything that is not exactly one of the three scopes is
// `none`, so an uninterpretable value admits nothing.
func NarrowScope(s string) string {
	switch s {
	case ScopeFull, ScopePublicExternal, ScopeNone:
		return s
	}
	return ScopeNone
}

// scopeAdmitsKind mirrors scopeAdmitsListingKind / listingPublicVisibilityFilter: `full` admits
// every kind, `public-external` off-site only, `none` nothing. scope must be narrowed.
func scopeAdmitsKind(scope, kind string) bool {
	switch scope {
	case ScopeFull:
		return true
	case ScopePublicExternal:
		return kind == "offsite"
	}
	return false
}

// matureRatingsAllowed mirrors matureRatingsAllowed (app-listing-store-gate.ts): none off a
// red-capable host; on one, each of R, X and XXX when the viewer's level includes its bit. Its
// rating rule (matureRatingAllowed) is store.Mature.Admits, the one search applies too.
func matureRatingsAllowed(redCapable bool, browsingLevel int64) store.Mature {
	if !redCapable {
		return store.Mature{}
	}
	level := browsingLevel & allLevels // onlySelectableLevels
	return store.Mature{R: level&levelR != 0, X: level&levelX != 0, XXX: level&levelXXX != 0}
}

// listingMediaCeiling mirrors listingMediaCeiling: SFW ∩ the levels up to the listing's rating,
// lifted on a red-capable host by redHostMediaCeiling.
func listingMediaCeiling(v Viewer, contentRating string) int64 {
	ratingMax := nsfwLevelFromContentRating(contentRating)
	var ratingLevels int64
	for _, l := range browsingLevels {
		if l <= ratingMax {
			ratingLevels |= l
		}
	}
	return redHostMediaCeiling(v, sfwLevels&ratingLevels)
}

// redHostMediaCeiling mirrors redHostMediaCeiling: off a red-capable host, nonRedCeiling; on one,
// nonRedCeiling united with the viewer's levels, Blocked excluded. A viewer level of 0 or below is
// the public floor (`viewerBrowsingLevel || null` → effectiveBrowsingCeiling's PG), which adds
// nothing the non-red ceiling does not already hold.
func redHostMediaCeiling(v Viewer, nonRedCeiling int64) int64 {
	if !v.RedCapable {
		return nonRedCeiling
	}
	viewer := v.BrowsingLevel
	if viewer <= 0 {
		viewer = publicLevels
	}
	return (nonRedCeiling | (allLevels & viewer)) & allLevels
}

// visibleAt mirrors isLevelWithinCeiling for an item the adapter already passed through the
// moderation check (isListingImageVisible at every level): a rated item shows when a bit of it is
// inside the ceiling. A stored item's level is exactly one rating's bit (ListingFromEntity), never 0.
func visibleAt(nsfwLevel, ceiling int64) bool {
	return nsfwLevel == 0 || nsfwLevel&ceiling != 0
}
