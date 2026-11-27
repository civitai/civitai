package v1models

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Cache keys (REDIS_KEYS.CACHES), without the per-id suffix.
const (
	KeyDataForModel        = "packed:caches:data-for-model-2"
	KeyModelTags           = "packed:caches:model-tags"
	KeyBasicTags           = "packed:caches:basic-tags"
	KeyFilesForVersion     = hydrate.KeyVersionFiles
	KeyPaidAccessVersion   = "packed:caches:paid-access:ModelVersion"
	KeyMetricPrivacy       = "packed:caches:user-metric-privacy-defaults"
	KeyMembershipValid     = "packed:caches:creator-membership-valid"
	KeyPublicModelResponse = "packed:caches:public-model-response"
)

// The TTL of the caches whose stale entries Node revalidates (staleWhileRevalidate on): a stale entry
// is refetched there, so it falls back here.
const ttlDay = 24 * time.Hour

// modelData is one dataForModelsCache record after its appendFn (the tags from modelTagCache).
type modelData struct {
	versions []superjson.Object
	tags     []modelTag
}

type modelTag struct {
	id   int
	name any
}

// computeDataMisses answers the ids dataForModelsCache holds no entry for (no key, a bust's debounce
// marker, an undecodable value) as Node's fetch does: its lookupFn's queries
// (hydrate.Sources.ComputeModelData). Node's lookup is lag-aware: a model a recent write flagged is
// read on the primary. So a missed model whose lag flag is set is looked up only where this service
// reads the primary for it too: a public request (m.write) with model-data written back
// (FEED_GO_CACHE_WRITEBACK), whose lookup reads the primary for a flagged model (lagAwareDB);
// anywhere else it still falls back (`v1-models-data-miss`), as does every miss without the miss
// computation. A flag read that fails (no flag found set) falls back as `v1-models-lag-flag-failed`,
// and a miss that is a failed cache GET (failed) as `v1-models-data-read-failed` wherever it would
// otherwise fall back as a miss: a read failure is never reported as a content miss. On a public
// request the misses Node would write back (writable: no key, or an undecodable value; never a
// debounce marker or a failed GET) are written, as model.getAll writes them; a shadow sample
// writes nothing.
func (d *Deps) computeDataMisses(ctx context.Context, ids []int, entries map[int]hydrate.OrderedEntry, failed map[int]error,
	writable map[int]bool, m missServe) error {
	var missed []int
	for _, id := range ids {
		if _, ok := entries[id]; !ok {
			missed = append(missed, id)
		}
	}
	if len(missed) == 0 {
		return nil
	}
	if d.Sources == nil || d.Sources.Compute == nil {
		return dataMiss(missed, failed)
	}
	readsPrimary := m.write && d.Sources.WritesBack(hydrate.MissModelData)
	flagged, err := d.Sources.ModelLagFlagged(ctx, missed)
	if flagged && !readsPrimary {
		return dataMiss(missed, failed)
	}
	if err != nil && !flagged {
		return fallback.Wrap("v1-models-lag-flag-failed", err)
	}
	if !m.write {
		writable = nil
	}
	computed, ok, err := d.Sources.ComputeModelData(ctx, missed, writable)
	if err != nil {
		return err
	}
	if !ok {
		return dataMiss(missed, failed)
	}
	for _, id := range missed {
		if e, ok := computed[id]; ok {
			entries[id] = e
		}
	}
	return nil
}

// dataMiss is the fallback for model-data misses: `v1-models-data-read-failed` when any of them is a
// cache GET that failed (failed, hydrate.OrderedRead.Failed), else `v1-models-data-miss`.
func dataMiss(missed []int, failed map[int]error) error {
	if err := firstFailed(missed, failed); err != nil {
		return fallback.Wrap("v1-models-data-read-failed", err)
	}
	return fallback.New("v1-models-data-miss")
}

// tagsRead is the ids whose model-tags entry modelData reads: those with a model-data entry that is
// not a notFound marker.
func tagsRead(ids []int, data map[int]hydrate.OrderedEntry) []int {
	out := make([]int, 0, len(ids))
	for _, id := range ids {
		if e, ok := data[id]; ok && !e.NotFound {
			out = append(out, id)
		}
	}
	return out
}

