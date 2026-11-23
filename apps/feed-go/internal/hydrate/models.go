package hydrate

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The model feed's caches (REDIS_KEYS.CACHES in packages/civitai-redis/src/client.ts), read as
// model.getAll's getModelsRaw and getModelsWithImagesAndModelVersions read them.
const (
	KeyDataForModel          = "packed:caches:data-for-model-2"
	KeyModelTags             = "packed:caches:model-tags"
	KeyBasicTags             = "packed:caches:basic-tags"
	KeyModelFrames           = "packed:caches:cosmetics2:Model"
	KeyModelEvents           = "packed:caches:cosmetics2:event:v2:Model"
	KeyVersionImages         = "packed:caches:images-for-model-version-2"
	KeyMetricPrivacyDefaults = "packed:caches:user-metric-privacy-defaults"
	KeyMembershipValid       = "packed:caches:creator-membership-valid"
)

// ModelData is one dataForModelsCache value after its appendFn: the model's versions (index order, as
// cached, each with the key order the cached record has: Entry.Ordered), its SHA256 hashes, and its
// tag ids (modelTagCache's ids that tagCache still holds).
type ModelData struct {
	Hashes   []any
	Versions []superjson.Object
	TagIDs   []int
}

// ModelPageRequest is the ids one getModelsRaw page hydrates. Duplicates and zeros are dropped.
type ModelPageRequest struct {
	OwnerIDs []int // every model's creator
	ModelIDs []int
	// VisibleEvents is the decoration events every viewer sees; empty = no decoration read.
	VisibleEvents map[string]bool
}

// ModelPage is getModelsRaw's parallel fetch, plus the owners' metric-privacy defaults
// getModelsWithImagesAndModelVersions reads for the same owners.
type ModelPage struct {
	Basic         map[int]BasicUser        // userBasicCache
	ProfilePics   map[int]superjson.Object // getProfilePicturesForUsers
	UserCosmetics map[int][]any            // getCosmeticsForUsers
	Data          map[int]ModelData        // dataForModelsCache (absent: the cache holds no row)
	Frames        map[int]superjson.Object // getCosmeticsForEntity(Model)
	Decorations   map[int]superjson.Object // getEventDecorationsForEntity(Model)
	// PrivacyDefaults is getUserMetricPrivacyDefaultsMap: every owner's three hide flags.
	PrivacyDefaults map[int]PrivacyDefaults
}

// PrivacyDefaults is one owner's UserMetricPrivacyDefaults.
type PrivacyDefaults struct{ Buzz, Downloads, Generations bool }

