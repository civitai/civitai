package beacon

import "regexp"

// The arms of trackActionSchema (src/server/schema/track.schema.ts), and the constants they import.
//
// 🔴 Every list here is a COPY. testdata/golden/gen.ts writes the Node values into vectors.json
// (`trackBatch`), TestTrackBatchConstants pins these copies against them, and
// src/server/beacon/__tests__/beacon-go-track-batch-vectors.test.ts pins vectors.json against the live
// Node constants, so changing one on the Node side fails that test until gen.ts is re-run and this
// file follows. Between a Node deploy and a beacon-go release a value Node has ADDED is rejected
// here, which falls the batch back to Node (nothing is lost); a value Node has REMOVED is still
// accepted here, which the shadow comparison reports as a mismatched write.

// trackedReasons (src/utils/login-helpers.ts).
var trackedReasons = []string{"image-gen", "train-model", "blur-toggle"}

// USER_MENU_ITEM_IDS (src/shared/constants/user-menu.constants.ts).
var userMenuItemIDs = []string{
	"profile", "inventory", "prizes", "my-shop", "service-requests", "browse-services", "placements",
	"training", "collections", "liked-models", "bookmarked-articles", "bounties", "challenges",
	"browse-challenges", "crucibles", "buzz-dashboard", "creator-studio", "creator-journey", "vault",
	"referrals", "apps", "leaderboard", "auctions", "knights-of-new", "link-app", "following",
	"downloads", "getting-started", "civitai-link", "sign-in", "support-report-bug",
	"support-education", "support-faq", "support-discord", "support-assistant", "support-portal",
	"create-generate", "create-post-images", "create-post-videos", "create-model", "create-model3d",
	"create-train", "create-article", "create-comic", "create-bounty", "create-challenge",
}

// USER_MENU_GROUP_IDS and USER_MENU_HEADER_GROUP (src/shared/constants/user-menu-groups.constants.ts).
var (
	userMenuGroupIDs    = []string{"create", "your-stuff", "creator-tools", "rewards", "help"}
	userMenuHeaderGroup = "header"
)

// PUSH_PROMPT_ACTIONS, PUSH_PROMPT_SURFACES, PUSH_PROMPT_VARIANTS (track.schema.ts).
var (
	pushPromptActions  = []string{"shown", "enable_click", "not_now", "granted", "native_dismissed", "denied", "subscribed", "failed"}
	pushPromptSurfaces = []string{"visit-prompt", "settings-card", "deal-flow"}
	pushPromptVariants = []string{"new", "finish", "another-device"}
)

// EXPERIMENT_SURFACES, HAT_TURF_CLIENT_ACTIONS, HAT_TURF_EVENTS
// (src/shared/constants/experiments.constants.ts).
var (
	experimentSurfaces   = []string{"image-detail", "feed-card"}
	hatTurfClientActions = []string{"invite_view", "invite_dismiss", "hat_count_open", "feed_place_start", "feed_place_save", "hide_all_hats_on", "hide_all_hats_off"}
	hatTurfEvents        = []string{"birthday2026"}
)

// APP_STORE_ACTIONS, APP_STORE_LISTING_ID_RE, APP_STORE_POSITION_MAX, APP_STORE_QUERY_LENGTH_BUCKETS,
// APP_SURFACES (src/shared/utils/app-store-telemetry.ts); listingSortSchema
// (src/server/schema/blocks/app-listing-read.schema.ts); MARKETPLACE_CATEGORIES
// (src/server/services/blocks/marketplace-categories.constants.ts).
var (
	appStoreActions           = []string{"impression", "card_click", "detail_view", "cta_click"}
	appStoreListingIDPattern  = `^[A-Za-z0-9_-]{1,64}$`
	appStorePositionMax       = 10000.0
	appStoreQueryLengthBucket = []string{"0", "1-3", "4-10", "11-30", "31+"}
	appSurfaces               = []string{"store_card", "detail", "sub_listing", "made_with", "related", "direct"}
	listingSorts              = []string{"top-rated", "popular", "newest", "name"}
	marketplaceCategories     = []string{"generation", "games", "utility", "discovery", "moderation", "analytics", "other"}
)