// firstFailed is the read error of the first of ids in failed; nil when none failed. Each content
// fallback of a cache read asks it over ALL the ids that read answers, not only the id at hand, so a
// failed GET anywhere in the read wins over a content miss or stale entry, whatever the id order.
func firstFailed(ids []int, failed map[int]error) error {
	if len(failed) == 0 {
		return nil
	}
	for _, id := range ids {
		if err, ok := failed[id]; ok {
			return err
		}
	}
	return nil
}

// modelData is dataForModelsCache.fetch with its appendFn: each model's record, its `tags` replaced
// by modelTagCache's (whose own appendFn names them from tagCache). Each miss is computed where m
// says (missServe; DESIGN.md §16.7), else falls back: a model-data miss (computeDataMisses), a
// model-tags miss (computeTagsMisses), a stale tag name (named by tagCache's lookup on the replica
// with m.tagNameStale, as the Node reader that wins the revalidate lock names it). A tag the tag
// cache does not hold is named by tagCache's own lookup on the replica with Config.ComputeMisses
// (FEED_GO_COMPUTE_MISSES), else falls back. Where a read would fall back on content (a miss, a
// stale entry) and any of its GETs failed (hydrate.OrderedRead.Failed), the reason is that cache's
// `-read-failed` one.
func (d *Deps) modelData(ctx context.Context, ids []int, m missServe) (map[int]*modelData, error) {
	ids = hydrate.Unique(ids)
	b := hydrate.NewBatch()
	data := d.Packed.QueueOrdered(b, KeyDataForModel, ids, 0)
	tags := d.Packed.QueueOrdered(b, KeyModelTags, ids, 0)
	b.Exec(ctx)
	dataEntries, tagEntries := data.Entries(), tags.Entries()
	dataFailed, tagsFailed := data.Failed(), tags.Failed()
	if m.data {
		if err := d.computeDataMisses(ctx, ids, dataEntries, dataFailed, data.Writable(), m); err != nil {
			return nil, err
		}
	}
	if m.tags {
		if err := d.computeTagsMisses(ctx, ids, dataEntries, tagEntries, tagsFailed, tags.Writable(), m); err != nil {
			return nil, err
		}
	}
	out := make(map[int]*modelData, len(ids))
	tagIDs := make([]int, 0, len(ids)*4)
	tagIDsOf := map[int][]int{}
	for _, id := range ids {
		e, ok := dataEntries[id]
		if !ok {
			// Over every id still without an entry (a computed miss has one now), not only this one.
			var absent []int
			for _, x := range ids {
				if _, ok := dataEntries[x]; !ok {
					absent = append(absent, x)
				}
			}
			return nil, dataMiss(absent, dataFailed)
		}
		if e.NotFound {
			continue
		}
		md := &modelData{}
		if list, ok := getVal(e.Value, "versions").([]any); ok {
			for _, v := range list {
				if o, ok := v.(superjson.Object); ok {
					md.versions = append(md.versions, o)
				}
			}
		}
		if list, ok := getVal(e.Value, "tags").([]any); ok {
			for _, t := range list {
				if o, ok := t.(superjson.Object); ok {
					tid, _ := intOf(getVal(o, "tagId"))
					md.tags = append(md.tags, modelTag{id: tid, name: getVal(o, "name")})
				}
			}
		}
		out[id] = md
		te, ok := tagEntries[id]
		if !ok {
			if err := firstFailed(tagsRead(ids, dataEntries), tagsFailed); err != nil {
				return nil, fallback.Wrap("v1-models-tags-read-failed", err)
			}
			return nil, fallback.New("v1-models-tags-miss")
		}
		if te.NotFound {
			continue // `if (!modelTagsData) continue`: the record keeps its own tags
		}
		list, _ := getVal(te.Value, "tagIds").([]any)
		ts := make([]int, 0, len(list))
		for _, t := range list {
			if n, ok := intOf(t); ok {
				ts = append(ts, n)
			}
		}
		tagIDsOf[id] = ts
		tagIDs = append(tagIDs, ts...)
	}
	if len(tagIDsOf) == 0 {
		return out, nil
	}
	tagIDs = hydrate.Unique(tagIDs)
	tb := hydrate.NewBatch()
	names := d.Packed.QueueOrdered(tb, KeyBasicTags, tagIDs, ttlDay)
	tb.Exec(ctx)
	nameEntries, namesFailed := names.Entries(), names.Failed()
	tagNames := make(map[int]any, len(tagIDs))
	var missed []int
	for _, id := range tagIDs {
		e, ok := nameEntries[id]
		if !ok {
			missed = append(missed, id)
			continue
		}
		if e.Stale {
			if m.tagNameStale && d.Config.ComputeMisses {
				// Revalidated as the Node reader that wins the lock revalidates it: looked up below.
				missed = append(missed, id)
				continue
			}
			if err := firstFailed(tagIDs, namesFailed); err != nil && !d.Config.ComputeMisses {
				return nil, fallback.Wrap("v1-models-tag-name-read-failed", err)
			}
			return nil, fallback.New("v1-models-tag-name-stale")
		}
		if !e.NotFound {
			tagNames[id] = getVal(e.Value, "name")
		}
	}
	if len(missed) > 0 {
		if !d.Config.ComputeMisses {
			if err := firstFailed(missed, namesFailed); err != nil {
				return nil, fallback.Wrap("v1-models-tag-name-read-failed", err)
			}
			return nil, fallback.New("v1-models-tag-name-miss")
		}
		if err := d.lookupTagNames(ctx, missed, tagNames); err != nil {
			return nil, err
		}
	}
	for modelID, ts := range tagIDsOf {
		tags := make([]modelTag, 0, len(ts))
		for _, tid := range ts {
			name, ok := tagNames[tid]
			if !ok {
				continue // `.filter(isDefined)`: a notFound marker, or no such tag
			}
			tags = append(tags, modelTag{id: tid, name: name})
		}
		out[modelID].tags = tags
	}
	return out, nil
}

