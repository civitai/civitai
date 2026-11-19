package hydrate

import (
	"context"

	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// PageRequest is the ids one page of images hydrates (getAllImagesUncaptured with include =
// [cosmetics, tagIds, profilePictures]). Duplicates and zeros are dropped.
type PageRequest struct {
	UserIDs  []int // every image's creator
	ImageIDs []int
	VideoIDs []int // the video images, whose thumbnails are joined
	// VisibleEvents is the decoration events every viewer sees; empty = no decoration read.
	VisibleEvents map[string]bool
	ViewerID      int // 0 = signed out: no reactions read
	// NoProfilePictures: the include list has no 'profilePictures' (image.getInfinite adds only
	// 'tagIds'), so the profile-picture cache is not read and every creator's is absent (Node: null).
	NoProfilePictures bool
	// NoCosmetics: the include list has no 'cosmetics' (image.getInfinite's `include: []`), so
	// getCosmeticsForUsers and getCosmeticsForEntity are not called: neither the user-cosmetics nor the
	// frames cache is read (nor the cosmetic records they name), and both maps are empty (Node:
	// `cosmetics: []` per creator, `cosmetic: null` per image).
	NoCosmetics bool
}

// Page is a page's hydration, each map as the lookup of the same name answers it.
type Page struct {
	Basic         map[int]BasicUser        // BasicUsers
	UserCosmetics map[int][]any            // UserCosmetics
	ProfilePics   map[int]superjson.Object // ProfilePictures
	Frames        map[int]superjson.Object // ImageFrames
	Thumbs        map[int]Thumbnail        // Thumbnails
	Metrics       map[int]Metrics          // ImageMetrics
	TagIDs        map[int]any              // TagIDs
	Decorations   map[int]superjson.Object // EventDecorations
	Reactions     map[int][]any            // Reactions
}

// Page answers what the per-lookup reads (BasicUsers, UserCosmetics, ProfilePictures, ImageFrames,
// Thumbnails, ImageMetrics, TagIDs, EventDecorations: perlookup_test.go keeps them as the reference)
// and Reactions answer for req, with the cache reads in one pipeline per dependency stage instead of
// one (or two) per lookup:
//
//   - stage 1, one Batch: every per-id GET of the users, profile pictures, user cosmetics, frames, tag
//     ids, thumbnails and event decorations caches, and every metric hash HGETALL. None depends on
//     another lookup's answer.
//   - stage 2, one Batch: the cosmetic records both cosmetic joins need (the user cosmetics' and the
//     frames' cosmetic ids, merged), read once stage 1 has answered both.
//
// Everything that is not a cache read is as in the per-lookup reads, which share these halves:
// each lookup's misses, markers and staleness (decodeEntry), its fallback reasons, and its replica
// queries, which run after the pipeline, concurrently, one per lookup that has misses. With
// s.Compute, the misses of the caches Node fills on read (user cosmetics, frames, tag ids, event
// decorations) are computed the same way: one batched lookup per cache that has misses, after the pipeline,
// concurrently (misses.go). The reactions query reads no cache and starts with
// stage 1. A lookup's error (the first, as with errgroup) is the page's error.
func (s *Sources) Page(ctx context.Context, req PageRequest) (*Page, error) {
	users, images, videos := Unique(req.UserIDs), Unique(req.ImageIDs), Unique(req.VideoIDs)
	out := &Page{}
	g, gctx := errgroup.WithContext(ctx)
	g.Go(safe.Go(func() (err error) { out.Reactions, err = s.Reactions(gctx, images, req.ViewerID); return }))

	stage1 := NewBatch()
	basic := s.Packed.Queue(stage1, KeyBasicUsers, users, ttlDay)
	var userCosmetics, frames *PackedRead
	if !req.NoCosmetics {
		userCosmetics = s.Packed.Queue(stage1, KeyUserCosmetics, users, 0)
	}
	var profilePics *PackedRead
	if !req.NoProfilePictures {
		profilePics = s.Packed.Queue(stage1, KeyProfilePictures, users, 0)
	}
	if !req.NoCosmetics {
		frames = s.Packed.Queue(stage1, KeyImageFrames, images, 0)
	}
	thumbs := s.Packed.Queue(stage1, KeyThumbnails, videos, ttlDay)
	tags := s.Packed.Queue(stage1, KeyTagIDs, images, tagIDsTTL)
	// No visible event: no decoration read at all (decorationsForEvents returns before its fetch).
	readEvents := len(images) > 0 && len(req.VisibleEvents) > 0
	var events *PackedRead
	if readEvents {
		events = s.Packed.Queue(stage1, KeyImageEvents, images, 0)
	}
	metrics := s.queueMetrics(stage1, images)
	stage1.Exec(gctx)

	g.Go(safe.Go(func() (err error) { out.Basic, err = s.basicUsersFrom(gctx, users, basic.Entries()); return }))
	g.Go(safe.Go(func() (err error) {
		if profilePics == nil {
			out.ProfilePics = map[int]superjson.Object{}
			return nil
		}
		out.ProfilePics, err = s.profilePicturesFrom(gctx, users, profilePics.Entries())
		return
	}))
	g.Go(safe.Go(func() (err error) {
		if len(videos) == 0 {
			out.Thumbs = map[int]Thumbnail{}
			return nil
		}
		out.Thumbs, err = s.thumbnailsFrom(gctx, videos, thumbs.Entries())
		return
	}))
	g.Go(safe.Go(func() (err error) { out.Metrics, err = metrics.result(gctx, s); return }))
	g.Go(safe.Go(func() (err error) {
		got, writable := tags.read()
		if err := s.fillTagIDs(gctx, images, got, writable); err != nil {
			return err
		}
		out.TagIDs, err = tagIDsFrom(images, got)
		return
	}))
	g.Go(safe.Go(func() (err error) {
		if !readEvents {
			out.Decorations = map[int]superjson.Object{}
			return nil
		}
		got, writable := events.read()
		if err := s.fillEvents(gctx, images, got, writable); err != nil {
			return err
		}
		out.Decorations, err = VisibleEventDecorations(images, got, req.VisibleEvents)
		return
	}))
	g.Go(safe.Go(func() error {
		if req.NoCosmetics {
			out.UserCosmetics, out.Frames = map[int][]any{}, map[int]superjson.Object{}
			return nil
		}
		var err error
		out.UserCosmetics, out.Frames, err = s.pageCosmetics(gctx, users, images, userCosmetics, frames)
		return err
	}))
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

// pageCosmetics is Page's stage 2: UserCosmetics and ImageFrames over their stage-1 answers (their
// misses computed first, with s.Compute), with one Cosmetics read (one pipeline, then one replica
// query for its misses) for both joins.
func (s *Sources) pageCosmetics(ctx context.Context, users, images []int, userCosmetics, frames *PackedRead) (map[int][]any, map[int]superjson.Object, error) {
	ucGot, ucWritable := userCosmetics.read()
	frameEntries, frameWritable := frames.read()
	if s.Compute != nil {
		// The two lookups' misses, computed at once (each is one query, plus the withheld check).
		g, gctx := errgroup.WithContext(ctx)
		g.Go(safe.Go(func() error { return s.fillUserCosmetics(gctx, users, ucGot, ucWritable) }))
		g.Go(safe.Go(func() error { return s.fillFrames(gctx, images, frameEntries, frameWritable) }))
		if err := g.Wait(); err != nil {
			return nil, nil, err
		}
	}
	perUser, userCIDs, err := userCosmeticsFrom(users, ucGot)
	if err != nil {
		return nil, nil, err
	}
	frameCIDs, err := frameCosmeticIDs(images, frameEntries)
	if err != nil {
		return nil, nil, err
	}
	ids := Unique(append(userCIDs, frameCIDs...))
	cosmetics := map[int]superjson.Object{}
	if len(ids) > 0 {
		stage2 := NewBatch()
		read := s.Packed.Queue(stage2, KeyCosmetics, ids, ttlDay)
		stage2.Exec(ctx)
		if cosmetics, err = s.cosmeticsFrom(ctx, ids, read.Entries()); err != nil {
			return nil, nil, err
		}
	}
	joined, err := joinFrames(frameEntries, cosmetics)
	if err != nil {
		return nil, nil, err
	}
	return joinUserCosmetics(perUser, cosmetics), joined, nil
}