// ModelPage reads a page's hydration in two cache stages: one pipeline for every per-id key
// (users, profile pictures, user cosmetics, model data, model tags, model frames, decorations, the
// metric-privacy defaults), then one for the records the first stage names (cosmetics for the user
// cosmetics and the frames, basic tags for the model tags). The replica reads for misses run after,
// concurrently. With s.Compute the frame, decoration, model-data and model-tags misses are computed
// (fillModelFrames, fillModelEvents: the image lookups over the models; fillModelData,
// fillModelTags: the model caches' own lookups); a user-cosmetics miss falls back; the rest are
// read from the replica as the image feed's are (basic users, profile pictures, cosmetics) or as
// Node's origin does (tags by id, the privacy defaults). Under a Go-first probe (WithPresence) each call counts as a page.
func (s *Sources) ModelPage(ctx context.Context, req ModelPageRequest) (*ModelPage, error) {
	if p := presenceOf(ctx); p != nil {
		p.notePage()
	}
	owners, models := Unique(req.OwnerIDs), Unique(req.ModelIDs)
	out := &ModelPage{}
	stage1 := NewBatch()
	basic := s.Packed.Queue(stage1, KeyBasicUsers, owners, ttlDay)
	profilePics := s.Packed.Queue(stage1, KeyProfilePictures, owners, 0)
	userCosmetics := s.Packed.Queue(stage1, KeyUserCosmetics, owners, 0)
	privacy := s.Packed.Queue(stage1, KeyMetricPrivacyDefaults, owners, 0)
	data := s.Packed.Queue(stage1, KeyDataForModel, models, 0)
	tags := s.Packed.Queue(stage1, KeyModelTags, models, 0)
	frames := s.Packed.Queue(stage1, KeyModelFrames, models, 0)
	readEvents := len(models) > 0 && len(req.VisibleEvents) > 0
	var events *PackedRead
	if readEvents {
		events = s.Packed.Queue(stage1, KeyModelEvents, models, 0)
	}
	stage1.Exec(ctx)

	g, gctx := errgroup.WithContext(ctx)
	g.Go(safe.Go(func() (err error) { out.Basic, err = s.basicUsersFrom(gctx, owners, basic.Entries()); return }))
	g.Go(safe.Go(func() (err error) {
		out.ProfilePics, err = s.profilePicturesFrom(gctx, owners, profilePics.Entries())
		return
	}))
	g.Go(safe.Go(func() (err error) {
		out.PrivacyDefaults, err = s.privacyDefaultsFrom(gctx, owners, privacy.Entries())
		return
	}))
	g.Go(safe.Go(func() (err error) {
		out.Data, err = s.modelData(gctx, models, data, tags)
		return
	}))
	g.Go(safe.Go(func() (err error) {
		if !readEvents {
			out.Decorations = map[int]superjson.Object{}
			return nil
		}
		got, writable := events.read()
		if err := s.fillModelEvents(gctx, models, got, writable); err != nil {
			return err
		}
		out.Decorations, err = modelDecorations(models, got, req.VisibleEvents)
		return
	}))
	g.Go(safe.Go(func() (err error) {
		out.UserCosmetics, out.Frames, err = s.modelCosmetics(gctx, owners, models, userCosmetics, frames)
		return
	}))
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

// modelCosmetics is the second cosmetics stage: user cosmetics and the models' frames joined with one
// cosmetic-records read (as Page's pageCosmetics does for image frames).
func (s *Sources) modelCosmetics(ctx context.Context, owners, models []int, userCosmetics, frames *PackedRead) (map[int][]any, map[int]superjson.Object, error) {
	perUser, userCIDs, err := userCosmeticsFrom(owners, userCosmetics.Entries())
	if err != nil {
		return nil, nil, err
	}
	frameEntries, frameWritable := frames.read()
	if err := s.fillModelFrames(ctx, models, frameEntries, frameWritable); err != nil {
		return nil, nil, err
	}
	if miss := Missing(models, frameEntries); len(miss) > 0 {
		// No miss computation (FEED_GO_COMPUTE_MISSES off): the frame lookup reads the primary.
		return nil, nil, fallback.Safef("model-frame-miss", "%d ids", len(miss))
	}
	var frameCIDs []int
	for _, e := range frameEntries {
		if e.NotFound {
			continue
		}
		if cid, ok := Int(e.Value["cosmeticId"]); ok {
			frameCIDs = append(frameCIDs, cid)
		}
	}
	ids := Unique(append(userCIDs, frameCIDs...))
	cosmetics := map[int]superjson.Object{}
	if len(ids) > 0 {
		stage := NewBatch()
		read := s.Packed.Queue(stage, KeyCosmetics, ids, ttlDay)
		stage.Exec(ctx)
		if cosmetics, err = s.cosmeticsFrom(ctx, ids, read.Entries()); err != nil {
			return nil, nil, err
		}
	}
	joined := map[int]superjson.Object{}
	for id, e := range frameEntries {
		if e.NotFound {
			continue
		}
		frame, ok := JoinFrame(e.Value, cosmetics)
		if !ok {
			return nil, nil, fallback.New("model-frame-cosmetic-missing")
		}
		joined[id] = frame
	}
	return joinUserCosmetics(perUser, cosmetics), joined, nil
}

// modelDecorations is VisibleEventDecorations for the models, with the model's own miss reason (with
// s.Compute, fillModelEvents has computed the misses into got first).
func modelDecorations(ids []int, got map[int]Entry, visible map[string]bool) (map[int]superjson.Object, error) {
	if miss := Missing(ids, got); len(miss) > 0 {
		return nil, fallback.Safef("model-decoration-miss", "%d ids", len(miss))
	}
	return VisibleEventDecorations(ids, got, visible)
}

// modelData is dataForModelsCache.fetch: the data misses computed (fillModelData), then the appendFn's
// modelTagCache.fetch over the models the data cache answered, its misses computed (fillModelTags),
// then modelDataFrom. Without s.Compute a miss on either falls back there.
func (s *Sources) modelData(ctx context.Context, models []int, data, tags *PackedRead) (map[int]ModelData, error) {
	dataGot, dataWritable := data.read()
	if err := s.fillModelData(ctx, models, dataGot, dataWritable); err != nil {
		return nil, err
	}
	tagGot, tagWritable := tags.read()
	if miss := Missing(models, dataGot); len(miss) == 0 {
		var found []int
		for _, id := range models {
			if !dataGot[id].NotFound {
				found = append(found, id)
			}
		}
		if err := s.fillModelTags(ctx, found, tagGot, tagWritable); err != nil {
			return nil, err
		}
	}
	return s.modelDataFrom(ctx, models, dataGot, tagGot)
}

// modelDataFrom is dataForModelsCache.fetch with its appendFn over the entries read (and computed):
// each model's tags are modelTagCache's tag ids that tagCache resolves (`.filter(isDefined)`), in
// modelTagCache's order; a model the tag cache has no entry for keeps the tags its data entry was
// written with. A data miss, or a model-tags miss for a model the data cache answered, falls back
// (only without s.Compute: with it modelData computed them); a basic-tags miss is read from the
// replica, existence being all that is read of a tag here.
func (s *Sources) modelDataFrom(ctx context.Context, models []int, data, tags map[int]Entry) (map[int]ModelData, error) {
	if miss := Missing(models, data); len(miss) > 0 {
		return nil, fallback.Safef("model-data-miss", "%d ids", len(miss))
	}
	// The appendFn asks the tag cache for the models the data cache answered only.
	var found []int
	for _, id := range models {
		if !data[id].NotFound {
			found = append(found, id)
		}
	}
	if miss := Missing(found, tags); len(miss) > 0 {
		return nil, fallback.Safef("model-tags-miss", "%d ids", len(miss))
	}
	out := make(map[int]ModelData, len(models))
	tagIDsOf := map[int][]int{}
	var allTags []int
	for _, id := range models {
		e := data[id]
		if e.NotFound {
			continue
		}
		var md ModelData
		// The ordered record (an ordered cache): each version keeps the key order Node's answer has.
		rec := e.Ordered()
		md.Hashes, _ = ObjectField(rec, "hashes").([]any)
		if md.Hashes == nil {
			md.Hashes = []any{}
		}
		for _, v := range asList(ObjectField(rec, "versions")) {
			if m, ok := v.(superjson.Object); ok {
				md.Versions = append(md.Versions, m)
			}
		}
		if t := tags[id]; !t.NotFound {
			list := make([]int, 0)
			for _, v := range asList(t.Value["tagIds"]) {
				if n, ok := Int(v); ok {
					list = append(list, n)
				}
			}
			tagIDsOf[id] = list
			allTags = append(allTags, list...)
		} else {
			// The entry's own `tags` (written as [] by the lookup).
			for _, v := range asList(ObjectField(rec, "tags")) {
				if m, ok := v.(superjson.Object); ok {
					if n, ok := Int(ObjectField(m, "tagId")); ok {
						md.TagIDs = append(md.TagIDs, n)
					}
				}
			}
		}
		out[id] = md
	}
	allTags = Unique(allTags)
	if len(allTags) > 0 {
		known, err := s.knownTags(ctx, allTags)
		if err != nil {
			return nil, err
		}
		for id, list := range tagIDsOf {
			md := out[id]
			md.TagIDs = make([]int, 0, len(list))
			for _, t := range list {
				if known[t] {
					md.TagIDs = append(md.TagIDs, t)
				}
			}
			out[id] = md
		}
	} else {
		for id := range tagIDsOf {
			md := out[id]
			md.TagIDs = []int{}
			out[id] = md
		}
	}
	return out, nil
}

// knownTags is which of ids tagCache resolves: a cached entry (stale ones served), not a notFound
// marker; the misses are the cache's lookup on the replica.
func (s *Sources) knownTags(ctx context.Context, ids []int) (map[int]bool, error) {
	b := NewBatch()
	read := s.Packed.Queue(b, KeyBasicTags, ids, ttlDay)
	b.Exec(ctx)
	got := read.Entries()
	known := make(map[int]bool, len(ids))
	for id, e := range got {
		if !e.NotFound {
			known[id] = true
		}
	}
	if miss := Missing(ids, got); len(miss) > 0 {
		rows, err := s.Replica.Query(ctx, `SELECT id FROM "Tag" WHERE id = ANY($1::int[])`, miss)
		if err != nil {
			return nil, err
		}
		maps, err := rowsToMaps(rows)
		if err != nil {
			return nil, err
		}
		for _, m := range maps {
			if id, ok := Int(m["id"]); ok {
				known[id] = true
			}
		}
	}
	return known, nil
}

// privacyDefaultsFrom is getUserMetricPrivacyDefaultsMap: the cached triple, else the user's
// `settings` read on the replica (`!!settings.hideModel*`, so any truthy JSON value hides).
func (s *Sources) privacyDefaultsFrom(ctx context.Context, owners []int, got map[int]Entry) (map[int]PrivacyDefaults, error) {
	out := make(map[int]PrivacyDefaults, len(owners))
	for id, e := range got {
		if e.NotFound {
			continue
		}
		out[id] = PrivacyDefaults{
			Buzz:        truthyJS(e.Value["hideModelBuzz"]),
			Downloads:   truthyJS(e.Value["hideModelDownloads"]),
			Generations: truthyJS(e.Value["hideModelGenerations"]),
		}
	}
	var miss []int
	for _, id := range owners {
		if _, ok := out[id]; !ok {
			miss = append(miss, id)
		}
	}
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, `SELECT id, settings->'hideModelBuzz' AS "hideModelBuzz",
		settings->'hideModelDownloads' AS "hideModelDownloads",
		settings->'hideModelGenerations' AS "hideModelGenerations"
		FROM "User" WHERE id = ANY($1::int[])`, miss)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, id := range miss {
		out[id] = PrivacyDefaults{} // a user with no row or no flags hides nothing
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		out[id] = PrivacyDefaults{
			Buzz:        truthyJS(m["hideModelBuzz"]),
			Downloads:   truthyJS(m["hideModelDownloads"]),
			Generations: truthyJS(m["hideModelGenerations"]),
		}
	}
	return out, nil
}