// computeTagsMisses answers the model-tags misses (no key, a debounce marker, an undecodable value)
// of the models the data cache answered with a record (tagsRead: the ids modelTagCache.fetch is
// asked for), with modelTagCache's lookup on the replica, as Node's fetch reads it
// (hydrate.Sources.ComputeModelTags): each model's `{modelId, tagIds}` record, or its notFound marker
// for a model with no tag. On a public request (m.write) the misses Node would write back are
// written where FEED_GO_CACHE_WRITEBACK lists model-tags. A failed GET among the asked ids leaves
// everything uncomputed: modelData then falls back as `v1-models-tags-read-failed`. Without the miss
// computation nothing is computed (modelData falls back as `v1-models-tags-miss`). The lookup has no
// ORDER BY (Node's findMany sends none), so a model's tag order is the replica's row order, here as
// in Node's own lookup.
func (d *Deps) computeTagsMisses(ctx context.Context, ids []int, dataEntries, tagEntries map[int]hydrate.OrderedEntry,
	failed map[int]error, writable map[int]bool, m missServe) error {
	for _, id := range ids {
		if _, ok := dataEntries[id]; !ok {
			return nil // a model-data miss left: the request falls back on it, so nothing is looked up
		}
	}
	asked := tagsRead(ids, dataEntries)
	var missed []int
	for _, id := range asked {
		if _, ok := tagEntries[id]; !ok {
			missed = append(missed, id)
		}
	}
	if len(missed) == 0 || firstFailed(asked, failed) != nil || d.Sources == nil || d.Sources.Compute == nil {
		return nil
	}
	if !m.write {
		writable = nil
	}
	computed, ok, err := d.Sources.ComputeModelTags(ctx, missed, writable)
	if err != nil || !ok {
		return err
	}
	for _, id := range missed {
		if e, ok := computed[id]; ok {
			tagEntries[id] = e
		}
	}
	return nil
}

