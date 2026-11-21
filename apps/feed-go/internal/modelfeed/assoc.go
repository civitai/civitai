package modelfeed

import (
	"context"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The shadow port of the tRPC procedure `model.getAssociatedResourcesCardData` (a model page's
// Suggested Resources): src/server/routers/model.router.ts (publicProcedure, input
// getAssociatedResourcesSchema, the associationSourceVisible middleware) →
// getAssociatedResourcesCardDataHandler (src/server/controllers/model.controller.ts) → getModelsRaw,
// getImagesForModelVersion, resolveCanGenerateForVersions and the hidden-user caches. It shares
// model.getAll's page query, row transform, hydration, showcase hold, viewer image filter, metric
// privacy and wire head; what differs is here. DESIGN.md §17.

// assocModelCap is getModelsRaw's `take ?? 100` with no take: the handler passes none, so the query
// reads at most 101 rows and pops none. More distinct model ids than this is not ported.
const assocModelCap = 100

// explicitCoveredVersionIDs is explicitCoveredModelVersionIds (generation.service.ts): the versions
// of fluxUltraAir and ponyV7Air (src/shared/constants/generation.constants.ts), which
// getResourceCanGenerate counts as covered whatever their coverage row says.
var explicitCoveredVersionIDs = map[int]bool{1088507: true, 2152373: true}

// AssocDeps are the procedure's collaborators: model.getAll's (the replica, the cache readers, the
// gallery settings, the addons, the coverage flag mirror) plus its own.
type AssocDeps struct {
	*Deps
	// Prefs reads the viewer's hidden and blocked users; nil = every request falls back.
	Prefs HiddenPrefs
	// Gates reads the generation gate rules; nil = a request with a card that could generate falls back.
	Gates GateRuleSource
	// Promotions mirrors the `creator-promotions` flag's audience (FEED_GO_CREATOR_PROMOTIONS).
	Promotions feed.PromotionAudience
}

// AssocRequest is one call.
type AssocRequest struct {
	Input *AssocInput
	// Viewer is the session user; nil signed out.
	Viewer *Viewer
	// Banned is a banned user's session (Viewer is then nil).
	Banned bool
	// Cap is the domain cap (browsing.DomainCap); 0 = uncapped.
	Cap int
}

// AssocAnswer is one computed answer: the array the handler returns.
type AssocAnswer struct {
	Value []any
	// Trivial: no model row was loaded.
	Trivial bool
	// ViewerClass is the sample's viewer class (one of ViewerClasses).
	ViewerClass string
}

// The viewer classes an answer reports, a fixed set (a metric label): signed out, a moderator, the
// source model's owner, any other signed-in viewer. The shadow sampler skips batched calls, which a
// signed-in browser makes when tRPC batching is on for it, so the serve gate reads samples per class
// (DESIGN.md §17.3).
const (
	ViewerAnon      = "anon"
	ViewerUser      = "user"
	ViewerOwner     = "owner"
	ViewerModerator = "moderator"
)

// ViewerClasses is every viewer class, in a fixed order.
var ViewerClasses = []string{ViewerAnon, ViewerUser, ViewerOwner, ViewerModerator}

// viewerClass is the class of viewer for a source owned by sourceOwner (0 = unknown or no row).
func viewerClass(viewer *Viewer, sourceOwner int) string {
	switch {
	case viewer == nil || viewer.ID == 0:
		return ViewerAnon
	case viewer.IsModerator:
		return ViewerModerator
	case viewer.ID == sourceOwner:
		return ViewerOwner
	}
	return ViewerUser
}

// assocLevel is the model input's browsingLevel: stripBlockedForNonModerator and the domain clamp of
// applyDomainFeature on the raw input, then the schema's default (allBrowsingLevelsFlag) when it is
// still absent. The handler never resolves a saved level.
func assocLevel(in *AssocInput, isMod bool, cap int) int {
	var lv *int
	if in.BrowsingLevel != nil {
		v := *in.BrowsingLevel
		if !isMod {
			v &= table.Levels.All // selectableOrInvalid: onlySelectableLevels
		}
		lv = &v
	}
	if cap != 0 {
		req := 0
		if lv != nil {
			req = *lv
		}
		v := browsing.ClampToCap(req, cap)
		lv = &v
	}
	if lv == nil {
		return table.Levels.All
	}
	return *lv
}

// ServeAssociated is getAssociatedResourcesCardDataHandler, behind the associationSourceVisible
// middleware, for the ported subset: model associations with no article among them, no live
// promotion on the source model, and the cards' generation state decidable here.
func ServeAssociated(ctx context.Context, d *AssocDeps, req AssocRequest) (*AssocAnswer, error) {
	if d == nil || d.Deps == nil {
		return nil, fallback.New("model-assoc-unconfigured")
	}
	if req.Banned {
		// Node's context keeps a banned user for the hidden-user reads and the promotion flag; not ported.
		return nil, fallback.New("model-assoc-banned-session")
	}
	in := req.Input
	viewer := req.Viewer
	viewerID, isMod := 0, false
	if viewer != nil {
		viewerID, isMod = viewer.ID, viewer.IsModerator
	}
	// modelVisibleToViewer: a POI source model is its owner's and moderators' (canViewPoiModel); any
	// other viewer is answered NOT_FOUND, which the sampler never mirrors.
	sourceOwner := 0
	if in.FromID != 0 && !isMod {
		poi, owner, found, err := sourceModel(ctx, d.DB, in.FromID)
		if err != nil {
			return nil, err
		}
		if found && poi && (viewerID <= 0 || viewerID != owner) {
			return nil, fallback.New("model-assoc-source-hidden")
		}
		if found {
			sourceOwner = owner
		}
	}
	class := viewerClass(viewer, sourceOwner)
	level := assocLevel(in, isMod, req.Cap)
	targets, err := associationTargets(ctx, d.DB, in.FromID, in.Type)
	if err != nil {
		return nil, err
	}
	// getSponsoredModel takes the second slot with a paid run (chosen at random between overlapping
	// runs): not ported. With the flag known off for this viewer there is none; otherwise any approved
	// run on the source model within the longest run length falls back, live or not.
	if in.Type == AssociationSuggested {
		var fv *feed.Viewer
		if viewer != nil {
			fv = &feed.Viewer{ID: viewer.ID, IsModerator: viewer.IsModerator}
		}
		if on, known := d.Promotions.For(fv, false); on || !known {
			now := time.Now()
			if d.Now != nil {
				now = d.Now()
			}
			n, err := approvedModelPromotions(ctx, d.DB, in.FromID, now.Add(-feed.MaxPromotionRun))
			if err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, fallback.Safef("model-assoc-sponsored", "%d approved runs", n)
			}
		}
	}
	if len(targets) == 0 {
		return &AssocAnswer{Value: []any{}, Trivial: true, ViewerClass: class}, nil
	}
	// `toModelId ? model : article`: a falsy model id is an article card (getArticles), not ported.
	order := make([]int, 0, len(targets))
	ids := make([]int, 0, len(targets))
	seen := map[int]bool{}
	for _, t := range targets {
		if t.ToModelID == nil || *t.ToModelID == 0 {
			return nil, fallback.New("model-assoc-articles")
		}
		order = append(order, *t.ToModelID)
		if !seen[*t.ToModelID] {
			seen[*t.ToModelID] = true
			ids = append(ids, *t.ToModelID)
		}
	}
	if len(ids) > assocModelCap {
		return nil, fallback.Safef("model-assoc-many", "%d models", len(ids))
	}
	cards, loaded, err := assocCards(ctx, d, ids, level, viewer)
	if err != nil {
		return nil, err
	}
	out := []any{}
	if len(cards) > 0 {
		// HiddenUsers, BlockedByUsers and BlockedUsers.getCached({ userId: ctx.user?.id }): signed out,
		// the default user id -1.
		if d.Prefs == nil {
			return nil, fallback.New("model-assoc-hidden-prefs-unconfigured")
		}
		prefsID := -1
		if viewer != nil {
			prefsID = viewer.ID
		}
		excluded, ok, err := d.Prefs.HiddenUserIDs(ctx, prefsID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fallback.New("model-assoc-hidden-prefs-miss")
		}
		hiddenOwner := map[int]bool{}
		for _, id := range excluded {
			hiddenOwner[id] = true
		}
		// The answer is the association order, one card per association (a repeated id repeats it).
		shown := make([]*assocCard, 0, len(order))
		for _, id := range order {
			c, ok := cards[id]
			if !ok || hiddenOwner[c.it.row.UserID] {
				continue
			}
			shown = append(shown, c)
		}
		if err := resolveCanGenerate(ctx, d, shown, viewer); err != nil {
			return nil, err
		}
		for _, c := range shown {
			out = append(out, c.wire())
		}
	}
	return &AssocAnswer{Value: out, Trivial: !loaded, ViewerClass: class}, nil
}

// assocCard is one completed model card (getAssociatedResourcesCardDataHandler's completeModels).
type assocCard struct {
	it          *feedItem
	hidden      [3]bool
	images      []map[string]any
	canGenerate bool
}

// assocCards is getModelsRaw over the associated ids, the shown versions' images and the completed
// cards by model id; loaded reports whether the page query returned a row.
func assocCards(ctx context.Context, d *AssocDeps, ids []int, level int, viewer *Viewer) (map[int]*assocCard, bool, error) {
	viewerID, isMod := 0, false
	if viewer != nil {
		viewerID, isMod = viewer.ID, viewer.IsModerator
	}
	// getAllModelsSchema.parse({ browsingLevel, ids, period: AllTime }): the default sort, no take, no
	// cursor, nothing else; enforceBlockedBrowsingTagsForModels then resolves the addons onto it (no
	// tag filter, no username: the tag exclusions apply). The input object is the handler's own
	// `modelInput`, so the image read below sees the resolved exclusions too.
	in := &Input{}
	raw := resolveAddons(in, level, d.Addons(ctx), viewer)
	q := PageQuery{
		Take: assocModelCap, Sort: SortHighestRated, BrowsingLevel: level, ViewerID: viewerID, IsModerator: isMod,
		DisablePoi: raw.disablePoi, DisableMinor: raw.disableMinor, ExcludedTagIDs: raw.excluded,
		OnlyModelIDs: ids,
	}
	stmt, err := q.Build()
	if err != nil {
		return nil, false, err
	}
	pgRows, err := d.DB.Query(ctx, stmt.Text, stmt.Args...)
	if err != nil {
		return nil, false, err
	}
	rows, err := scanModelRows(pgRows)
	if err != nil {
		return nil, false, err
	}
	cards := map[int]*assocCard{}
	if len(rows) == 0 {
		return cards, false, nil
	}
	modelIDs := make([]int, len(rows))
	ownerIDs := make([]int, len(rows))
	for i := range rows {
		modelIDs[i], ownerIDs[i] = rows[i].ID, rows[i].UserID
	}
	var (
		hy    *hydrate.ModelPage
		gates map[int]*paidGate
	)
	g, gctx := errgroup.WithContext(ctx)
	// No `include`: no model frames or event hats on these cards (no decoration read is asked for).
	g.Go(safe.Go(func() (err error) {
		hy, err = d.Sources.ModelPage(gctx, hydrate.ModelPageRequest{OwnerIDs: ownerIDs, ModelIDs: modelIDs})
		return
	}))
	g.Go(safe.Go(func() (err error) { gates, err = paidAccessGates(gctx, d.DB, modelIDs); return }))
	if err := g.Wait(); err != nil {
		return nil, true, err
	}
	showSfwFace := level != 0 && level&table.Levels.NSFW == 0
	// `ids` is set, so hidePrivateModels is off: Private versions are listed.
	items := make([]*feedItem, 0, len(rows))
	for i := range rows {
		if it := buildFeedItem(&rows[i], in, raw, hy, gates, showSfwFace, false); it != nil {
			// getModelsRaw without `include: ['cosmetics']`: `cosmetics[id] ?? null` over {} and
			// `eventDecorations?.[id] ?? null` over undefined.
			it.cosmetic, it.decoration = nil, nil
			items = append(items, it)
		}
	}
	if len(items) == 0 {
		return cards, true, nil
	}
	// getImagesForModelVersion over every item's shown version, the withheld ones included.
	versionIDs := make([]int, len(items))
	for i, it := range items {
		versionIDs[i] = it.versionID
	}
	images, err := assocImages(ctx, d.DB, assocImageQuery{
		VersionIDs: versionIDs, ViewerID: viewerID, IsModerator: isMod, Level: level, ExcludedTagIDs: raw.excluded,
	})
	if err != nil {
		return nil, true, err
	}
	// associatedCardImages: held to a minor or SFW-only model's gallery level except for the viewer's
	// own models (moderators exempt), then filterImagesForViewer at every level with the resolved poi
	// and minor switches. The hold reads the gallery settings only when there are images to hold.
	if !isMod && len(images) > 0 {
		levels, err := showcaseHeldLevels(ctx, d.Gallery, items)
		if err != nil {
			return nil, true, err
		}
		images = holdForViewer(images, items, levels, viewerID)
	}
	// Metric privacy: the owners' defaults (read with the page), then the memberships of the owners a
	// viewer would see something hidden for, over every item.
	var candidates []int
	for _, it := range items {
		owner := it.row.UserID
		if isMod || owner == viewerID {
			continue
		}
		def := hy.PrivacyDefaults[owner]
		if it.privacy.anyHidden() || def.Buzz || def.Downloads || def.Generations {
			candidates = append(candidates, owner)
		}
	}
	memberships := map[int]bool{}
	if len(candidates) > 0 {
		if memberships, err = d.Sources.CreatorMemberships(ctx, candidates); err != nil {
			return nil, true, err
		}
	}
	for _, it := range items {
		shown := filterImagesForViewer(images[it.versionID], table.Levels.All, false, raw.disablePoi, raw.disableMinor, viewer)
		// showImageless needs `user || username`, which this input never has: an imageless card is dropped.
		if len(shown) == 0 {
			continue
		}
		if it.withheld() {
			shown = nil
		}
		isOwner := isMod || (viewer != nil && it.row.UserID == viewerID)
		cards[it.row.ID] = &assocCard{
			it:     it,
			hidden: hidden(it.privacy, hy.PrivacyDefaults[it.row.UserID], isOwner, memberships[it.row.UserID]),
			images: shown,
		}
	}
	return cards, true, nil
}

// resolveCanGenerate is resolveCanGenerateForVersions for the shown cards (the cards it drops change
// nothing on the wire): getResourceCanGenerate && isGenerationEligible per first version, then the
// hidden gate rules over the versions that would generate. A Wildcards card (its own gate: a visible
// System wildcard set) falls back.
func resolveCanGenerate(ctx context.Context, d *AssocDeps, cards []*assocCard, viewer *Viewer) error {
	candidates := map[int]bool{}
	for _, c := range cards {
		if c.it.row.Type == "Wildcards" {
			return fallback.New("model-assoc-wildcards")
		}
		ok := assocBaseCanGenerate(c.it, viewer, d.Config.CoverageNext)
		c.canGenerate = ok
		if ok {
			candidates[c.it.versionID] = true
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	if d.Gates == nil {
		return fallback.New("gate-rules-unconfigured")
	}
	rules, err := d.Gates.GateRules(ctx)
	if err != nil {
		return err
	}
	blocked, err := hiddenGateVersions(rules, viewer, candidates)
	if err != nil {
		return err
	}
	for _, c := range cards {
		if c.canGenerate && blocked[c.it.versionID] {
			c.canGenerate = false
		}
	}
	return nil
}

// assocBaseCanGenerate is getResourceCanGenerate (without its gate rules) && isGenerationEligible for
// a card's version, over coveragePair(version, next): `covered` is the next column with the flag on,
// `coveredLive` always the live one. The version is Published (getModelsRaw keeps no other), so the
// status test always passes; usageControl and the generation alias are not passed by the handler.
func assocBaseCanGenerate(it *feedItem, viewer *Viewer, next bool) bool {
	v := it.version
	coveredLive, _ := recField(v, "covered").(bool)
	covered := coveredLive
	if next {
		covered, _ = recField(v, "coveredNext").(bool)
	}
	bm, _ := recField(v, "baseModel").(string)
	rawFlags, _ := hydrate.Int(recField(v, "flags"))
	flags := toPublicAPIVersionFlags(rawFlags)
	if !isGenerationEligible(covered, coveredLive, bm, it.row.Type, flags) {
		return false
	}
	if !covered && !explicitCoveredVersionIDs[it.versionID] {
		// A model-locked checkpoint eligible on its live column alone.
		return false
	}
	// isBaseModelGenerationDisabled: a disabled base model, or any disabled generation override on it
	// (`.some`), which isGenerationEligible's first-override read does not always see.
	if generationOff[bm] {
		return false
	}
	availability, _ := v["availability"].(string)
	isMod := viewer != nil && viewer.IsModerator
	owned := viewer != nil && viewer.ID != 0 && viewer.ID == it.row.UserID
	return availability != "Private" || owned || isMod
}

// wire is the card as the handler returns it: `{ resourceType: 'model', ...model, sponsored }` where
// model is getModelsRaw's item without hashes, modelVersions, rank, tagsOnModels and metricPrivacy,
// then tags, hashes, hiddenMetrics, rank, images, canGenerate, version. The head and the shared
// fields are model.getAll's (feedItem.wire).
func (c *assocCard) wire() superjson.Object {
	base := c.it.wire(c.hidden, nil)
	obj := make(superjson.Object, 0, len(base)+3)
	obj = append(obj, superjson.Field{Key: "resourceType", Val: "model"})
	for _, f := range base {
		if f.Key == "tags" {
			break
		}
		obj = append(obj, f)
	}
	get := func(k string) any {
		v, _ := base.Get(k)
		return v
	}
	images := make([]any, len(c.images))
	for i, img := range c.images {
		images[i] = assocImageWire(img)
	}
	return append(obj,
		superjson.Field{Key: "tags", Val: get("tags")},
		superjson.Field{Key: "hashes", Val: get("hashes")},
		superjson.Field{Key: "hiddenMetrics", Val: get("hiddenMetrics")},
		superjson.Field{Key: "rank", Val: get("rank")},
		superjson.Field{Key: "images", Val: images},
		superjson.Field{Key: "canGenerate", Val: c.canGenerate},
		superjson.Field{Key: "version", Val: get("version")},
		superjson.Field{Key: "sponsored", Val: false},
	)
}