// APP_SUBMIT_FAILURE_REASONS, APP_ERROR_STAGES, APP_SESSION_HOSTS, APP_TELEMETRY_APP_BLOCK_ID_RE,
// APP_SESSION_MAX_DURATION_MS, APP_SESSION_MAX_COUNT (src/shared/constants/app-telemetry.constants.ts).
var (
	appSubmitFailureReasons = []string{"validation", "prompt_refused", "ecosystem_unavailable", "insufficient_buzz", "rate_limited", "server_error", "other"}
	appErrorStages          = []string{"submit", "training_submit", "confirmed_step_submit"}
	appSessionHosts         = []string{"page", "iframe"}
	appBlockIDPattern       = `^[A-Za-z0-9_]{1,64}$`
	appSessionMaxDurationMs = 86400000.0
	appSessionMaxCount      = 1000000.0
)

// Generator_Submit's externalId pattern (track.schema.ts).
var generatorExternalIDPattern = `^[A-Za-z0-9_-]+$`

// Field constructors, named after the zod calls they stand for.
func num(name string) field     { return field{name: name, kind: kindNumber} }
func str(name string) field     { return field{name: name, kind: kindString} }
func boolean(name string) field { return field{name: name, kind: kindBool} }
func enum(name string, vals ...[]string) field {
	m := map[string]bool{}
	for _, vs := range vals {
		for _, v := range vs {
			m[v] = true
		}
	}
	return field{name: name, kind: kindEnum, enum: m}
}
func lit(vals ...string) []string { return vals }

// nonNegativeInt is z.number().int().min(0).max(max).
func nonNegativeInt(name string, max float64) field {
	zero := 0.0
	return field{name: name, kind: kindInt, min: &zero, max: &max}
}
func positiveInt(name string) field { return field{name: name, kind: kindInt, positive: true} }
func (f field) opt() field          { f.optional = true; return f }
func (f field) null() field         { f.nullable = true; return f }
func (f field) nullish() field      { f.optional, f.nullable = true, true; return f }
func (f field) trimmed() field      { f.trim = true; return f }
func (f field) maxLength(n int) field {
	f.maxLen = n
	return f
}
func (f field) pattern(p string) field {
	f.re = regexp.MustCompile(p)
	return f
}

func strip(fields ...field) *objectSpec { return &objectSpec{fields: fields} }
func loose(fields ...field) *objectSpec { return &objectSpec{fields: fields, passthrough: true} }

func optionalDetails(spec *objectSpec) actionArm {
	return actionArm{details: spec, detailsOptional: true}
}
func requiredDetails(spec *objectSpec) actionArm { return actionArm{details: spec} }
func (a actionArm) actorMetaFree() actionArm {
	a.skipActorMeta = true
	return a
}