// lookupTagNames is tagCache's lookupFn on the replica (dbRead), reduced to the name this endpoint
// reads: a tag the replica does not hold is absent, as the lookup leaves it. Nothing is written back.
func (d *Deps) lookupTagNames(ctx context.Context, ids []int, into map[int]any) error {
	rows, err := queryRows(ctx, d.DB, `SELECT id, name FROM "Tag" WHERE id = ANY($1::int[])`, ids)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if id, ok := intOf(r["id"]); ok {
			into[id] = r["name"]
		}
	}
	return nil
}

// paidAccessGates is getModelPaidAccessGates: the models with a live gate.
func (d *Deps) paidAccessGates(ctx context.Context, modelIDs []int) (map[int]bool, error) {
	out := map[int]bool{}
	if len(modelIDs) == 0 {
		return out, nil
	}
	rows, err := queryRows(ctx, d.DB, `SELECT mv."modelId", MAX(pa."endsAt") AS deadline
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion'
      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
      AND mv.status = 'Published'::"ModelStatus"
      AND mv."modelId" = ANY($1::int[])
    GROUP BY mv."modelId"`, modelIDs)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if id, ok := intOf(r["modelId"]); ok {
			out[id] = true
		}
	}
	return out, nil
}

// versionParts is what getModelsWithVersions reads for the page's versions.
type versionParts struct {
	paid       map[int]superjson.Object // getPublicPaidAccessForModelVersions
	images     map[int][]superjson.Object
	files      map[int][]superjson.Object
	vaeFiles   map[int][]superjson.Object // by the version the VAE is linked from
	modelStats map[int]superjson.Object
	verStats   map[int]map[string]int
	verMeta    map[int]map[string]any
	privacy    map[int]map[string]bool // getUserMetricPrivacyDefaultsMap
	membership map[int]bool
	showsImage func(superjson.Object) bool
}

