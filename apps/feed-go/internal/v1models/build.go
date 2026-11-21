// Package v1models ports the public REST model endpoints, `GET /api/v1/models` and
// `GET /api/v1/models/[id]` (src/pages/api/v1/models), in SHADOW mode only: the answer Node would
// give for the request shapes ported here, or a fallback. See apps/feed-go/DESIGN.md §16.
//
// Both endpoints build their bodies from getModelsWithVersions (src/server/services/model.service.ts)
// over getModelsRaw: one model statement on the replica, then the per-id caches the Node path reads
// (model data, model tags, version files, showcase images, paid access, creators, metric privacy) and
// a few small replica reads. The caches are read, never written; a miss Node would fill from the
// database falls back, except where the miss path is a plain read ported here.
package v1models

import (
	"context"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// DefaultFetchConcurrency bounds the parallel reads of one computation.
const DefaultFetchConcurrency = 4

// GallerySettingsReader reads a model's cached gallery settings (feed.GalleryStore).
type GallerySettingsReader interface {
	Settings(ctx context.Context, modelID int) (*feed.GallerySettings, error)
}

// Config are the settings and flag mirrors the Node path reads.
type Config struct {
	// ImageLocation is NEXT_PUBLIC_IMAGE_LOCATION, the edge URL prefix.
	ImageLocation string
	// BaseURL is getBaseUrl() of the Node app (NEXTAUTH_URL): the `[id]` body's download URLs.
	BaseURL string
	// CoverageNext mirrors `generation-coverage-next` (nextCoverageEnabled): it decides every model's
	// `supportsGeneration`.
	CoverageNext bool
	// BaseModelFeedMetrics mirrors `base-model-feed-metrics`: the statement form of a `baseModels`
	// request.
	BaseModelFeedMetrics bool
	// ComputeMisses is FEED_GO_COMPUTE_MISSES: a tag-name cache miss is answered with tagCache's own
	// lookup on the replica instead of falling back (the other caches' misses still fall back).
	ComputeMisses bool
	// ResponseCacheTTL is the `[id]` origin cache's logical TTL (CacheTTL.sm where the Node app runs
	// with IS_DATAPACKET); 0 = Node does not read it.
	ResponseCacheTTL time.Duration
	// Production is isProd: `nextPage`'s origin is https://<host> (else http://localhost:3000).
	Production bool
	// RedHosts are the red domain's hosts, lowercased (RedHosts): a request on one is red-capable,
	// which lists a Training Data file whatever its rating (trainingDataServableOnHost).
	RedHosts []string
	// FetchConcurrency bounds the parallel reads (0 = DefaultFetchConcurrency).
	FetchConcurrency int
}

// Deps are what the port reads.
type Deps struct {
	DB      Querier
	Packed  *hydrate.PackedReader
	Sources *hydrate.Sources
	Gallery GallerySettingsReader
	// Addons returns the browsing-settings addons (feed.AddonSource.Addons).
	Addons func(context.Context) []browsing.Addon
	Config Config
	Now    func() time.Time
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Deps) limit() int {
	if d.Config.FetchConcurrency > 0 {
		return d.Config.FetchConcurrency
	}
	return DefaultFetchConcurrency
}

// group is an errgroup bounded by the fetch concurrency, every worker run through safe.Go.
type group struct {
	g   *errgroup.Group
	ctx context.Context
}

func (d *Deps) group(ctx context.Context) *group {
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(d.limit())
	return &group{g: g, ctx: gctx}
}

func (g *group) Go(fn func(ctx context.Context) error) {
	g.g.Go(safe.Go(func() error { return fn(g.ctx) }))
}

func (g *group) Wait() error { return g.g.Wait() }

// withVersionsInput is getModelsWithVersions' input for one of the two endpoints.
type withVersionsInput struct {
	raw RawInput
	// ignoreAddons is ignoreBrowsingAddons (the `[id]` lookup): only `disablePoi` comes from the addons.
	ignoreAddons bool
	// hidePrivate is getModelsRaw's hidePrivateModels (no ids, no username): non-Public versions
	// are left out.
	hidePrivate bool
}

// creator is the getModelsRaw item's `user`, as far as the REST bodies read it.
type creator struct {
	username any // string or nil
	picture  superjson.Object
	// hidden: the `civitai` account, which getModelsWithVersions leaves without a user.
	hidden bool
}

// item is one getModelsWithVersions item. base is the item without `modelVersions`, `tagsOnModels`
// and `user` (what `{ modelVersions, tagsOnModels, user, ...model }` leaves), in key order.
type item struct {
	base     superjson.Object
	versions []superjson.Object
	tagNames []any
	creator  creator
	// typ and mode are the model's own, read by the shapers.
	typ  string
	mode *string
}

// withVersions is getModelsWithVersions' answer.
type withVersions struct {
	items      []*item
	nextCursor string
}

// resolvedAddons is loadBlockedBrowsingContext's resolution: the addons at `onlySelectableLevels(level
// || PG) || PG`, for a signed-out viewer (no moderator bypass, no scope).
func (d *Deps) resolvedAddons(ctx context.Context, level int) browsing.Resolved {
	if level == 0 {
		level = browsing.PublicLevels
	}
	l := browsing.OnlySelectable(level)
	if l == 0 {
		l = browsing.PublicLevels
	}
	addons := browsing.DefaultAddons
	if d.Addons != nil {
		addons = d.Addons(ctx)
	}
	return browsing.ResolveAddons(addons, l, false, "")
}

// rawItem is a getModelsRaw item after its transform.
type rawItem struct {
	row           ModelRow
	versions      []superjson.Object
	allBaseModels []any
	tags          []modelTag
	gated         bool
	creator       creator
	// sfwFace: the .com face is shown (showsSfwFace of the request's level and a face set).
	sfwFace bool
}

// getModelsWithVersions runs getModelsRaw (include ['details']) and getModelsWithVersions.
func (d *Deps) getModelsWithVersions(ctx context.Context, in withVersionsInput) (*withVersions, error) {
	coverageNext := d.Config.CoverageNext
	if len(in.raw.BaseModels) > 0 {
		in.raw.BaseModelMetrics = d.Config.BaseModelFeedMetrics
	}
	now := d.now()
	in.raw.Now = now

	// enforceBlockedBrowsingTagsForModels: the addons at the request's level. No tag filter reaches
	// here, so the blocked-tag short-circuit cannot fire.
	resolved := d.resolvedAddons(ctx, in.raw.BrowsingLevel)
	in.raw.DisablePoi = in.raw.DisablePoi || resolved.DisablePoi
	if !in.ignoreAddons {
		in.raw.DisableMinor = in.raw.DisableMinor || resolved.DisableMinor
		if len(resolved.ExcludedTagIDs) > 0 {
			in.raw.ExcludedTagIDs = uniqueInts(append(append([]int{}, in.raw.ExcludedTagIDs...), resolved.ExcludedTagIDs...))
		}
	}

	raws, nextCursor, err := d.getModelsRaw(ctx, &in.raw, in.hidePrivate)
	if err != nil {
		return nil, err
	}
	out := &withVersions{nextCursor: nextCursor}
	if len(raws) == 0 {
		return out, nil
	}
	parts, err := d.versionParts(ctx, raws, in.raw, now)
	if err != nil {
		return nil, err
	}
	for _, r := range raws {
		out.items = append(out.items, parts.item(r, coverageNext))
	}
	return out, nil
}

// getModelsRaw is the model statement and its transform: each row with its model data (versions
// filtered as getModelsRaw filters them), creator and paid-access gate.
func (d *Deps) getModelsRaw(ctx context.Context, in *RawInput, hidePrivate bool) ([]*rawItem, string, error) {
	text, args, err := RawQuery(in)
	if err != nil {
		return nil, "", err
	}
	maps, err := queryRows(ctx, d.DB, text, args...)
	if err != nil {
		return nil, "", err
	}
	rows := make([]ModelRow, 0, len(maps))
	for _, m := range maps {
		r, err := modelRowFrom(m)
		if err != nil {
			return nil, "", err
		}
		rows = append(rows, r)
	}
	nextCursor := ""
	if in.Take > 0 && len(rows) > in.Take {
		// The popped lookahead row is the cursor (the predicate is inclusive on the last field).
		if c := rows[len(rows)-1].CursorID; c != nil {
			nextCursor = *c
		}
		rows = rows[:len(rows)-1]
	}
	if len(rows) == 0 {
		return nil, nextCursor, nil
	}
	modelIDs := make([]int, len(rows))
	userIDs := make([]int, len(rows))
	for i, r := range rows {
		modelIDs[i] = r.ID
		userIDs[i] = r.UserID
	}

	var (
		users    map[int]hydrate.BasicUser
		pictures map[int]superjson.Object
		data     map[int]*modelData
		gated    map[int]bool
	)
	g := d.group(ctx)
	g.Go(func(ctx context.Context) (err error) { users, pictures, err = d.Sources.Users(ctx, userIDs); return })
	g.Go(func(ctx context.Context) (err error) { data, err = d.modelData(ctx, modelIDs); return })
	g.Go(func(ctx context.Context) (err error) { gated, err = d.paidAccessGates(ctx, modelIDs); return })
	if err := g.Wait(); err != nil {
		return nil, "", err
	}

	showSfwFace := showsSfwFace(in.BrowsingLevel)
	excluded := make(map[int]bool, len(in.ExcludedTagIDs))
	for _, id := range in.ExcludedTagIDs {
		excluded[id] = true
	}
	items := make([]*rawItem, 0, len(rows))
	for _, r := range rows {
		md := data[r.ID]
		if md == nil {
			continue
		}
		versions := make([]superjson.Object, 0, len(md.versions))
		for _, v := range md.versions {
			nv := cloneObject(v)
			flags, _ := intOf(getVal(v, "flags"))
			nv.Set("flags", int64(flags&^partnerFlags))
			if showSfwFace && r.SfwName != nil {
				nv.Set("description", "")
			}
			if s, _ := getVal(nv, "status").(string); s != "Published" {
				continue
			}
			lvl, _ := intOf(getVal(nv, "nsfwLevel"))
			bm, _ := getVal(nv, "baseModel").(string)
			if lvl&browsing.NSFWLevels != 0 && isMatureRestrictedForModels(bm) {
				continue
			}
			if hidePrivate {
				if a, _ := getVal(nv, "availability").(string); a != "Public" {
					continue
				}
			}
			versions = append(versions, nv)
		}
		allBaseModels := []any{}
		seen := map[any]bool{}
		for _, v := range versions {
			bm := getVal(v, "baseModel")
			if !seen[bm] {
				seen[bm] = true
				allBaseModels = append(allBaseModels, bm)
			}
		}
		if len(in.BaseModels) > 0 {
			kept := versions[:0:0]
			for _, v := range versions {
				if bm, _ := getVal(v, "baseModel").(string); containsString(in.BaseModels, bm) {
					kept = append(kept, v)
				}
			}
			versions = kept
		}
		if len(versions) == 0 {
			continue
		}
		if len(excluded) > 0 {
			hit := false
			for _, t := range md.tags {
				if excluded[t.id] {
					hit = true
					break
				}
			}
			if hit {
				continue
			}
		}
		u := users[r.UserID]
		c := creator{username: u.Username, picture: pictures[r.UserID]}
		if s, ok := u.Username.(string); ok && s == "civitai" {
			c.hidden = true
		}
		items = append(items, &rawItem{
			row: r, versions: versions, allBaseModels: allBaseModels, tags: md.tags, gated: gated[r.ID], creator: c,
			sfwFace: showSfwFace,
		})
	}
	return items, nextCursor, nil
}

// showsSfwFace is showsSfwFace: a level with no mature bits.
func showsSfwFace(level int) bool {
	return level != 0 && level&browsing.NSFWLevels == 0
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func getVal(o superjson.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

func cloneObject(o superjson.Object) superjson.Object {
	return append(make(superjson.Object, 0, len(o)+4), o...)
}

// omit is `{ k1, k2, ...rest }`: o without the keys, order kept.
func omit(o superjson.Object, keys ...string) superjson.Object {
	out := make(superjson.Object, 0, len(o))
	for _, f := range o {
		skip := false
		for _, k := range keys {
			if f.Key == k {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, f)
		}
	}
	return out
}

func nullable[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func stringsToAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

// baseObject is the getModelsWithVersions item's own keys, in order: the getModelsRaw row (with the
// .com face applied, hasSfwFace appended) less what getModelsWithVersions destructures, then
// supportsGeneration and stats (modelVersions, tagsOnModels and user are kept apart, see item).
func baseObject(r *rawItem, supportsGeneration bool, stats superjson.Object) superjson.Object {
	row := r.row
	name := any(row.Name)
	desc := nullable(row.Description)
	if r.sfwFace && row.SfwName != nil {
		name = *row.SfwName
		desc = nullable(row.SfwDescription)
	}
	hasSfwFace := row.SfwName != nil && row.SfwCoverImageID != nil && row.NsfwLevel&browsing.SFWLevels != 0
	var acu any
	if row.AllowCommercialUse != nil {
		acu = stringsToAny(row.AllowCommercialUse)
	}
	return superjson.Object{
		{Key: "id", Val: int64(row.ID)},
		{Key: "name", Val: name},
		{Key: "coverImageId", Val: nullable(row.CoverImageID)},
		{Key: "sfwCoverImageId", Val: nullable(row.SfwCoverImageID)},
		{Key: "description", Val: desc},
		{Key: "allowNoCredit", Val: row.AllowNoCredit},
		{Key: "allowCommercialUse", Val: acu},
		{Key: "allowDerivatives", Val: row.AllowDerivatives},
		{Key: "allowDifferentLicense", Val: row.AllowDifferentLicense},
		{Key: "type", Val: row.Type},
		{Key: "minor", Val: row.Minor},
		{Key: "sfwOnly", Val: row.SfwOnly},
		{Key: "poi", Val: row.Poi},
		{Key: "nsfw", Val: row.Nsfw},
		{Key: "nsfwLevel", Val: int64(row.NsfwLevel)},
		{Key: "mode", Val: nullable(row.Mode)},
		{Key: "availability", Val: row.Availability},
		{Key: "userId", Val: int64(row.UserID)},
		{Key: "hasActivePaidAccess", Val: r.gated},
		{Key: "hasSfwFace", Val: hasSfwFace},
		{Key: "baseModels", Val: r.allBaseModels},
		{Key: "cosmetic", Val: nil},
		{Key: "eventDecoration", Val: nil},
		{Key: "supportsGeneration", Val: supportsGeneration},
		{Key: "stats", Val: stats},
	}
}
