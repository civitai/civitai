package feed

import (
	"context"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// The port of image.getInfinite's `hubId` (InfinitePorts.HubID): a user-composed hub resolved to the
// id sets the feed service filters by. Node: resolveHubForFeed (src/server/services/image.service.ts)
// over resolveHubSources, resolveExcludedSources, groupTagIds and hubBrowsingLevel
// (src/server/services/user-hub.service.ts), with getWithheldVersionIds and getHeldGalleryLevel
// (src/server/services/model.service.ts); the feed half is mapHubSources (feedsvc.Map) and
// serveFromFeed's HUB_ROUTES check (infiniteFromFeed).

// hubSourceTypes are the UserHubSourceType values (hubSourceExclusionSchema's `type` enum).
var hubSourceTypes = map[string]bool{"User": true, "Model": true, "ModelVersion": true, "Collection": true, "Tag": true}

// maxHubExcludedSources is hubExcludedSources' `.max(hubLimits.sourcesPerHub)`.
const maxHubExcludedSources = 50

// hubResolvedVersionIDs is hubLimits.resolvedVersionIds: the cap on a hub's resolved version ids,
// which only what is left after its explicit ModelVersion sources is spent expanding Model sources.
const hubResolvedVersionIDs = 750

// pgLevel is NsfwLevel.PG: hubBrowsingLevel's reading of an absent (or 0) requested level.
const pgLevel = 1

// HubSourceRef is one entry of `hubExcludedSources` (hubSourceExclusionSchema): a source the viewer
// switched off for their session.
type HubSourceRef struct {
	Type     string
	TargetID int
}

// HubSourceRow is a hub's UserHubSource row as resolveHubSources selects it (enabled rows only).
type HubSourceRow struct {
	Type     string
	TargetID int
	Exclude  bool
	// GroupKey is the tag AND-group key; nil = a group of one.
	GroupKey *int
}

// hubSourceKey is hubSourceKey (src/server/schema/user-hub.schema.ts): `${type}:${targetId}`.
func hubSourceKey(typ string, targetID int) string { return typ + ":" + strconv.Itoa(targetID) }

// tagGroupKey is resolveHubSources' tagGroupKey: a Tag row's hubTagGroupKey (`i-<key>` / `x-<key>`),
// "" when the row is not in a group (every other kind is its own OR-arm in the feed filter).
func (s HubSourceRow) tagGroupKey() string {
	if s.Type != "Tag" || s.GroupKey == nil {
		return ""
	}
	return hubTagGroupKey(s.Exclude, *s.GroupKey)
}

// hubTagGroupKey is hubTagGroupKey: the polarity is part of the key.
func hubTagGroupKey(exclude bool, groupKey int) string {
	if exclude {
		return "x-" + strconv.Itoa(groupKey)
	}
	return "i-" + strconv.Itoa(groupKey)
}

// HubRow is the UserHub row resolveHubSources reads: its stored browsing-level cap and its enabled
// sources.
type HubRow struct {
	ForcedBrowsingLevel int
	Sources             []HubSourceRow
}

// RankedVersion is one row of resolveHubSources' per-model version ranking: a version, its model and
// its rank within the model (newest id first, from 1).
type RankedVersion struct {
	ID, ModelID, Rank int
}

// HubReader is what the hub resolution reads from the replica (implemented by *GalleryStore).
type HubReader interface {
	// Hub is resolveHubSources' userHub.findFirst: the hub when this viewer may open it
	// (hubViewerWhere: a moderator any, everyone else their own (viewerID; 0 = signed out) and the
	// Public ones), nil otherwise.
	Hub(ctx context.Context, hubID, viewerID int, isModerator bool) (*HubRow, error)
	// RankedModelVersions is the ranking query: each model's versions ranked newest id first, those
	// ranked at most maxRank, ordered by id descending.
	RankedModelVersions(ctx context.Context, modelIDs []int, maxRank int) ([]RankedVersion, error)
	// ModelVersionIDsOf is resolveExcludedSources' modelVersion.findMany: every version of the models.
	ModelVersionIDsOf(ctx context.Context, modelIDs []int) ([]int, error)
	// WithheldModels is getWithheldVersionIds' model read: of the models, those taken down and not
	// owned by viewerID (0 = no viewer).
	WithheldModels(ctx context.Context, modelIDs []int, viewerID int) (map[int]bool, error)
}

// ResolvedHub is ResolvedHubSources without its collection ids (HUB_COLLECTION_SOURCES_ENABLED is
// false: no reader of a resolved hub looks at them).
type ResolvedHub struct {
	UserIDs    []int
	VersionIDs []int
	TagGroups  [][]int
	// Truncated: a Model source expanded past the id cap and was trimmed. Read by nothing, as in Node.
	Truncated bool
	// ForcedBrowsingLevel is the hub's stored cap; 0 = none.
	ForcedBrowsingLevel int
	// HeldBrowsingLevel is the intersection of the held gallery levels of the minor or SFW-only
	// models the hub serves, when Held.
	HeldBrowsingLevel int
	Held              bool
	ExcludedUserIDs   []int
	// ExcludedVersionIDs are every version of the excluded models (never trimmed) and the excluded
	// versions.
	ExcludedVersionIDs []int
	ExcludedTagGroups  [][]int
}

// hubDeps are the hub resolution's reads: the hub tables, the version→model cache and the gallery
// holds.
type hubDeps struct {
	hubs   HubReader
	models modelResolver
	holds  V1Gallery
}

// resolveHubSources is resolveHubSources (user-hub.service.ts) for a viewer of a session or a
// full-access key (asOwner, the only credentials this service answers): the hub's enabled sources,
// minus what the viewer switched off for the session, with Model sources expanded to versions under
// the per-model budget, a taken-down model's versions removed (except for its owner) and the held
// level of the models it serves; nil when the hub does not exist or the viewer may not open it.
// holdExempt is credentialViews' asModerator (moderatorView): a moderator is neither held nor
// withheld.
func resolveHubSources(ctx context.Context, d hubDeps, hubID int, viewer Viewer, excluded []HubSourceRef) (*ResolvedHub, error) {
	hub, err := d.hubs.Hub(ctx, hubID, viewer.ID, viewer.IsModerator)
	if err != nil || hub == nil {
		return nil, err
	}
	// A session toggle narrows the hub's POSITIVE sources only, and takes a tag's whole AND-group
	// with it.
	sessionExcluded := make(map[string]bool, len(excluded))
	for _, e := range excluded {
		sessionExcluded[hubSourceKey(e.Type, e.TargetID)] = true
	}
	var negative, positive []HubSourceRow
	for _, s := range hub.Sources {
		if s.Exclude {
			negative = append(negative, s)
		} else {
			positive = append(positive, s)
		}
	}
	toggledOffGroups := map[string]bool{}
	for _, s := range positive {
		if sessionExcluded[hubSourceKey(s.Type, s.TargetID)] {
			if g := s.tagGroupKey(); g != "" {
				toggledOffGroups[g] = true
			}
		}
	}
	var positiveSources []HubSourceRow
	for _, s := range positive {
		if sessionExcluded[hubSourceKey(s.Type, s.TargetID)] {
			continue
		}
		if g := s.tagGroupKey(); g != "" && toggledOffGroups[g] {
			continue
		}
		positiveSources = append(positiveSources, s)
	}

	modelIDs := hubTargets(positiveSources, "Model")
	explicitVersionIDs := hubTargets(positiveSources, "ModelVersion")
	// Explicit versions are kept whole; only what is left of the cap expands Model sources, each
	// model getting its own share.
	budget := max(0, hubResolvedVersionIDs-len(unionInts(nil, explicitVersionIDs)))
	perModel := 0
	if len(modelIDs) > 0 {
		perModel = max(1, budget/len(modelIDs))
	}

	excludedSet, err := resolveExcludedHubSources(ctx, d.hubs, negative)
	if err != nil {
		return nil, err
	}

	truncated := false
	var versionIDsOfModels []int
	modelOfVersion := map[int]int{}
	if len(modelIDs) > 0 && perModel > 0 {
		ranked, err := d.hubs.RankedModelVersions(ctx, modelIDs, perModel+1)
		if err != nil {
			return nil, err
		}
		for _, r := range ranked {
			if r.Rank > perModel {
				truncated = true
			} else {
				versionIDsOfModels = append(versionIDsOfModels, r.ID)
				modelOfVersion[r.ID] = r.ModelID
			}
		}
	} else if len(modelIDs) > 0 {
		truncated = true
	}

	allVersionIDs := unionInts(explicitVersionIDs, versionIDsOfModels)
	capped := allVersionIDs
	if len(capped) > hubResolvedVersionIDs {
		capped, truncated = capped[:hubResolvedVersionIDs], true
	}
	out := &ResolvedHub{
		UserIDs:             hubTargets(positiveSources, "User"),
		TagGroups:           groupTagIDs(positiveSources),
		Truncated:           truncated,
		ForcedBrowsingLevel: hub.ForcedBrowsingLevel,
		ExcludedUserIDs:     excludedSet.userIDs,
		ExcludedVersionIDs:  excludedSet.versionIDs,
		ExcludedTagGroups:   excludedSet.tagGroups,
	}
	withheld := map[int]bool{}
	if len(capped) > 0 && !viewer.IsModerator {
		// getWithheldVersionIds reads every capped version's model (the version→model cache); the hold
		// reads the models of the expanded versions as known, and those of the rest from the same
		// cache (resolveImageModelIds over `modelVersionIds`).
		versions, err := d.models.VersionModels(ctx, capped)
		if err != nil {
			return nil, err
		}
		var versionModels []int
		for _, id := range capped {
			if m, ok := versions[id]; ok {
				versionModels = append(versionModels, m)
			}
		}
		versionModels = unionInts(nil, versionModels)
		if len(versionModels) > 0 {
			withheldModels, err := d.hubs.WithheldModels(ctx, versionModels, viewer.ID)
			if err != nil {
				return nil, err
			}
			for _, id := range capped {
				if m, ok := versions[id]; ok && withheldModels[m] {
					withheld[id] = true
				}
			}
		}
		var heldModels []int
		for _, id := range capped {
			if m, ok := modelOfVersion[id]; ok {
				heldModels = append(heldModels, m)
			}
		}
		for _, id := range capped {
			if _, expanded := modelOfVersion[id]; expanded {
				continue
			}
			if m, ok := versions[id]; ok {
				heldModels = append(heldModels, m)
			}
		}
		levels, err := heldLevels(ctx, d.holds, unionInts(nil, heldModels), "held-level-unset")
		if err != nil {
			return nil, err
		}
		for _, l := range levels {
			if !out.Held {
				out.Held, out.HeldBrowsingLevel = true, l
			} else {
				out.HeldBrowsingLevel &= l
			}
		}
	}
	for _, id := range capped {
		if !withheld[id] {
			out.VersionIDs = append(out.VersionIDs, id)
		}
	}
	return out, nil
}

// excludedHubSources is resolveExcludedSources' answer.
type excludedHubSources struct {
	userIDs, versionIDs []int
	tagGroups           [][]int
}

// resolveExcludedHubSources is resolveExcludedSources: an excluded Model expands to ALL its versions
// (no budget, no trimming: a trimmed exclusion serves back content the owner kept out), after the
// excluded versions, without repeats.
func resolveExcludedHubSources(ctx context.Context, hubs HubReader, sources []HubSourceRow) (excludedHubSources, error) {
	modelIDs := hubTargets(sources, "Model")
	versionIDs := hubTargets(sources, "ModelVersion")
	if len(modelIDs) > 0 {
		ids, err := hubs.ModelVersionIDsOf(ctx, modelIDs)
		if err != nil {
			return excludedHubSources{}, err
		}
		versionIDs = append(versionIDs, ids...)
	}
	versionIDs = unionInts(nil, versionIDs)
	if len(versionIDs) == 0 {
		versionIDs = nil
	}
	return excludedHubSources{
		userIDs:    hubTargets(sources, "User"),
		versionIDs: versionIDs,
		tagGroups:  groupTagIDs(sources),
	}, nil
}

// hubTargets is resolveHubSources' byType: the target ids of the rows of one type, in row order.
func hubTargets(sources []HubSourceRow, typ string) []int {
	var out []int
	for _, s := range sources {
		if s.Type == typ {
			out = append(out, s.TargetID)
		}
	}
	return out
}

// groupTagIDs is groupTagIds (user-hub.service.ts): the Tag rows as AND-groups, in first-appearance
// order; rows sharing a hubTagGroupKey (polarity included) are one group, a nil key a group of one.
func groupTagIDs(sources []HubSourceRow) [][]int {
	var groups [][]int
	byKey := map[string]int{}
	for _, s := range sources {
		if s.Type != "Tag" {
			continue
		}
		if s.GroupKey == nil {
			groups = append(groups, []int{s.TargetID})
			continue
		}
		key := hubTagGroupKey(s.Exclude, *s.GroupKey)
		if i, ok := byKey[key]; ok {
			groups[i] = append(groups[i], s.TargetID)
			continue
		}
		byKey[key] = len(groups)
		groups = append(groups, []int{s.TargetID})
	}
	return groups
}

// hubBrowsingLevel is hubBrowsingLevel (user-hub.service.ts): the requested level under the hub's
// own cap and the held level of its models (an absent or 0 level reads as PG once either applies).
func hubBrowsingLevel(level int, h *ResolvedHub) int {
	if h.ForcedBrowsingLevel == 0 && !h.Held {
		return level
	}
	l := level
	if l == 0 {
		l = pgLevel
	}
	if h.ForcedBrowsingLevel != 0 {
		l &= h.ForcedBrowsingLevel
	}
	if h.Held {
		l &= h.HeldBrowsingLevel
	}
	return l
}

// hubForFeed is resolveHubForFeed (image.service.ts): the hub as the feed is asked for it and the
// level it is asked at, or nil (`hubSources: null`, an empty page) when the hub does not exist for
// this viewer, has no source left (collections are dark: HUB_COLLECTION_SOURCES_ENABLED), or its cap
// leaves the viewer nothing.
func hubForFeed(ctx context.Context, d hubDeps, hubID int, viewer Viewer, excluded []HubSourceRef, level int) (*feedsvc.Hub, int, error) {
	h, err := resolveHubSources(ctx, d, hubID, viewer, excluded)
	if err != nil || h == nil {
		return nil, 0, err
	}
	if len(h.UserIDs) == 0 && len(h.VersionIDs) == 0 && len(h.TagGroups) == 0 {
		return nil, 0, nil
	}
	l := hubBrowsingLevel(level, h)
	if l == 0 {
		return nil, 0, nil
	}
	return &feedsvc.Hub{
		UserIDs: h.UserIDs, VersionIDs: h.VersionIDs, TagGroups: h.TagGroups,
		ExcludedUserIDs: h.ExcludedUserIDs, ExcludedVersionIDs: h.ExcludedVersionIDs, ExcludedTagGroups: h.ExcludedTagGroups,
	}, l, nil
}

// --- the replica reads (GalleryStore implements HubReader) ---------------------------------------

// Hub reads the hub row and its enabled sources. The sources are read in id order: Prisma's nested
// select names no order, so Node's is the heap's; the order only arranges the lists the feed is sent
// (and never trims one: the version cap cannot be reached by the sources a hub can hold), not what
// they hold.
func (g *GalleryStore) Hub(ctx context.Context, hubID, viewerID int, isModerator bool) (*HubRow, error) {
	args := []any{hubID}
	where := `h.id = $1`
	if !isModerator {
		if viewerID != 0 {
			args = append(args, viewerID)
			where += ` AND h."userId" = $2 OR h.availability = 'Public'` // PROBE MUTANT: parentheses dropped
		} else {
			where += ` AND h.availability = 'Public'`
		}
	}
	rows, err := g.DB.Query(ctx, `SELECT h."forcedBrowsingLevel" FROM "UserHub" h WHERE `+where+` LIMIT 1`, args...)
	if err != nil {
		return nil, err
	}
	var hub *HubRow
	if rows.Next() {
		hub = &HubRow{}
		if err := rows.Scan(&hub.ForcedBrowsingLevel); err != nil {
			rows.Close()
			return nil, err
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil || hub == nil {
		return nil, err
	}
	src, err := g.DB.Query(ctx, `SELECT s.type::text, s."targetId", s.exclude, s."groupKey" FROM "UserHubSource" s
		WHERE s."hubId" = $1 AND s.enabled ORDER BY s.id`, hubID)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	for src.Next() {
		var s HubSourceRow
		if err := src.Scan(&s.Type, &s.TargetID, &s.Exclude, &s.GroupKey); err != nil {
			return nil, err
		}
		hub.Sources = append(hub.Sources, s)
	}
	return hub, src.Err()
}

// RankedModelVersions is resolveHubSources' ranking query, its `IN (…)` bound as one array.
func (g *GalleryStore) RankedModelVersions(ctx context.Context, modelIDs []int, maxRank int) ([]RankedVersion, error) {
	rows, err := g.DB.Query(ctx, `SELECT id, "modelId", rn FROM (
		SELECT mv.id, mv."modelId", ROW_NUMBER() OVER (PARTITION BY mv."modelId" ORDER BY mv.id DESC) AS rn
		FROM "ModelVersion" mv WHERE mv."modelId" = ANY($1::int[])
	) ranked WHERE rn <= $2 ORDER BY id DESC`, modelIDs, maxRank)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RankedVersion
	for rows.Next() {
		var r RankedVersion
		if err := rows.Scan(&r.ID, &r.ModelID, &r.Rank); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ModelVersionIDsOf is resolveExcludedSources' version read, in id order (Prisma's findMany names
// none: the order only arranges the keep-out list the feed is sent).
func (g *GalleryStore) ModelVersionIDsOf(ctx context.Context, modelIDs []int) ([]int, error) {
	rows, err := g.DB.Query(ctx, `SELECT id FROM "ModelVersion" WHERE "modelId" = ANY($1::int[]) ORDER BY id`, modelIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// WithheldModels is getWithheldVersionIds' `dbRead.model.findMany` and its filter: the models taken
// down (isModelWithheld) and not owned by viewerID.
func (g *GalleryStore) WithheldModels(ctx context.Context, modelIDs []int, viewerID int) (map[int]bool, error) {
	out := map[int]bool{}
	if len(modelIDs) == 0 {
		return out, nil
	}
	rows, err := g.DB.Query(ctx, `SELECT id, "userId", mode::text FROM "Model" WHERE id = ANY($1::int[])`, modelIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, userID int
		var mode *string
		if err := rows.Scan(&id, &userID, &mode); err != nil {
			return nil, err
		}
		if mode != nil && *mode == "TakenDown" && userID != viewerID {
			out[id] = true
		}
	}
	return out, rows.Err()
}