// versionParts reads, for raws' versions: paid access, showcase images (held to each flagged model's
// gallery level, then the showcase filter), files and linked VAE files, version and model metrics and
// version meta, and the creators' metric-privacy settings.
func (d *Deps) versionParts(ctx context.Context, raws []*rawItem, in RawInput, now time.Time) (*versionParts, error) {
	versionIDs := make([]int, 0, len(raws)*2)
	modelIDs := make([]int, 0, len(raws))
	ownerIDs := make([]int, 0, len(raws))
	flagged := make([]*rawItem, 0, len(raws))
	modelOf := map[int]*rawItem{}
	for _, r := range raws {
		modelIDs = append(modelIDs, r.row.ID)
		ownerIDs = append(ownerIDs, r.row.UserID)
		for _, v := range r.versions {
			if id, ok := intOf(getVal(v, "id")); ok {
				versionIDs = append(versionIDs, id)
				modelOf[id] = r
			}
		}
		if r.row.Minor || r.row.SfwOnly {
			flagged = append(flagged, r)
		}
	}
	ownerIDs = hydrate.Unique(ownerIDs)
	p := &versionParts{}

	b := hydrate.NewBatch()
	paidRead := d.Packed.QueueOrdered(b, KeyPaidAccessVersion, versionIDs, 0)
	filesRead := d.Packed.QueueOrdered(b, KeyFilesForVersion, versionIDs, ttlDay)
	privacyRead := d.Packed.QueueOrdered(b, KeyMetricPrivacy, ownerIDs, 0)
	showcaseRead := d.Packed.QueueShowcases(b, versionIDs)
	b.Exec(ctx)

	g := d.group(ctx)
	var (
		held     map[int]int // model id -> held level
		stats    *versionStats
		images   map[int][]superjson.Object
		paidMiss []int
		privMiss []int
	)
	p.paid = map[int]superjson.Object{}
	paidEntries := paidRead.Entries()
	for _, id := range versionIDs {
		e, ok := paidEntries[id]
		if !ok {
			paidMiss = append(paidMiss, id)
			continue
		}
		if e.NotFound {
			continue
		}
		var endsAt any
		if ms, ok := numberOf(getVal(e.Value, "endsAtMs")); ok {
			endsAt = time.UnixMilli(int64(ms)).UTC()
		}
		if dto := publicPaidAccess(endsAt, getVal(e.Value, "timeframeDays"), now); dto != nil {
			p.paid[id] = dto
		}
	}
	p.privacy = map[int]map[string]bool{}
	privEntries := privacyRead.Entries()
	for _, id := range ownerIDs {
		e, ok := privEntries[id]
		if !ok || e.NotFound {
			privMiss = append(privMiss, id)
			continue
		}
		p.privacy[id] = privacyFlags(e.Value)
	}
	if len(paidMiss) > 0 {
		g.Go(func(ctx context.Context) error { return d.paidAccessFromDB(ctx, paidMiss, now, p.paid) })
	}
	if len(privMiss) > 0 {
		privDB := map[int]map[string]bool{}
		g.Go(func(ctx context.Context) error {
			if err := d.privacyFromDB(ctx, privMiss, privDB); err != nil {
				return err
			}
			for k, v := range privDB {
				p.privacy[k] = v
			}
			return nil
		})
	}
	// The showcase images: getImagesForModelVersionCache, read as model.getAll reads it
	// (hydrate.Sources.VersionImages: the appendFn's minor and selectable-level filter and each
	// image's tag ids; with FEED_GO_COMPUTE_MISSES a miss computed and a stale entry revalidated).
	g.Go(func(ctx context.Context) (err error) { images, err = d.Sources.VersionImages(ctx, versionIDs); return })
	g.Go(func(ctx context.Context) (err error) { held, err = d.heldLevels(ctx, flagged); return })
	g.Go(func(ctx context.Context) (err error) { stats, err = d.versionStats(ctx, modelIDs, versionIDs); return })
	if err := g.Wait(); err != nil {
		return nil, err
	}

	// Showcase images: held (holdShowcaseImages), then filtered (getShowcaseImageFilter, below). A
	// version VersionImages leaves out has a notFound entry: no images.
	p.images = map[int][]superjson.Object{}
	listed := make([]int, 0, len(versionIDs))
	for _, vid := range versionIDs {
		cached, ok := images[vid]
		if !ok {
			continue
		}
		listed = append(listed, vid)
		imgs := make([]superjson.Object, 0, len(cached))
		lvl, isHeld := held[modelOf[vid].row.ID]
		for _, o := range cached {
			if isHeld {
				nl, _ := intOf(getVal(o, "nsfwLevel"))
				if nl&lvl == 0 {
					continue
				}
			}
			imgs = append(imgs, o)
		}
		p.images[vid] = imgs
	}
	if err := curatedShowcaseGuard(ctx, d.Sources, showcaseRead, listed, in.misses.showcase); err != nil {
		return nil, err
	}
	p.showsImage = d.showcaseFilter(ctx, in)

	// Files, then the linked VAE versions' primary files.
	p.files = map[int][]superjson.Object{}
	fileEntries, filesFailed := filesRead.Entries(), filesRead.Failed()
	if in.misses.files {
		if err := d.computeFilesMisses(ctx, versionIDs, fileEntries, filesFailed, filesRead.Writable(), in.misses); err != nil {
			return nil, err
		}
	}
	for _, vid := range versionIDs {
		e, ok := fileEntries[vid]
		if !ok {
			if err := firstFailed(versionIDs, filesFailed); err != nil {
				return nil, fallback.Wrap("v1-models-files-read-failed", err)
			}
			return nil, fallback.New("v1-models-files-miss")
		}
		if e.Stale {
			if err := firstFailed(versionIDs, filesFailed); err != nil {
				return nil, fallback.Wrap("v1-models-files-read-failed", err)
			}
			return nil, fallback.New("v1-models-files-stale")
		}
		if e.NotFound {
			continue
		}
		list, _ := getVal(e.Value, "files").([]any)
		files := make([]superjson.Object, 0, len(list))
		for _, x := range list {
			if o, ok := x.(superjson.Object); ok {
				files = append(files, o)
			}
		}
		p.files[vid] = files
	}
	p.vaeFiles = map[int][]superjson.Object{}
	if len(stats.vaeOf) > 0 {
		vaeIDs := make([]int, 0, len(stats.vaeOf))
		for _, vae := range stats.vaeOf {
			vaeIDs = append(vaeIDs, vae)
		}
		vaeIDs = hydrate.Unique(vaeIDs)
		byVersion, err := d.vaeFiles(ctx, vaeIDs)
		if err != nil {
			return nil, err
		}
		for host, vae := range stats.vaeOf {
			p.vaeFiles[host] = byVersion[vae]
		}
	}
	p.modelStats, p.verStats, p.verMeta = stats.model, stats.version, stats.meta

	// Membership: only owners that hide something on the model or by default are looked up.
	candidates := make([]int, 0, len(raws))
	for _, r := range raws {
		if anyHidden(metaHidden(r.row.Meta)) || anyHidden(userHidden(p.privacy[r.row.UserID])) {
			candidates = append(candidates, r.row.UserID)
		}
	}
	candidates = hydrate.Unique(candidates)
	p.membership = map[int]bool{}
	if len(candidates) > 0 {
		// The value is a packed boolean, not a record (getValidCreatorMembershipMap's own mGet).
		vals, failed := d.membershipBools(ctx, candidates)
		for _, id := range candidates {
			v, ok := vals[id]
			if !ok {
				if err := firstFailed(candidates, failed); err != nil {
					return nil, fallback.Wrap("v1-models-membership-read-failed", err)
				}
				return nil, fallback.New("v1-models-membership-miss")
			}
			p.membership[id] = v
		}
	}
	return p, nil
}