// VersionImages is getImagesForModelVersionCache: each version's cached showcase images
// (imagesForModelVersionsCache) without those the minor content rule restricts, each image's `tags`
// replaced by the image-tag cache's ids (the appendFn: the filter, then `tags ?? []`). A version
// whose images are all filtered out keeps its entry, with no images. A version whose entry is a
// notFound marker has no images (absent from the
// answer). With s.Compute a version-images miss is computed (fillVersionImages: the lookupFn's
// showcase query, lag-aware with write-back on) and a stale entry revalidated as Node's fetch
// revalidates it; without, a miss falls back and a stale entry is served. An image-tags miss is
// computed as on the image feed (fillTagIDs), and falls back without s.Compute.
func (s *Sources) VersionImages(ctx context.Context, versionIDs []int) (map[int][]superjson.Object, error) {
	ids := Unique(versionIDs)
	out := map[int][]superjson.Object{}
	if len(ids) == 0 {
		return out, nil
	}
	b := NewBatch()
	read := s.Packed.Queue(b, KeyVersionImages, ids, versionImagesTTL)
	b.Exec(ctx)
	got, writable := read.read()
	if err := s.fillVersionImages(ctx, ids, got, writable); err != nil {
		return nil, err
	}
	if miss := Missing(ids, got); len(miss) > 0 {
		// No miss computation (FEED_GO_COMPUTE_MISSES off): the lookup is lag-aware.
		return nil, fallback.Safef("model-images-miss", "%d ids", len(miss))
	}
	var imageIDs []int
	for _, id := range ids {
		e := got[id]
		if e.NotFound {
			continue
		}
		// The ordered record (an ordered cache): each image keeps the key order Node's answer has
		// (model.getAll writes its images' keys in that order).
		list := make([]superjson.Object, 0)
		for _, v := range asList(ObjectField(e.Ordered(), "images")) {
			if m, ok := v.(superjson.Object); ok {
				list = append(list, m)
			}
		}
		// The appendFn drops the images the minor content rule restricts before it reads their tags,
		// on every read, for every viewer (an entry cached before the lookup left them out holds them).
		// The same read drops the images at no selectable level.
		list = WithSelectableLevel(WithoutMinorMatureImages(list, ObjectField), ObjectField)
		for _, m := range list {
			if iid, ok := Int(ObjectField(m, "id")); ok {
				imageIDs = append(imageIDs, iid)
			}
		}
		out[id] = list
	}
	imageIDs = Unique(imageIDs)
	if len(imageIDs) == 0 {
		return out, nil
	}
	tb := NewBatch()
	tagRead := s.Packed.Queue(tb, KeyTagIDs, imageIDs, tagIDsTTL)
	tb.Exec(ctx)
	tagGot, tagWritable := tagRead.read()
	if err := s.fillTagIDs(ctx, imageIDs, tagGot, tagWritable); err != nil {
		return nil, err
	}
	tagIDs, err := tagIDsFrom(imageIDs, tagGot)
	if err != nil {
		return nil, err
	}
	for vid, list := range out {
		copied := make([]superjson.Object, len(list))
		for i, img := range list {
			// `image.tags = …`: an existing member keeps its place, a new one goes last.
			c := append(make(superjson.Object, 0, len(img)+1), img...)
			iid, _ := Int(ObjectField(img, "id"))
			if t, ok := tagIDs[iid]; ok && t != nil {
				c.Set("tags", t)
			} else {
				c.Set("tags", []any{})
			}
			copied[i] = c
		}
		out[vid] = copied
	}
	return out, nil
}

