package modelfeed

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
)

// imagesPerModelSlim is GET_ALL_IMAGES_PER_MODEL_SLIM (src/server/utils/model-getall-images.ts):
// the slim cap production serves (getAllModelImagesSlim on). The flag-off 12-image cap is not ported.
const imagesPerModelSlim = 6

// maxLoops is getModelsFeed's page loop bound (`loopCount < 3`).
const maxLoops = 3

// Querier is the replica (a *pgxpool.Pool satisfies it).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Sources are the cache readers (implemented by *hydrate.Sources).
type Sources interface {
	ModelPage(ctx context.Context, req hydrate.ModelPageRequest) (*hydrate.ModelPage, error)
	VersionImages(ctx context.Context, versionIDs []int) (map[int][]superjson.Object, error)
	CreatorMemberships(ctx context.Context, userIDs []int) (map[int]bool, error)
	// CreatorMembershipsComputed is CreatorMemberships with its misses computed
	// (hydrate.Sources.CreatorMembershipsComputed), read only with Config.ServeMembershipMiss.
	CreatorMembershipsComputed(ctx context.Context, userIDs []int) (map[int]bool, error)
	UserIDByUsername(ctx context.Context, username string) (int, bool, error)
	// FollowedUserIDs is the ids the user follows, read from the replica (hydrate.Sources).
	FollowedUserIDs(ctx context.Context, userID int) ([]int, error)
	// OfficialModels is getOfficialModelIds (hydrate.Sources.OfficialModels).
	OfficialModels(ctx context.Context) ([]hydrate.OfficialModel, error)
}

// Gallery reads the cached gallery settings the showcase hold reads (implemented by
// *feed.GalleryStore).
type Gallery interface {
	SettingsMany(ctx context.Context, modelIDs []int) (map[int]*feed.GallerySettings, error)
}

// Config is the flags model.getAll reads, mirrored (DESIGN.md §15.3). Only the state production
// runs is ported: a mirror that reads off makes every request the `flag-off-state` fallback.
type Config struct {
	// BaseModelMetrics mirrors `base-model-feed-metrics` (on: the per-base-model metric tables back
	// a base-model filter).
	BaseModelMetrics bool
	// ImagesSlim mirrors the `getAllModelImagesSlim` feature (Flipt `get-all-model-images-slim`; on:
	// 6 images per model by the coverage slice).
	ImagesSlim bool
	// CoverageNext mirrors `generation-coverage-next`; LoadingOpenToAll mirrors
	// `generation-loading-open-to-all` (both on: canGenerate reads coveredNext, every viewer a member).
	CoverageNext     bool
	LoadingOpenToAll bool
	// VisibleDecorationEvents is FEED_GO_DECORATION_EVENTS (as the image feed reads it).
	VisibleDecorationEvents map[string]bool
	// Ports are the input shapes served behind their own switch (ParseWith), all off by default.
	Ports Ports
	// ServeUserCosmeticsMiss is FEED_GO_GETALL_SERVE_USER_COSMETICS_MISS (default off): compute an
	// owner's user-cosmetics miss (hydrate.ModelPageRequest.ComputeUserCosmetics) instead of the
	// `user-cosmetics-miss` fallback.
	ServeUserCosmeticsMiss bool
	// ServeMembershipMiss is FEED_GO_GETALL_SERVE_MEMBERSHIP_MISS (default off): compute an owner's
	// creator-membership miss (Sources.CreatorMembershipsComputed) instead of the `membership-miss`
	// fallback.
	ServeMembershipMiss bool
}

// Deps are model.getAll's collaborators.
type Deps struct {
	DB      Querier
	Sources Sources
	Gallery Gallery
	// Addons returns the browsing-settings addons (system redis, or the defaults).
	Addons func(context.Context) []browsing.Addon
	// Blocked is the blocked browsing tag list, shared with image.getInfinite (one memo, as in Node).
	Blocked *feed.BlockedTags
	Config  Config
	Now     func() time.Time
}

// Viewer is the session user; nil in a Request when signed out or banned.
type Viewer struct {
	ID          int
	Username    string
	IsModerator bool
}

// Request is one call.
type Request struct {
	Input  *Input
	Viewer *Viewer
	// Cap is the domain cap (browsing.DomainCap); 0 = uncapped.
	Cap int
}

// Answer is one computed answer.
type Answer struct {
	// Value is `{ items, nextCursor }` as getModelsFeed returns it.
	Value superjson.Object
	// Trivial: no model row was loaded (limit 0, a blocked tag, pages the query answered empty).
	Trivial bool
}

// Serve is getModelsInfiniteHandler for the supported subset, then getModelsFeed. The
// official-checkpoint pin (Hot with a base-model filter) leads the first page only; pinned items do
// not count towards `limit` and are excluded from every loop page, so a cursor never re-emits them.
func Serve(ctx context.Context, d *Deps, req Request) (*Answer, error) {
	in := req.Input
	level, err := resolveLevel(in, req)
	if err != nil {
		return nil, err
	}
	if c := d.Config; !c.BaseModelMetrics || !c.ImagesSlim || !c.CoverageNext || !c.LoadingOpenToAll {
		// A flag in the state production does not run: not ported (DESIGN.md §15.3).
		return nil, fallback.New("flag-off-state")
	}
	now := time.Now()
	if d.Now != nil {
		now = d.Now()
	}
	var pinnedIDs []int
	if in.Sort == SortHot && len(in.BaseModels) > 0 {
		official, err := d.Sources.OfficialModels(ctx)
		if err != nil {
			return nil, err
		}
		for _, m := range official {
			if m.Type == "Checkpoint" {
				pinnedIDs = append(pinnedIDs, m.ID)
			}
		}
	}
	var pinned []any
	loaded := false
	if len(pinnedIDs) > 0 && in.Cursor == "" {
		page, err := servePage(ctx, d, in, level, "", req.Viewer, now, pageScope{take: len(pinnedIDs), only: pinnedIDs})
		if err != nil {
			return nil, err
		}
		pinned, loaded = page.items, page.loaded
	}
	items := make([]any, 0, len(pinned)+in.Limit)
	var nextCursor any = superjson.Undefined{}
	cursor := in.Cursor
	var results []any
	for loop := 0; len(results) < in.Limit && loop < maxLoops; {
		page, err := servePage(ctx, d, in, level, cursor, req.Viewer, now, pageScope{take: in.Limit, exclude: pinnedIDs})
		if err != nil {
			return nil, err
		}
		results = append(results, page.items...)
		loaded = loaded || page.loaded
		if page.next == "" {
			break
		}
		cursor = page.next
		nextCursor = page.next
		loop++
	}
	items = append(append(items, pinned...), results...)
	return &Answer{
		Value:   superjson.Object{{Key: "items", Val: items}, {Key: "nextCursor", Val: nextCursor}},
		Trivial: !loaded,
	}, nil
}