// computeFilesMisses answers the version-files entries the read left unanswered (no key, a bust's
// debounce marker, an undecodable value) and revalidates the stale ones (past the cache's day,
// staleWhileRevalidate), as filesForModelVersionCache.fetch does, with its lookup on the replica
// (hydrate.Sources.ComputeVersionFiles: Node's lookup reads dbRead). On a public request (m.write)
// with version-files written back, the misses Node would write back are written and each stale entry
// is revalidated under Node's revalidate lock; a stale entry whose lock another reader holds is
// served as it is, as Node's lock loser serves it. A failed GET anywhere in the read leaves
// everything uncomputed (versionParts then falls back as `v1-models-files-read-failed`): a read
// failure is never answered as a content miss. Without the miss computation nothing is computed.
func (d *Deps) computeFilesMisses(ctx context.Context, ids []int, entries map[int]hydrate.OrderedEntry, failed map[int]error,
	writable map[int]bool, m missServe) error {
	if firstFailed(ids, failed) != nil || d.Sources == nil || d.Sources.Compute == nil {
		return nil
	}
	var missing, stale []int
	seen := make(map[int]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		e, ok := entries[id]
		switch {
		case !ok:
			missing = append(missing, id)
		case e.Stale:
			stale = append(stale, id)
		}
	}
	if len(missing)+len(stale) == 0 {
		return nil
	}
	if !m.write {
		writable = nil
	}
	computed, ok, err := d.Sources.ComputeVersionFiles(ctx, missing, stale, writable, m.write)
	if err != nil || !ok {
		return err
	}
	for id, e := range computed {
		entries[id] = e
	}
	for _, id := range stale {
		if e := entries[id]; e.Stale {
			// Another reader holds the revalidate lock: served as Node's lock loser serves it.
			e.Stale = false
			entries[id] = e
		}
	}
	return nil
}

// numberOf reads a cached number (an integer or a float) as a float64.
func numberOf(v any) (float64, bool) {
	if f, ok := v.(float64); ok {
		return f, true
	}
	n, ok := intOf(v)
	return float64(n), ok
}

// publicPaidAccess is toPublicPaidAccessDto: an active gate (no end, or an end ahead) as
// `{ permanent, endsAt }`; nil otherwise.
func publicPaidAccess(endsAt any, timeframeDays any, now time.Time) superjson.Object {
	if t, ok := endsAt.(time.Time); ok && !t.After(now) {
		return nil
	}
	return superjson.Object{
		{Key: "permanent", Val: timeframeDays == nil},
		{Key: "endsAt", Val: endsAt},
	}
}