// VersionImageEntries is imagesForModelVersionsCache.fetch's records for versionIDs, before the
// appendFn (which each reader applies): read, a queued Packed.Queue of KeyVersionImages with
// versionImagesTTL, answered as VersionImages answers it. With s.Compute a miss is computed and a
// stale entry revalidated (fillVersionImages: the lookupFn's showcase query, lag-aware with write-back
// on); a stale entry whose revalidation lock another process holds is kept, marked Stale. Without
// s.Compute (or with a nil s) the read is answered as it is: a miss absent, a stale entry Stale.
func (s *Sources) VersionImageEntries(ctx context.Context, versionIDs []int, read *PackedRead) (map[int]Entry, error) {
	got, writable := read.read()
	if s == nil {
		return got, nil
	}
	if err := s.fillVersionImages(ctx, Unique(versionIDs), got, writable); err != nil {
		return nil, err
	}
	return got, nil
}

// CreatorMemberships is getValidCreatorMembershipMap: the cached boolean per user. A miss falls back
// (its origin parses subscription products with the app's tier key).
func (s *Sources) CreatorMemberships(ctx context.Context, userIDs []int) (map[int]bool, error) {
	ids := Unique(userIDs)
	out := make(map[int]bool, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	cmds := make([]*redis.StringCmd, len(ids))
	b := NewBatch()
	if s.Packed.Redis != nil {
		b.add(s.Packed.Redis, func(ctx context.Context, p redis.Pipeliner) {
			for i, id := range ids {
				cmds[i] = p.Get(ctx, s.Packed.key(KeyMembershipValid, id))
			}
		})
	}
	b.Exec(ctx)
	for i, id := range ids {
		if cmds[i] == nil {
			return nil, fallback.New("membership-miss")
		}
		raw, err := cmds[i].Bytes()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				return nil, fallback.New("membership-miss")
			}
			return nil, fallback.Wrap("membership-read-failed", err)
		}
		v, err := Unpack(raw)
		if err != nil {
			return nil, fallback.New("membership-miss")
		}
		valid, ok := v.(bool)
		if !ok {
			return nil, fallback.New("membership-miss")
		}
		out[id] = valid
	}
	return out, nil
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}