// pageScope is what one getModelsWithImagesAndModelVersions call of getModelsFeed varies: its take
// (`limit`), and the pin's onlyModelIds / excludeModelIds.
type pageScope struct {
	take          int
	only, exclude []int
}

// resolveLevel is resolveRequestBrowsingLevels after applyDomainFeature: a signed-in caller with no
// level gets their saved one (not read here: falls back); a sent level is held to the viewer
// (stripBlockedForNonModerator), then the domain cap clamps it (an absent or disjoint level becomes
// the cap). Uncapped and absent is a verified crawler's request.
func resolveLevel(in *Input, req Request) (int, error) {
	if in.BrowsingLevel == nil {
		if req.Viewer != nil || req.Cap == 0 {
			return 0, fallback.New("model-level-absent")
		}
		return req.Cap, nil
	}
	level := browsing.ForViewer(*in.BrowsingLevel, req.Viewer != nil && req.Viewer.IsModerator)
	if req.Cap != 0 {
		return browsing.ClampToCap(level, req.Cap), nil
	}
	return level, nil
}

type page struct {
	items  []any
	next   string
	loaded bool
}

// modelRow is one row of the page query.
type modelRow struct {
	ID              int
	Name            string
	SfwName         *string
	CoverImageID    *int
	SfwCoverImageID *int
	Type            string
	Minor           bool
	SfwOnly         bool
	Poi             bool
	Nsfw            bool
	NsfwLevel       int
	Status          string
	CreatedAt       time.Time
	LastVersionAt   *time.Time
	PublishedAt     *time.Time
	Locked          bool
	Meta            []byte
	Mode            *string
	Availability    string
	Rank            []byte
	UserID          int
	CursorID        *string
}

