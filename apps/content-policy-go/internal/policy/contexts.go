package policy

// The caller contexts. Each one is a surface that decides SFW / NSFW and region today, with the rules
// it decides by (Contexts). The values are this service's `context` metric label values, and the
// ports manifest's metricEndpoint names one (Endpoints, internal/metrics).
const (
	// ContextRegistrySubscription is the registry adapter's subscription (src/server/registry-adapter:
	// describeRegion in request-origin.ts, audienceForUser / audienceAdmits in audience.ts).
	ContextRegistrySubscription = "registry-subscription"
	// ContextSite is the site's request: the `canViewNsfw` feature (feature-flags.service.ts), the
	// level getServerBrowsingLevel gives it, and the `/apps` store's rating gate on that level
	// (matureRatingsAllowed on a red-capable host).
	ContextSite = "site"
	// ContextPublicAPI is the public REST API v1 (apiBrowsingLevel; the 451 of api-request-policy.ts).
	ContextPublicAPI = "public-api"
)

// Each named rule below is one place where today's callers disagree. A context's Rules pick one
// value per rule, so a caller keeps its own behaviour and the disagreement is written down instead of
// resolved silently. DESIGN.md lists each one with the code it comes from.
type (
	// UnknownCountryRule is what a request whose country cannot be told gets.
	UnknownCountryRule string
	// BlockedRegionRule is what a request from a blocked region (REGION_BLOCK_CONFIG) gets.
	BlockedRegionRule string
	// LevelRule is where the browsing level comes from.
	LevelRule string
	// NsfwHostRule is whether the host can turn mature content off (the site's `canViewNsfw`).
	NsfwHostRule string
	// RatingSurfaceRule is when the surface may show mature ratings at all (the store's red-capable
	// host).
	RatingSurfaceRule string
	// UnknownRatingRule is how a rating outside the ladder is admitted.
	UnknownRatingRule string
)

const (
	// UnknownCountryHold holds it to SFW: no cf-ipcountry, an empty one, XX, T1, or anything that is not
	// two letters after trimming (the registry adapter: a missing header cannot mean unrestricted).
	UnknownCountryHold UnknownCountryRule = "hold"
	// UnknownCountryUnrestricted judges it by the region lists alone, which name no such country, so it
	// is never held (the site and the public API).
	UnknownCountryUnrestricted UnknownCountryRule = "unrestricted"

	// BlockedRegionHold holds it to SFW (the registry adapter: its protocol has no "not served in your
	// region" error).
	BlockedRegionHold BlockedRegionRule = "hold"
	// BlockedRegionRefuse refuses it: nothing is served (the site's block page and the API's 451).
	BlockedRegionRefuse BlockedRegionRule = "refuse"

	// LevelViewer is getServerBrowsingLevel: the user's saved level when they show mature content and
	// it is not 0, else PG; held to PG / PG+PG-13 (anonymous / signed in) where mature content is off.
	LevelViewer LevelRule = "viewer"
	// LevelAPI is apiBrowsingLevel: every level, or PG+PG-13 in a held region. The user is not read.
	LevelAPI LevelRule = "api"

	// NsfwHostIgnored: the surface is mature-capable whatever the host (the registry).
	NsfwHostIgnored NsfwHostRule = "ignored"
	// NsfwHostColor: the `canViewNsfw` feature's `blue`/`red` availability. A request with no host
	// passes (hasFeature skips the server check when there is no host); an unknown host does not.
	NsfwHostColor NsfwHostRule = "color"

	// RatingSurfaceUnlessHeld: mature ratings unless the region is held (the registry applies the SFW
	// domain's rule to a held request).
	RatingSurfaceUnlessHeld RatingSurfaceRule = "unless-held"
	// RatingSurfaceRedHost: mature ratings only on a red host (isRedCapableHost).
	RatingSurfaceRedHost RatingSurfaceRule = "red-host"
	// RatingSurfaceAlways: the level alone decides (the public API has no host rule).
	RatingSurfaceAlways RatingSurfaceRule = "always"

	// UnknownRatingClosed admits each rating the registry knows (registryKnownRatings: the ladder plus
	// `xxx`) by its own level bit, and any other rating (null, empty, unknown) only to a viewer who may
	// read every mature rating, R, X and XXX (audienceAdmits).
	UnknownRatingClosed UnknownRatingRule = "closed"
	// UnknownRatingOpen admits a rating that is not mature to everyone, and `xxx` by the level's XXX
	// bit (matureRatingAllowed).
	UnknownRatingOpen UnknownRatingRule = "open"
)

// Rules is one context's choice for each rule, plus whether a moderator skips the region
// restriction (the feature-flag service lets a moderator past `nonRestricted`; the adapter does not).
type Rules struct {
	UnknownCountry  UnknownCountryRule `json:"unknownCountry"`
	BlockedRegion   BlockedRegionRule  `json:"blockedRegion"`
	Level           LevelRule          `json:"level"`
	NsfwHost        NsfwHostRule       `json:"nsfwHost"`
	RatingSurface   RatingSurfaceRule  `json:"ratingSurface"`
	UnknownRating   UnknownRatingRule  `json:"unknownRating"`
	ModeratorBypass bool               `json:"moderatorBypass"`
}

// Contexts is every context and its rules.
var Contexts = map[string]Rules{
	ContextRegistrySubscription: {
		UnknownCountry: UnknownCountryHold,
		BlockedRegion:  BlockedRegionHold,
		Level:          LevelViewer,
		NsfwHost:       NsfwHostIgnored,
		RatingSurface:  RatingSurfaceUnlessHeld,
		UnknownRating:  UnknownRatingClosed,
	},
	ContextSite: {
		UnknownCountry:  UnknownCountryUnrestricted,
		BlockedRegion:   BlockedRegionRefuse,
		Level:           LevelViewer,
		NsfwHost:        NsfwHostColor,
		RatingSurface:   RatingSurfaceRedHost,
		UnknownRating:   UnknownRatingOpen,
		ModeratorBypass: true,
	},
	ContextPublicAPI: {
		UnknownCountry: UnknownCountryUnrestricted,
		BlockedRegion:  BlockedRegionRefuse,
		Level:          LevelAPI,
		NsfwHost:       NsfwHostIgnored,
		RatingSurface:  RatingSurfaceAlways,
		UnknownRating:  UnknownRatingOpen,
	},
}

// ContextNames is every context, in a fixed order.
var ContextNames = []string{ContextRegistrySubscription, ContextSite, ContextPublicAPI}

// ReadsUser reports whether a context's decision depends on who is asking, so a caller's user id
// needs a settings lookup.
func ReadsUser(context string) bool {
	r, ok := Contexts[context]
	return ok && r.Level == LevelViewer
}