// paidAccessFromDB is the paid-access cache's lookup for its misses (the columns the public DTO reads).
func (d *Deps) paidAccessFromDB(ctx context.Context, ids []int, now time.Time, out map[int]superjson.Object) error {
	rows, err := queryRows(ctx, d.DB, `SELECT "entityId", "endsAt", "timeframeDays" FROM "PaidAccess"
    WHERE "entityType" = 'ModelVersion' AND "entityId" = ANY($1::int[])`, ids)
	if err != nil {
		return err
	}
	for _, r := range rows {
		id, ok := intOf(r["entityId"])
		if !ok {
			continue
		}
		var endsAt any
		if t, ok := timeOf(r["endsAt"]); ok {
			endsAt = t
		}
		var tf any
		if n, ok := intOf(r["timeframeDays"]); ok && r["timeframeDays"] != nil {
			tf = int64(n)
		}
		if dto := publicPaidAccess(endsAt, tf, now); dto != nil {
			out[id] = dto
		}
	}
	return nil
}

func privacyFlags(o superjson.Object) map[string]bool {
	out := map[string]bool{}
	for _, k := range []string{"hideModelBuzz", "hideModelDownloads", "hideModelGenerations"} {
		out[k] = getVal(o, k) == true
	}
	return out
}

// privacyFromDB is getUserMetricPrivacyDefaultsMap's miss path: the three flags off User.settings
// (a user without a row reads all-false).
func (d *Deps) privacyFromDB(ctx context.Context, ids []int, out map[int]map[string]bool) error {
	rows, err := queryRows(ctx, d.DB, `SELECT id, settings FROM "User" WHERE id = ANY($1::int[])`, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		out[id] = map[string]bool{"hideModelBuzz": false, "hideModelDownloads": false, "hideModelGenerations": false}
	}
	for _, r := range rows {
		id, ok := intOf(r["id"])
		if !ok {
			continue
		}
		s := jsonObject(r["settings"])
		out[id] = map[string]bool{
			"hideModelBuzz":        truthyJS(s["hideModelBuzz"]),
			"hideModelDownloads":   truthyJS(s["hideModelDownloads"]),
			"hideModelGenerations": truthyJS(s["hideModelGenerations"]),
		}
	}
	return nil
}

// truthyJS is `!!v` for a decoded JSON value.
func truthyJS(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	return true
}

// membershipBools reads the creator-membership-valid values, packed booleans (no record, no
// cachedAt), in one pipeline. An id absent from the answer is a miss (no key, a read failure, or not
// a boolean); failed holds the ids whose GET failed other than for redis.Nil, with the error (nil
// when none did).
func (d *Deps) membershipBools(ctx context.Context, ids []int) (out map[int]bool, failed map[int]error) {
	out = map[int]bool{}
	if d.Packed == nil || d.Packed.Redis == nil || len(ids) == 0 {
		return out, nil
	}
	cmds := make([]*redis.StringCmd, len(ids))
	_, _ = d.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			cmds[i] = p.Get(ctx, d.Packed.Prefix+KeyMembershipValid+":"+itoa(id))
		}
		return nil
	})
	for i, cmd := range cmds {
		raw, err := cmd.Bytes()
		if err != nil && !errors.Is(err, redis.Nil) {
			if failed == nil {
				failed = map[int]error{}
			}
			failed[ids[i]] = err
			continue
		}
		if err != nil || len(raw) == 0 {
			continue
		}
		v, err := hydrate.Unpack(raw)
		if err != nil {
			continue
		}
		if b, ok := v.(bool); ok {
			out[ids[i]] = b
		}
	}
	return out, failed
}