func scanModelRows(rows pgx.Rows) ([]modelRow, error) {
	defer rows.Close()
	var out []modelRow
	for rows.Next() {
		var r modelRow
		if err := rows.Scan(&r.ID, &r.Name, &r.SfwName, &r.CoverImageID, &r.SfwCoverImageID, &r.Type, &r.Minor,
			&r.SfwOnly, &r.Poi, &r.Nsfw, &r.NsfwLevel, &r.Status, &r.CreatedAt, &r.LastVersionAt, &r.PublishedAt,
			&r.Locked, &r.Meta, &r.Mode, &r.Availability, &r.Rank, &r.UserID, &r.CursorID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// feedItem is one getModelsRaw item, before getModelsWithImagesAndModelVersions maps it.
type feedItem struct {
	row        *modelRow
	name       string // the face's name
	hasSfwFace bool
	// showSfwFace is whether this request shows .com faces (showsSfwFace of its level).
	showSfwFace bool
	// version is the one version the card shows (getModelsRaw keeps the first without `details`), in
	// the cached record's key order.
	version   superjson.Object
	versionID int
	// baseModels is the distinct base models of the visible versions.
	baseModels []any
	hashes     []any
	tagIDs     []int
	user       superjson.Object
	cosmetic   any
	decoration any
	gate       *paidGate
	privacy    metaPrivacy
}

type paidGate struct {
	deadline *time.Time
	// versionIDs are the model's versions behind a live gate (getModelPaidAccessGates' versionIds).
	versionIDs []int
}

// rawInput is getModelsRaw's view of the input after enforceBlockedBrowsingTagsForModels.
type rawInput struct {
	disablePoi, disableMinor bool
	// excluded is the resolved excludedTagIds; nil when the input has none and the addons add none
	// (the image filter tests the list for presence, the SQL for length).
	excluded []int
}

// servePage is one getModelsWithImagesAndModelVersions call.
func servePage(ctx context.Context, d *Deps, in *Input, level int, cursor string, viewer *Viewer, now time.Time, scope pageScope) (*page, error) {
	viewerID, isMod := 0, false
	if viewer != nil {
		viewerID, isMod = viewer.ID, viewer.IsModerator
	}
	// enforceBlockedBrowsingTagsForModels: a blocked tag name is an empty page; then the addons.
	if in.Tag != "" {
		if d.Blocked == nil {
			return nil, fallback.New("blocked-tags-unconfigured")
		}
		blocked, err := d.Blocked.Names(ctx)
		if err != nil {
			return nil, err
		}
		if blocked[strings.ToLower(in.Tag)] {
			return &page{items: []any{}}, nil
		}
	}
	raw := resolveAddons(in, level, d.Addons(ctx), viewer)

	tagID := 0
	if in.Tag != "" {
		// A name no tag has is 0: no filter.
		id, _, err := hydrate.TagIDByName(ctx, d.DB, in.Tag)
		if err != nil {
			return nil, err
		}
		tagID = id
	}
	targetUserID := 0
	if name := in.creatorName(); name != "" {
		id, found, err := d.Sources.UserIDByUsername(ctx, name)
		if err != nil {
			return nil, err
		}
		if !found {
			// Node reads the primary next, and answers 404 for a name neither holds.
			return nil, fallback.New("model-username-miss")
		}
		targetUserID = id
	}
	var follows []int
	followed := in.Followed && viewerID != 0
	if followed {
		// `followed && sessionUser?.id`: the viewer's Follow rows on the replica (Node's dbRead read),
		// after the creator lookup, as Node orders them.
		var err error
		if follows, err = d.Sources.FollowedUserIDs(ctx, viewerID); err != nil {
			return nil, err
		}
	}
	if in.CollectionID != 0 {
		// Node checks the collection after the tag/creator lookups (an unknown creator stays a 404)
		// and before parsing the cursor, on every page of its loop.
		read, err := collectionReadable(ctx, d.DB, in.CollectionID, viewerID)
		if err != nil {
			return nil, err
		}
		if !read {
			return &page{items: []any{}}, nil
		}
	}
	// `!ids && !username && !user && !followed && !collectionId`: `ids` present at all, `[]` included,
	// and `followed` signed out too. The page query reads it under Hide Paid (PageQuery.HidePrivate),
	// the per-row transform for the versions it lists.
	hidePrivateModels := !in.HasIDs && in.Username == "" && in.User == "" && !in.Followed && in.CollectionID == 0
	q := PageQuery{
		Take: scope.take, Cursor: cursor, Sort: in.Sort, BrowsingLevel: level, ViewerID: viewerID,
		IsModerator: isMod, Archived: in.Archived, DisablePoi: raw.disablePoi, DisableMinor: raw.disableMinor,
		ExcludedTagIDs: raw.excluded, TagID: tagID, FromPlatform: in.FromPlatform, TargetUserID: targetUserID,
		Types: in.Types, BaseModels: in.BaseModels,
		CheckpointType: in.CheckpointType, AllowCommercialUse: in.AllowCommercialUse,
		AllowDerivatives: in.AllowDerivatives, AllowDifferentLicense: in.AllowDifferentLicense,
		AllowNoCredit: in.AllowNoCredit, EarlyAccess: in.EarlyAccess, PaidAccess: in.PaidAccess,
		HidePaid: in.HidePaid, HidePrivate: hidePrivateModels, OnSale: in.OnSale, ExcludedUserIDs: in.ExcludedUserIDs, FileFormats: in.FileFormats,
		CollectionID: in.CollectionID, CollectionTagID: in.CollectionTagID,
		OnlyModelIDs: scope.only, ExcludeModelIDs: scope.exclude,
		IDs: in.IDs, Followed: followed, FollowedUserIDs: follows,
	}
	if in.Period != "AllTime" && in.PeriodMode != "stats" {
		q.PeriodCutoff = decreaseDate(now, in.Period)
	}
	stmt, err := q.Build()
	if err != nil {
		return nil, err
	}
	pgRows, err := d.DB.Query(ctx, stmt.Text, stmt.Args...)
	if err != nil {
		return nil, err
	}
	rows, err := scanModelRows(pgRows)
	if err != nil {
		return nil, err
	}
	out := &page{loaded: len(rows) > 0}
	if len(rows) == 0 {
		out.items = []any{}
		return out, nil
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
	g.Go(safe.Go(func() (err error) {
		pctx, phase := tracing.StartPhase(gctx, tracing.PhaseHydrate)
		defer phase.End()
		phase.SetInt(tracing.AttrItems, len(modelIDs))
		hy, err = d.Sources.ModelPage(pctx, hydrate.ModelPageRequest{
			OwnerIDs: ownerIDs, ModelIDs: modelIDs, VisibleEvents: d.Config.VisibleDecorationEvents,
			ComputeUserCosmetics: d.Config.ServeUserCosmeticsMiss,
		})
		return
	}))
	g.Go(safe.Go(func() (err error) { gates, err = paidAccessGates(gctx, d.DB, modelIDs); return }))
	if err := g.Wait(); err != nil {
		return nil, err
	}
	// The lookahead row is the cursor (the predicate is inclusive on the last field), then popped.
	if len(rows) > q.Take && q.Take > 0 {
		if c := rows[len(rows)-1].CursorID; c != nil {
			out.next = *c
		}
		rows = rows[:len(rows)-1]
	}
	showSfwFace := level != 0 && level&table.Levels.NSFW == 0
	// The build phase: the per-row transform and finishItems (whose version-image and membership
	// reads are their own child spans).
	bctx, phase := tracing.StartPhase(ctx, tracing.PhaseBuild)
	phase.SetInt(tracing.AttrItems, len(rows))
	items := make([]*feedItem, 0, len(rows))
	for i := range rows {
		if it := buildFeedItem(&rows[i], in, raw, hy, gates, showSfwFace, hidePrivateModels); it != nil {
			items = append(items, it)
		}
	}
	out.items, err = finishItems(bctx, d, in, level, raw, items, hy, viewer, showSfwFace)
	phase.End()
	if err != nil {
		return nil, err
	}
	return out, nil
}

// resolveAddons is applyAddonExclusions over the level the request is served at: the poi and minor
// switches, and the addon tag exclusions unless the request is scoped to the viewer's own name.
func resolveAddons(in *Input, level int, addons []browsing.Addon, viewer *Viewer) rawInput {
	lv := level
	if lv == 0 {
		lv = browsing.PublicLevels
	}
	if lv = browsing.OnlySelectable(lv); lv == 0 {
		lv = browsing.PublicLevels
	}
	isMod := viewer != nil && viewer.IsModerator
	resolved := browsing.ResolveAddons(addons, lv, isMod, "")
	raw := rawInput{
		disablePoi:   in.DisablePoi || resolved.DisablePoi,
		disableMinor: in.DisableMinor || resolved.DisableMinor,
		excluded:     in.ExcludedTagIDs,
	}
	// isViewerUsername: the slugified name against the session's, case-insensitively.
	ownScoped := viewer != nil && in.Username != "" && strings.EqualFold(in.Username, viewer.Username)
	if !ownScoped && len(resolved.ExcludedTagIDs) > 0 {
		raw.excluded = uniqueInts(append(append([]int{}, in.ExcludedTagIDs...), resolved.ExcludedTagIDs...))
	}
	return raw
}

// decreaseDate is decreaseDate(new Date(), 1, period) (dayjs subtract): a calendar month or year
// back clamps the day to the end of a shorter month, as dayjs does.
func decreaseDate(now time.Time, period string) time.Time {
	now = now.UTC()
	switch period {
	case "Day":
		return now.AddDate(0, 0, -1)
	case "Week":
		return now.AddDate(0, 0, -7)
	case "Month":
		return subtractMonths(now, 1)
	case "Year":
		return subtractMonths(now, 12)
	}
	return now
}

func subtractMonths(t time.Time, n int) time.Time {
	first := time.Date(t.Year(), t.Month(), 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC).AddDate(0, -n, 0)
	last := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	day := t.Day()
	if day > last {
		day = last
	}
	return time.Date(first.Year(), first.Month(), day, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
}

// paidAccessGates is getModelPaidAccessGates: per model with a live gate, its latest deadline and
// its gated version ids (the ones Hide Paid drops, buildFeedItem).
func paidAccessGates(ctx context.Context, db Querier, modelIDs []int) (map[int]*paidGate, error) {
	rows, err := db.Query(ctx, `
    SELECT mv."modelId", MAX(pa."endsAt") AS deadline, array_agg(pa."entityId") AS "versionIds"
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE `+paidAccessLiveSQL+`
      AND mv."modelId" = ANY($1::int[])
    GROUP BY mv."modelId"
  `, modelIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]*paidGate{}
	for rows.Next() {
		var id int
		var deadline *time.Time
		var versionIDs []int
		if err := rows.Scan(&id, &deadline, &versionIDs); err != nil {
			return nil, err
		}
		out[id] = &paidGate{deadline: deadline, versionIDs: versionIDs}
	}
	return out, rows.Err()
}

// buildFeedItem is getModelsRaw's per-row transform: the face, the visible versions, the selection
// filters and the excluded-tag drop. nil = the row is left out.
func buildFeedItem(r *modelRow, in *Input, raw rawInput, hy *hydrate.ModelPage, gates map[int]*paidGate, showSfwFace, hidePrivate bool) *feedItem {
	data, ok := hy.Data[r.ID]
	if !ok {
		return nil
	}
	it := &feedItem{row: r, name: r.Name, showSfwFace: showSfwFace}
	it.hasSfwFace = r.SfwName != nil && r.SfwCoverImageID != nil && r.NsfwLevel&table.Levels.SFW != 0
	faceOn := showSfwFace && r.SfwName != nil
	if faceOn {
		it.name = *r.SfwName
	}
	var versions []superjson.Object
	for _, v := range data.Versions {
		// `!isModerator || !status?.length` (status is not ported): Published only.
		if s, _ := recField(v, "status").(string); s != "Published" {
			continue
		}
		level, _ := hydrate.Int(recField(v, "nsfwLevel"))
		bm, _ := recField(v, "baseModel").(string)
		if level&table.Levels.NSFW != 0 && isMatureRestrictedModels(bm) {
			continue
		}
		if hidePrivate {
			if a, _ := recField(v, "availability").(string); a != "Public" {
				continue
			}
		}
		if in.HidePaid {
			if g := gates[r.ID]; g != nil {
				id, _ := hydrate.Int(recField(v, "id"))
				if slices.Contains(g.versionIDs, id) {
					continue
				}
			}
		}
		versions = append(versions, v)
	}
	seen := map[string]bool{}
	for _, v := range versions {
		bm, _ := recField(v, "baseModel").(string)
		if !seen[bm] {
			seen[bm] = true
			it.baseModels = append(it.baseModels, recField(v, "baseModel"))
		}
	}
	if it.baseModels == nil {
		it.baseModels = []any{}
	}
	if in.BaseModels != nil {
		kept := versions[:0:0]
		for _, v := range versions {
			bm, _ := recField(v, "baseModel").(string)
			if contains(in.BaseModels, bm) {
				kept = append(kept, v)
			}
		}
		versions = kept
	}
	if len(versions) == 0 {
		return nil
	}
	if len(raw.excluded) > 0 {
		for _, t := range data.TagIDs {
			for _, x := range raw.excluded {
				if t == x {
					return nil
				}
			}
		}
	}
	it.version = versions[0]
	it.versionID, _ = hydrate.Int(recField(it.version, "id"))
	it.hashes = data.Hashes
	it.tagIDs = data.TagIDs
	if faceOn {
		// A .com face has no per-version description.
		it.version = withField(it.version, "description", "")
	}
	it.user = userWire(r.UserID, hy)
	if f, ok := hy.Frames[r.ID]; ok {
		it.cosmetic = f
	}
	if e, ok := hy.Decorations[r.ID]; ok {
		it.decoration = e
	}
	if !in.HidePaid {
		// Under Hide Paid the card shows only free versions, so the model-level chip would contradict it.
		it.gate = gates[r.ID]
	}
	it.privacy = parseMetaPrivacy(r.Meta)
	return it
}

// withField returns a copy of o with key set as `{...o, [key]: val}` does: an existing member keeps
// its place, a new one goes last (cache entries are shared, so o is not changed).
func withField(o superjson.Object, key string, val any) superjson.Object {
	c := append(make(superjson.Object, 0, len(o)+1), o...)
	c.Set(key, val)
	return c
}

// imageRecord is a showcase image as the card filters read it: an ordered cache record (model.getAll,
// hydrate.Sources.VersionImages) or a replica row (the associated resources, assocImages).
type imageRecord interface {
	superjson.Object | map[string]any
}

// recField is r's member k (nil when absent).
func recField[T imageRecord](r T, k string) any {
	switch x := any(r).(type) {
	case superjson.Object:
		v, _ := x.Get(k)
		return v
	case map[string]any:
		return x[k]
	}
	return nil
}

// userWire is the item's `user`: the creator's basic data, profile picture and cosmetics.
func userWire(id int, hy *hydrate.ModelPage) superjson.Object {
	var username, deletedAt, image any
	if b, ok := hy.Basic[id]; ok {
		username, deletedAt, image = b.Username, b.DeletedAt, b.Image
	}
	var pp any
	if p, ok := hy.ProfilePics[id]; ok {
		pp = p
	}
	var cosmetics any = []any{}
	if c, ok := hy.UserCosmetics[id]; ok {
		cosmetics = c
	}
	return superjson.Object{
		{Key: "id", Val: int64(id)},
		{Key: "username", Val: username},
		{Key: "deletedAt", Val: deletedAt},
		{Key: "image", Val: image},
		{Key: "profilePicture", Val: pp},
		{Key: "cosmetics", Val: cosmetics},
	}
}

// metaPrivacy is pickMetaMetricPrivacy(meta) as the resolvers read it.
type metaPrivacy struct {
	// visibility is getMetaMetricVisibility: per metric "hide", "show" or "" (inherit).
	visibility [3]string
}

var privacyKeys = [3]string{"buzz", "downloads", "generations"}
var legacyHideKeys = [3]string{"hideBuzz", "hideDownloads", "hideGenerations"}

func parseMetaPrivacy(raw []byte) metaPrivacy {
	var p metaPrivacy
	if len(raw) == 0 {
		return p
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return p
	}
	vis, _ := m["metricVisibility"].(map[string]any)
	for i, k := range privacyKeys {
		// metricVisibility's explicit choice wins over a legacy `hideX: true`.
		s, _ := vis[k].(string)
		switch {
		case s == "hide" || s == "show":
			p.visibility[i] = s
		case truthy(m[legacyHideKeys[i]]):
			p.visibility[i] = "hide"
		}
	}
	return p
}

func (p metaPrivacy) anyHidden() bool {
	return p.visibility[0] == "hide" || p.visibility[1] == "hide" || p.visibility[2] == "hide"
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	}
	return true
}

// hidden is resolveModelHiddenMetrics.
func hidden(p metaPrivacy, defaults hydrate.PrivacyDefaults, ownerOrMod, member bool) [3]bool {
	var out [3]bool
	if ownerOrMod || !member {
		return out
	}
	def := [3]bool{defaults.Buzz, defaults.Downloads, defaults.Generations}
	for i := range out {
		if p.visibility[i] != "" {
			out[i] = p.visibility[i] == "hide"
		} else {
			out[i] = def[i]
		}
	}
	return out
}

// finishItems is the rest of getModelsWithImagesAndModelVersions: the showcase images (held for
// the viewer), the covers, the per-viewer image filters, metric privacy, canGenerate and the wire.
func finishItems(ctx context.Context, d *Deps, in *Input, level int, raw rawInput, items []*feedItem, hy *hydrate.ModelPage, viewer *Viewer, showSfwFace bool) ([]any, error) {
	viewerID, isMod := 0, false
	if viewer != nil {
		viewerID, isMod = viewer.ID, viewer.IsModerator
	}
	var versionIDs []int
	for _, it := range items {
		if !it.withheld() {
			versionIDs = append(versionIDs, it.versionID)
		}
	}
	images := map[int][]superjson.Object{}
	var levels map[int]int
	var err error
	if len(versionIDs) > 0 {
		if images, err = d.Sources.VersionImages(ctx, versionIDs); err != nil {
			return nil, err
		}
		if !isMod {
			if levels, err = showcaseHeldLevels(ctx, d.Gallery, items); err != nil {
				return nil, err
			}
			images = holdForViewer(images, items, levels, viewerID)
		}
	}
	// sameVersionOnly: `!!input.baseModels?.length || !!input.hidePaid`.
	covers, err := coverImages(ctx, d, items, images, len(in.BaseModels) > 0 || in.HidePaid)
	if err != nil {
		return nil, err
	}
	if !isMod && len(covers) > 0 {
		if levels == nil {
			if levels, err = showcaseHeldLevels(ctx, d.Gallery, items); err != nil {
				return nil, err
			}
		}
		covers = holdCovers(covers, items, levels, viewerID)
	}

	// Metric privacy: the owners' defaults (read with the page), then the memberships of the owners
	// a viewer would see something hidden for.
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
		read := d.Sources.CreatorMemberships
		if d.Config.ServeMembershipMiss {
			read = d.Sources.CreatorMembershipsComputed
		}
		if memberships, err = read(ctx, candidates); err != nil {
			return nil, err
		}
	}

	viewLevel := level
	if viewLevel == 0 {
		viewLevel = table.Levels.Public
	}
	out := make([]any, 0, len(items))
	for _, it := range items {
		r := it.row
		var cover superjson.Object
		if c, ok := covers[r.ID]; ok {
			cover = c
		}
		face := imagesForFace(hoistCover(images[it.versionID], cover), r.Nsfw, it.hasSfwFace, showSfwFace)
		shown := filterImagesForViewer(face, viewLevel, r.Nsfw, raw.disablePoi, raw.disableMinor, viewer)
		filtered := shown
		if raw.excluded != nil && r.UserID != viewerID {
			filtered = filtered[:0:0]
			for _, img := range shown {
				if imageTagsClear(recField(img, "tags"), raw.excluded) {
					filtered = append(filtered, img)
				}
			}
		}
		// includeDrafts needs `status` (not ported): false.
		showImageless := (isMod || (viewer != nil && r.UserID == viewerID)) && (in.User != "" || in.Username != "")
		if len(filtered) == 0 && !showImageless {
			continue
		}
		isOwner := isMod || (viewer != nil && r.UserID == viewerID)
		hid := hidden(it.privacy, hy.PrivacyDefaults[r.UserID], isOwner, memberships[r.UserID])
		out = append(out, it.wire(hid, filtered))
	}
	return out, nil
}

func (it *feedItem) withheld() bool { return it.row.Mode != nil && *it.row.Mode == "TakenDown" }

// imageTagsClear is `x.tags && x.tags.every((id) => !excludedTagIds.includes(id))`.
func imageTagsClear(tags any, excluded []int) bool {
	list, ok := tags.([]any)
	if !ok {
		return false
	}
	for _, t := range list {
		n, _ := hydrate.Int(t)
		for _, x := range excluded {
			if n == x {
				return false
			}
		}
	}
	return true
}

// showcaseHeldLevels is getShowcaseHeldLevels over the page's models (their flags were read with the
// row): a minor or SFW-only model's level is its cached gallery level when the settings hold it, else
// the level its flags allow (heldGalleryLevel with no stored setting). A settings key Node would
// rebuild falls back (feed.GalleryStore), and so does a held setting with no level.
func showcaseHeldLevels(ctx context.Context, g Gallery, items []*feedItem) (map[int]int, error) {
	var ids []int
	flags := map[int]*modelRow{}
	for _, it := range items {
		if it.row.Minor || it.row.SfwOnly {
			if _, ok := flags[it.row.ID]; !ok {
				ids = append(ids, it.row.ID)
				flags[it.row.ID] = it.row
			}
		}
	}
	levels := map[int]int{}
	if len(ids) == 0 {
		return levels, nil
	}
	settings, err := g.SettingsMany(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		s := settings[id]
		if s != nil && s.SfwHeld != nil && *s.SfwHeld {
			if s.Level == nil {
				return nil, fallback.New("model-held-level-unset")
			}
			levels[id] = *s.Level
			continue
		}
		levels[id] = modelBrowsingLevelLimit(flags[id].Minor, flags[id].SfwOnly)
	}
	return levels, nil
}

// modelBrowsingLevelLimit is modelBrowsingLevelLimit (src/shared/constants/browsingLevel.constants.ts).
func modelBrowsingLevelLimit(minor, sfwOnly bool) int {
	switch {
	case minor:
		return table.Levels.MinorContent
	case sfwOnly:
		return table.Levels.SFW
	}
	return table.Levels.All
}

// holdForViewer is holdForViewer: every version's images within its model's held level, except the
// viewer's own models, whose showcase is whole. Never mutates byVersion's lists.
func holdForViewer[T imageRecord](byVersion map[int][]T, items []*feedItem, levels map[int]int, viewerID int) map[int][]T {
	modelOf := map[int]*modelRow{}
	for _, it := range items {
		modelOf[it.versionID] = it.row
	}
	out := make(map[int][]T, len(byVersion))
	for vid, list := range byVersion {
		r, ok := modelOf[vid]
		if !ok {
			// A version with no model to clear it serves none of its images. (Unreachable: every
			// version read is one of the page's.)
			out[vid] = []T{}
			continue
		}
		level, held := levels[r.ID]
		if !held || (viewerID != 0 && r.UserID == viewerID) {
			out[vid] = list
			continue
		}
		kept := make([]T, 0, len(list))
		for _, img := range list {
			if n, _ := hydrate.Int(recField(img, "nsfwLevel")); level&n != 0 {
				kept = append(kept, img)
			}
		}
		out[vid] = kept
	}
	return out
}

// holdCovers is holdCovers: each cover held as its model's shown version would hold it.
func holdCovers(covers map[int]superjson.Object, items []*feedItem, levels map[int]int, viewerID int) map[int]superjson.Object {
	out := map[int]superjson.Object{}
	for _, it := range items {
		c, ok := covers[it.row.ID]
		if !ok || it.versionID == 0 {
			continue
		}
		held := holdForViewer(map[int][]superjson.Object{it.versionID: {c}}, []*feedItem{it}, levels, viewerID)
		if l := held[it.versionID]; len(l) > 0 {
			out[it.row.ID] = l[0]
		}
	}
	return out
}

// coverImages is getCoverImages: each model's chosen cover, found among its shown version's (held)
// images, else — unless a base-model filter or Hide Paid pins the card to that version — located on
// the replica (the model owner's image on one of the model's versions) and read from that version's
// cached images. A dangling or foreign id is absent, unless Node's withCommunityCovers could find it
// (communityCoverGuard).
func coverImages(ctx context.Context, d *Deps, items []*feedItem, byVersion map[int][]superjson.Object, sameVersionOnly bool) (map[int]superjson.Object, error) {
	found, pending, err := ownerCovers(ctx, d, items, byVersion, sameVersionOnly)
	if err != nil {
		return nil, err
	}
	if err := communityCoverGuard(ctx, d.DB, found, pending); err != nil {
		return nil, err
	}
	return found, nil
}

// coverWant is one model's chosen cover id that is not on its shown version's images.
type coverWant struct {
	it      *feedItem
	coverID int
}

// communityCoverGuard stands in for withCommunityCovers (src/server/services/model-cover.service.ts),
// which getCoverImages runs over every chosen cover its owner lookup did not find: such a cover can
// be a COMMUNITY image the creator featured in one of the model's version showcases
// (getShowcaseCommunityCovers, version-showcase.service.ts), which Node then serves as the cover.
// That is not ported, so the request falls back (`model-community-cover`) when a cover the owner
// lookup did not find has a row in the query getShowcaseCommunityCovers starts from. With no such
// row Node finds nothing either; with one, whatever else Node checks, a fallback is only a lost
// answer.
func communityCoverGuard(ctx context.Context, db Querier, found map[int]superjson.Object, pending []coverWant) error {
	var missing []coverWant
	for _, p := range pending {
		if _, ok := found[p.it.row.ID]; !ok {
			missing = append(missing, p)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	imageIDs := make([]int, len(missing))
	modelIDs := make([]int, len(missing))
	wanted := make(map[[2]int]bool, len(missing))
	for i, p := range missing {
		imageIDs[i], modelIDs[i] = p.coverID, p.it.row.ID
		wanted[[2]int{p.it.row.ID, p.coverID}] = true
	}
	rows, err := db.Query(ctx, `SELECT DISTINCT mv."modelId", s."imageId"
		FROM "ModelVersionShowcaseItem" s
		JOIN "ModelVersion" mv ON mv.id = s."modelVersionId"
		JOIN "Image" i ON i.id = s."imageId"
		WHERE s."imageId" = ANY($1::int[])
		  AND mv."modelId" = ANY($2::int[])
		  AND s.source = 'Community'
		  AND NOT s."removed"`, imageIDs, modelIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	featured := false
	for rows.Next() {
		var modelID, imageID int
		if err := rows.Scan(&modelID, &imageID); err != nil {
			return err
		}
		if wanted[[2]int{modelID, imageID}] {
			featured = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if featured {
		return fallback.New("model-community-cover")
	}
	return nil
}

// ownerCovers is getCoverImages up to withCommunityCovers: the covers found on the shown version or
// as the owner's image on another version, and every chosen cover not on the shown version.
func ownerCovers(ctx context.Context, d *Deps, items []*feedItem, byVersion map[int][]superjson.Object, sameVersionOnly bool) (map[int]superjson.Object, []coverWant, error) {
	found := map[int]superjson.Object{}
	var pending []coverWant
	for _, it := range items {
		id := pickCoverImageID(it)
		if id == 0 {
			continue
		}
		var hit superjson.Object
		for _, img := range byVersion[it.versionID] {
			if n, _ := hydrate.Int(recField(img, "id")); n == id {
				hit = img
				break
			}
		}
		if hit != nil {
			found[it.row.ID] = hit
		} else {
			pending = append(pending, coverWant{it, id})
		}
	}
	if len(pending) == 0 || sameVersionOnly {
		return found, pending, nil
	}
	ids := make([]int, len(pending))
	for i, p := range pending {
		ids[i] = p.coverID
	}
	rows, err := d.DB.Query(ctx, `SELECT i.id, p."userId", p."modelVersionId", mv."modelId"
		FROM "Image" i
		LEFT JOIN "Post" p ON p.id = i."postId"
		LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
		WHERE i.id = ANY($1::int[])`, ids)
	if err != nil {
		return nil, nil, err
	}
	type located struct{ userID, versionID, modelID *int }
	where := map[int]located{}
	for rows.Next() {
		var id int
		var l located
		if err := rows.Scan(&id, &l.userID, &l.versionID, &l.modelID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		where[id] = l
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	type coverHit struct {
		it        *feedItem
		coverID   int
		versionID int
	}
	var hits []coverHit
	var versionIDs []int
	for _, p := range pending {
		l, ok := where[p.coverID]
		if !ok || l.modelID == nil || l.userID == nil || l.versionID == nil || *l.versionID == 0 {
			continue
		}
		if *l.modelID == p.it.row.ID && *l.userID == p.it.row.UserID {
			hits = append(hits, coverHit{p.it, p.coverID, *l.versionID})
			versionIDs = append(versionIDs, *l.versionID)
		}
	}
	if len(hits) == 0 {
		return found, pending, nil
	}
	others, err := d.Sources.VersionImages(ctx, versionIDs)
	if err != nil {
		return nil, nil, err
	}
	for _, h := range hits {
		for _, img := range others[h.versionID] {
			if n, _ := hydrate.Int(recField(img, "id")); n == h.coverID {
				found[h.it.row.ID] = img
				break
			}
		}
	}
	return found, pending, nil
}

// pickCoverImageID is pickCoverImageId: the .com cover with a complete face for a .com viewer,
// otherwise the creator's pick; 0 = none.
func pickCoverImageID(it *feedItem) int {
	p := it.row.CoverImageID
	if it.showSfwFace && it.hasSfwFace {
		p = it.row.SfwCoverImageID
	}
	if p == nil {
		return 0
	}
	return *p
}

// hoistCover is hoistCoverImage: the cover first, then the rest without it.
func hoistCover(images []superjson.Object, cover superjson.Object) []superjson.Object {
	if cover == nil {
		return images
	}
	id, _ := hydrate.Int(recField(cover, "id"))
	out := make([]superjson.Object, 0, len(images)+1)
	out = append(out, cover)
	for _, img := range images {
		if n, _ := hydrate.Int(recField(img, "id")); n != id {
			out = append(out, img)
		}
	}
	return out
}

// imagesForFace is imagesForFace: a mature model listed on .com through its face sends only its
// PG / PG-13 images.
func imagesForFace(images []superjson.Object, nsfw, hasSfwFace, showSfwFace bool) []superjson.Object {
	if !showSfwFace || !nsfw || !hasSfwFace {
		return images
	}
	out := make([]superjson.Object, 0, len(images))
	for _, img := range images {
		n, _ := hydrate.Int(recField(img, "nsfwLevel"))
		if n != 0 && n&table.Levels.SFW == n {
			out = append(out, img)
		}
	}
	return out
}

// filterImagesForViewer is filterImagesForViewer (src/server/utils/model-getall-images.ts).
func filterImagesForViewer[T imageRecord](images []T, level int, modelNsfw, disablePoi, disableMinor bool, viewer *Viewer) []T {
	level = browsing.OnlySelectable(level)
	maxLevel := 0
	for bit := 1; bit <= level && bit > 0; bit <<= 1 {
		if level&bit != 0 {
			maxLevel = bit
		}
	}
	out := make([]T, 0, len(images))
	for _, img := range images {
		owner, _ := hydrate.Int(recField(img, "userId"))
		isOwner := viewer != nil && owner == viewer.ID
		n, _ := hydrate.Int(recField(img, "nsfwLevel"))
		if n == 0 {
			if isOwner || (viewer != nil && viewer.IsModerator) {
				out = append(out, img)
			}
			continue
		}
		var shown bool
		if modelNsfw {
			shown = n <= maxLevel
		} else {
			shown = n&level != 0
		}
		if !shown {
			continue
		}
		if truthy(recField(img, "poi")) && disablePoi && !isOwner {
			continue
		}
		if truthy(recField(img, "minor")) && disableMinor && !isOwner {
			continue
		}
		out = append(out, img)
	}
	return out
}

// droppedImageKeys is GETALL_DROPPED_IMAGE_FIELDS.
var droppedImageKeys = map[string]bool{"onSite": true, "hasMeta": true, "hasPositivePrompt": true, "modelVersionId": true, "availability": true}

// buildGetAllModelImages is buildGetAllModelImages(images, GET_ALL_IMAGES_PER_MODEL_SLIM, true): the
// slim coverage slice, each image without the dropped keys.
func buildGetAllModelImages(images []superjson.Object) []any {
	reduced := images
	if len(images) > imagesPerModelSlim {
		reduced = selectSlim(images, imagesPerModelSlim)
	}
	out := make([]any, len(reduced))
	for i, img := range reduced {
		out[i] = imageWire(img)
	}
	return out
}

// selectSlim is selectSlimGetAllModelImages: one earliest image per distinct truthy nsfwLevel, then
// the earliest others, in cache order, capped.
func selectSlim(images []superjson.Object, limit int) []superjson.Object {
	selected := make([]bool, len(images))
	count := 0
	seen := map[int]bool{}
	for i := 0; i < len(images) && count < limit; i++ {
		n, _ := hydrate.Int(recField(images[i], "nsfwLevel"))
		if n == 0 || seen[n] {
			continue
		}
		seen[n] = true
		selected[i] = true
		count++
	}
	for i := 0; i < len(images) && count < limit; i++ {
		if !selected[i] {
			selected[i] = true
			count++
		}
	}
	out := make([]superjson.Object, 0, limit)
	for i, img := range images {
		if selected[i] && len(out) < limit {
			out = append(out, img)
		}
	}
	return out
}

// imageWire is one showcase image on the wire: stripGetAllModelImage's `{...rest}`, the cached
// record's members in their order without the dropped keys (a new object: the record is shared).
func imageWire(img superjson.Object) superjson.Object {
	obj := make(superjson.Object, 0, len(img))
	for _, f := range img {
		if !droppedImageKeys[f.Key] {
			obj = append(obj, f)
		}
	}
	return obj
}

// wire is the item as getModelsWithImagesAndModelVersions returns it, in its key order.
func (it *feedItem) wire(hid [3]bool, images []superjson.Object) superjson.Object {
	r := it.row
	var deadline any
	gated := false
	if it.gate != nil {
		gated = true
		if it.gate.deadline != nil {
			deadline = *it.gate.deadline
		}
	}
	obj := make(superjson.Object, 0, 32)
	obj = append(obj, superjson.Object{
		{Key: "id", Val: int64(r.ID)},
		{Key: "name", Val: it.name},
		{Key: "coverImageId", Val: intPtr(r.CoverImageID)},
		{Key: "sfwCoverImageId", Val: intPtr(r.SfwCoverImageID)},
		{Key: "type", Val: r.Type},
		{Key: "minor", Val: r.Minor},
		{Key: "sfwOnly", Val: r.SfwOnly},
		{Key: "poi", Val: r.Poi},
		{Key: "nsfw", Val: r.Nsfw},
		{Key: "nsfwLevel", Val: int64(r.NsfwLevel)},
		{Key: "status", Val: r.Status},
		{Key: "createdAt", Val: r.CreatedAt},
		{Key: "lastVersionAt", Val: timePtr(r.LastVersionAt)},
		{Key: "publishedAt", Val: timePtr(r.PublishedAt)},
		{Key: "locked", Val: r.Locked},
		{Key: "mode", Val: stringPtr(r.Mode)},
		{Key: "availability", Val: r.Availability},
		{Key: "userId", Val: int64(r.UserID)},
		{Key: "earlyAccessDeadline", Val: deadline},
		{Key: "hasActivePaidAccess", Val: gated},
		{Key: "hasSfwFace", Val: it.hasSfwFace},
		{Key: "baseModels", Val: hydrate.Wire(it.baseModels)},
		{Key: "user", Val: it.user},
		{Key: "cosmetic", Val: it.cosmetic},
		{Key: "eventDecoration", Val: it.decoration},
	}...)
	tags := make([]any, len(it.tagIDs))
	for i, t := range it.tagIDs {
		tags[i] = int64(t)
	}
	hashes := make([]any, 0, len(it.hashes))
	for _, h := range it.hashes {
		if s, ok := h.(string); ok {
			hashes = append(hashes, strings.ToLower(s))
		} else {
			hashes = append(hashes, hydrate.Wire(h))
		}
	}
	rank := parseRank(r.Rank)
	downloads, tipped := rank["downloadCount"], rank["tippedAmountCount"]
	if hid[1] {
		downloads = nil
	}
	if hid[0] {
		tipped = nil
	}
	version := versionWire(it.version)
	covered, _ := recField(it.version, "covered").(bool)
	// The expansion's column (generation-coverage-next on), every viewer a member (open to all).
	coveredNext, _ := recField(it.version, "coveredNext").(bool)
	bm, _ := recField(it.version, "baseModel").(string)
	flags, _ := hydrate.Int(recField(it.version, "flags"))
	obj = append(obj,
		superjson.Field{Key: "tags", Val: tags},
		superjson.Field{Key: "hashes", Val: hashes},
		superjson.Field{Key: "hiddenMetrics", Val: superjson.Object{
			{Key: "buzz", Val: hid[0]}, {Key: "downloads", Val: hid[1]}, {Key: "generations", Val: hid[2]},
		}},
		superjson.Field{Key: "rank", Val: superjson.Object{
			{Key: "downloadCount", Val: downloads},
			{Key: "thumbsUpCount", Val: rank["thumbsUpCount"]},
			{Key: "thumbsDownCount", Val: rank["thumbsDownCount"]},
			{Key: "commentCount", Val: rank["commentCount"]},
			{Key: "collectedCount", Val: rank["collectedCount"]},
			{Key: "tippedAmountCount", Val: tipped},
		}},
		superjson.Field{Key: "version", Val: version},
		superjson.Field{Key: "images", Val: buildGetAllModelImages(images)},
		superjson.Field{Key: "canGenerate", Val: isGenerationEligible(coveredNext, covered, bm, r.Type, toPublicAPIVersionFlags(flags))},
	)
	return obj
}

// versionWire is the shown version: the cached version, in its key order, with its public-API flags
// (`{...version, flags}`: flags keeps its place). A new object: the record is shared.
func versionWire(v superjson.Object) superjson.Object {
	if f, ok := hydrate.Int(recField(v, "flags")); ok {
		return withField(v, "flags", int64(toPublicAPIVersionFlags(f)))
	}
	return append(make(superjson.Object, 0, len(v)), v...)
}

// parseRank is the row's `rank` object, each count `?? 0`.
func parseRank(raw []byte) map[string]any {
	keys := []string{"downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "collectedCount", "tippedAmountCount"}
	out := make(map[string]any, len(keys))
	var m map[string]json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	_ = dec.Decode(&m)
	for _, k := range keys {
		out[k] = rankCount(m[k])
	}
	return out
}

// rankCount is one count `?? 0`: an integer as int64, any other number as float64, null as 0.
func rankCount(n json.Number) any {
	if n == "" {
		return int64(0)
	}
	if i, err := strconv.ParseInt(n.String(), 10, 64); err == nil {
		return i
	}
	if f, err := n.Float64(); err == nil {
		return f
	}
	return int64(0)
}

func intPtr(p *int) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}

func timePtr(p *time.Time) any {
	if p == nil {
		return nil
	}
	return *p
}

func stringPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