// actionArms is trackActionSchema, by `type`. ACTOR_META_FREE_ACTION_TYPES (tracker.ts) are the arms
// marked actorMetaFree.
var actionArms = map[string]actionArm{
	"AddToBounty_Click":   {},
	"AddToBounty_Confirm": {},
	"AwardBounty_Click":   {},
	"AwardBounty_Confirm": {},
	"Tip_Click": optionalDetails(strip(
		num("toUserId"), num("entityId").nullish(), str("entityType").nullish())),
	"Tip_Confirm": optionalDetails(strip(
		num("toUserId"), num("entityId").nullish(), str("entityType").nullish(), num("amount"))),
	"TipInteractive_Click": optionalDetails(strip(
		num("toUserId"), num("entityId"), str("entityType"), num("amount"))),
	"TipInteractive_Cancel": optionalDetails(strip(
		num("toUserId"), num("entityId"), str("entityType"), num("amount"))),
	"NotEnoughFunds":       optionalDetails(strip(num("amount"))),
	"PurchaseFunds_Cancel": optionalDetails(strip(num("step"))),
	"PurchaseFunds_Confirm": optionalDetails(strip(
		str("priceId").opt(), num("buzzAmount"), num("unitAmount"), str("method"))),
	"LoginRedirect":        {top: []field{enum("reason", trackedReasons)}},
	"Membership_Cancel":    optionalDetails(loose(str("reason"), str("from"))),
	"Membership_Downgrade": optionalDetails(loose(str("reason"), str("from").opt(), str("to").opt())),
	"CSAM_Help_Triggered":  optionalDetails(loose(str("query").opt())),
	"ProfanitySearch": optionalDetails(loose(
		str("query").opt(), field{name: "matches", kind: kindStringArray, optional: true})),
	"Model_Create_Click": optionalDetails(strip(
		num("modelId").opt(), num("modelVersionId").opt(), str("source").opt())),
	"Image_Remix_Click": optionalDetails(strip(
		num("imageId"),
		enum("imageType", lit("image", "video", "audio")).opt(),
		num("sourceModelVersionId").nullish(),
		str("source").opt(),
		enum("remixKind", lit("edit", "video", "reuse")).opt())),
	"Generator_Submit": requiredDetails(strip(
		num("modelVersionId").nullish(),
		enum("fromAction", lit("create", "remix", "replay", "direct")),
		boolean("hasRemixOfId").opt(),
		enum("formVersion", lit("legacy", "new", "video", "form-graph")).opt(),
		boolean("isValid").opt(),
		boolean("isRateLimited").opt(),
		str("externalId").maxLength(128).pattern(generatorExternalIDPattern).opt())),
	"Feed_TagBar_Click": requiredDetails(strip(
		enum("feed", lit("images", "videos")),
		str("tag").trimmed().maxLength(64).null(),
		num("tagId").null(),
		enum("action", lit("select", "clear")))),
	"Announcement_Click": requiredDetails(strip(positiveInt("announcementId"), positiveInt("creatorId"))),
	"AppsBuild_Action": requiredDetails(strip(
		enum("action", lit("view", "request_access", "agent_prompt_copy", "create_entry")),
		enum("state", lit("pitch", "first-app", "workbench")))),
	"UserMenu_Click": requiredDetails(strip(
		enum("item", userMenuItemIDs),
		enum("group", userMenuGroupIDs, lit(userMenuHeaderGroup)).null(),
		boolean("pinned"),
		enum("surface", lit("desktop", "mobile")))),
	"Push_Prompt": requiredDetails(strip(
		enum("action", pushPromptActions),
		enum("surface", pushPromptSurfaces),
		enum("variant", pushPromptVariants),
		enum("platform", lit("desktop", "mobile")))),
	// Its `exp` is an experiment key and `variant` is refined against that experiment's variants
	// (isExperimentVariant): the experiment registry changes too often to copy, so it stays on Node.
	"Experiment_Exposure": {unported: true, skipActorMeta: true},
	"HatTurf_Action": requiredDetails(strip(
		enum("action", hatTurfClientActions),
		enum("event", hatTurfEvents),
		enum("surface", experimentSurfaces).opt())).actorMetaFree(),
	"AppStore_Action": requiredDetails(strip(
		enum("action", appStoreActions),
		str("listingId").pattern(appStoreListingIDPattern),
		enum("surface", appSurfaces),
		nonNegativeInt("position", appStorePositionMax).opt(),
		enum("sort", listingSorts).opt(),
		enum("category", marketplaceCategories).opt(),
		boolean("hasQuery").opt(),
		enum("queryLength", appStoreQueryLengthBucket).opt())).actorMetaFree(),
	"App_Error": requiredDetails(strip(
		str("appBlockId").pattern(appBlockIDPattern),
		enum("reason", appSubmitFailureReasons),
		enum("stage", appErrorStages))).actorMetaFree(),
	"App_Session": requiredDetails(strip(
		str("appBlockId").pattern(appBlockIDPattern),
		enum("host", appSessionHosts),
		nonNegativeInt("durationMs", appSessionMaxDurationMs),
		nonNegativeInt("submits", appSessionMaxCount),
		nonNegativeInt("messagesToHost", appSessionMaxCount))).actorMetaFree(),
}