// heldLevels is getShowcaseHeldLevels for models whose flags the row carries: each minor or SFW-only
// model's level, the cached gallery level when the settings hold it, else the model's limit. A
// settings key Node would rebuild falls back.
func (d *Deps) heldLevels(ctx context.Context, flagged []*rawItem) (map[int]int, error) {
	out := map[int]int{}
	for _, r := range flagged {
		if d.Gallery == nil {
			return nil, fallback.New("v1-models-gallery-unconfigured")
		}
		s, err := d.Gallery.Settings(ctx, r.row.ID)
		if err != nil {
			return nil, err
		}
		if s != nil && s.SfwHeld != nil && *s.SfwHeld {
			if s.Level == nil {
				return nil, fallback.New("v1-models-held-level-unset")
			}
			out[r.row.ID] = *s.Level
			continue
		}
		// heldGalleryLevel(undefined, flags): the model's limit (minor and SFW-only are both PG|PG-13).
		out[r.row.ID] = browsing.SFWLevels
	}
	return out, nil
}

// showcaseFilter is getShowcaseImageFilter for a signed-out viewer: the addons at the request's level
// (none skipped: the rules target names no owner), plus the input's excluded tags, tested against
// each image's `tags` (the appendFn's tag ids, VersionImages).
func (d *Deps) showcaseFilter(ctx context.Context, in RawInput) func(superjson.Object) bool {
	resolved := d.resolvedAddons(ctx, in.BrowsingLevel)
	excluded := map[int]bool{}
	for _, id := range resolved.ExcludedTagIDs {
		excluded[id] = true
	}
	for _, id := range in.ExcludedTagIDs {
		excluded[id] = true
	}
	return func(img superjson.Object) bool {
		if resolved.DisablePoi && getVal(img, "poi") == true {
			return false
		}
		if resolved.DisableMinor && getVal(img, "minor") == true {
			return false
		}
		if len(excluded) == 0 {
			return true
		}
		// `image.tags != null && !image.tags.some(...)` (getShowcaseImageFilter): while any tag is
		// excluded, an image with no tags list is hidden. VersionImages always sets one ([] for an image
		// the tag cache holds no entry for), so this only bites a source that does not, which must
		// hide, never show.
		tags, ok := getVal(img, "tags").([]any)
		if !ok {
			return false
		}
		for _, t := range tags {
			if n, ok := intOf(t); ok && excluded[n] {
				return false
			}
		}
		return true
	}
}

// curatedShowcaseGuard stands in for withCuratedShowcases (src/server/services/version-showcase.service.ts),
// which getModelsWithVersions runs over the images-for-version entries it read (`curate`): a version
// whose creator curated its showcase serves that list in place of its own images. That is not ported,
// so the request falls back unless every listed version (an images entry that is not a notFound
// marker, Object.keys of Node's answer) is uncurated: a fresh uncurated entry, or, for a version with
// no usable entry and the miss computation on, no row on the replica (hydrate.Sources.ShowcaseState;
// a failed query, a failed cache GET or a failed lag-flag read is v1-models-showcase-miss-failed, never
// a curation or a miss). With readThrough (missServe.showcase) a miss Node's fetch would look up is
// decided as Node decides it (hydrate.Sources.ShowcaseStateReadThrough: a debounce marker looked up,
// a lag-flagged version on the primary). Not gated on Node's
// `model-version-showcase-serve` flag: off, a fallback here is only a lost answer, never a different
// one (DESIGN.md §16.9).
func curatedShowcaseGuard(ctx context.Context, s *hydrate.Sources, r *hydrate.ShowcaseRead, listed []int, readThrough bool) error {
	state := s.ShowcaseState
	if readThrough {
		state = s.ShowcaseStateReadThrough
	}
	st, err := state(ctx, r, listed)
	if err != nil {
		return fallback.Wrap("v1-models-showcase-miss-failed", err)
	}
	switch st {
	case hydrate.ShowcaseCurated:
		return fallback.New("v1-models-curated-showcase")
	case hydrate.ShowcaseUnknown:
		return fallback.New("v1-models-showcase-miss")
	case hydrate.ShowcaseStale:
		return fallback.New("v1-models-showcase-stale")
	}
	return nil
}
