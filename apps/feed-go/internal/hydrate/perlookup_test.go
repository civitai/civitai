package hydrate

import (
	"context"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The per-lookup path: each lookup with its own cache read (its own pipeline), as hydration ran before
// Page and V1Page batched the reads per dependency stage. No production code calls these; they are
// kept, in a test file, as the REFERENCE the batched paths are compared with (perLookup in
// page_test.go, the v1 comparison, the integration tier) and as the per-cache unit the integration
// tests exercise one cache at a time. Each is the production read/finish halves around one
// PackedReader.Get, so the reference and the batched path share every semantic but the batching.

// BasicUsers is getBasicDataForUsers.
func (s *Sources) BasicUsers(ctx context.Context, ids []int) (map[int]BasicUser, error) {
	ids = Unique(ids)
	return s.basicUsersFrom(ctx, ids, s.Packed.Get(ctx, KeyBasicUsers, ids, ttlDay))
}

// read is one lookup's own pipeline: PackedReader.Get with the per-id miss states fill needs.
func (s *Sources) read(ctx context.Context, key string, ids []int, ttl time.Duration) (map[int]Entry, map[int]bool) {
	b := NewBatch()
	r := s.Packed.Queue(b, key, ids, ttl)
	b.Exec(ctx)
	return r.read()
}

// UserCosmetics is getCosmeticsForUsers, with its own Cosmetics read.
func (s *Sources) UserCosmetics(ctx context.Context, ids []int) (map[int][]any, error) {
	ids = Unique(ids)
	got, writable := s.read(ctx, KeyUserCosmetics, ids, 0)
	if err := s.fillUserCosmetics(ctx, ids, got, writable); err != nil {
		return nil, err
	}
	perUser, cosmeticIDs, err := userCosmeticsFrom(ids, got)
	if err != nil {
		return nil, err
	}
	cosmetics, err := s.Cosmetics(ctx, cosmeticIDs)
	if err != nil {
		return nil, err
	}
	return joinUserCosmetics(perUser, cosmetics), nil
}

// Cosmetics is cosmeticCache.fetch.
func (s *Sources) Cosmetics(ctx context.Context, ids []int) (map[int]superjson.Object, error) {
	ids = Unique(ids)
	if len(ids) == 0 {
		return map[int]superjson.Object{}, nil
	}
	return s.cosmeticsFrom(ctx, ids, s.Packed.Get(ctx, KeyCosmetics, ids, ttlDay))
}

// ProfilePictures is getProfilePicturesForUsers.
func (s *Sources) ProfilePictures(ctx context.Context, ids []int) (map[int]superjson.Object, error) {
	ids = Unique(ids)
	return s.profilePicturesFrom(ctx, ids, s.Packed.Get(ctx, KeyProfilePictures, ids, 0))
}

// ImageFrames is getCosmeticsForEntity({entity: 'Image'}), with its own Cosmetics read.
func (s *Sources) ImageFrames(ctx context.Context, imageIDs []int) (map[int]superjson.Object, error) {
	imageIDs = Unique(imageIDs)
	got, writable := s.read(ctx, KeyImageFrames, imageIDs, 0)
	if err := s.fillFrames(ctx, imageIDs, got, writable); err != nil {
		return nil, err
	}
	cosmeticIDs, err := frameCosmeticIDs(imageIDs, got)
	if err != nil {
		return nil, err
	}
	cosmetics, err := s.Cosmetics(ctx, cosmeticIDs)
	if err != nil {
		return nil, err
	}
	return joinFrames(got, cosmetics)
}

// EventDecorations is getEventDecorationsForEntity: no cache read when no event is visible.
func (s *Sources) EventDecorations(ctx context.Context, imageIDs []int, visibleEvents map[string]bool) (map[int]superjson.Object, error) {
	imageIDs = Unique(imageIDs)
	if len(imageIDs) == 0 || len(visibleEvents) == 0 {
		return map[int]superjson.Object{}, nil
	}
	got, writable := s.read(ctx, KeyImageEvents, imageIDs, 0)
	if err := s.fillEvents(ctx, imageIDs, got, writable); err != nil {
		return nil, err
	}
	return VisibleEventDecorations(imageIDs, got, visibleEvents)
}

// Thumbnails is getThumbnailsForImages(videoIds).
func (s *Sources) Thumbnails(ctx context.Context, videoIDs []int) (map[int]Thumbnail, error) {
	videoIDs = Unique(videoIDs)
	if len(videoIDs) == 0 {
		return map[int]Thumbnail{}, nil
	}
	return s.thumbnailsFrom(ctx, videoIDs, s.Packed.Get(ctx, KeyThumbnails, videoIDs, ttlDay))
}

// ImageMetrics is getImageMetricsObject, its HGETALLs in a pipeline of their own.
func (s *Sources) ImageMetrics(ctx context.Context, imageIDs []int) (map[int]Metrics, error) {
	b := NewBatch()
	r := s.queueMetrics(b, Unique(imageIDs))
	b.Exec(ctx)
	return r.result(ctx, s)
}

// TagIDs is tagIdsForImagesCache.fetch.
func (s *Sources) TagIDs(ctx context.Context, imageIDs []int) (map[int]any, error) {
	imageIDs = Unique(imageIDs)
	got, writable := s.read(ctx, KeyTagIDs, imageIDs, tagIDsTTL)
	if err := s.fillTagIDs(ctx, imageIDs, got, writable); err != nil {
		return nil, err
	}
	return tagIDsFrom(imageIDs, got)
}

// ImageTags is getImageTagsForImages plus the handler's vote merge, for a request with the 'tags'
// include (none read without it).
func (s *Sources) ImageTags(ctx context.Context, imageIDs []int, viewerID int, include bool) (map[int][]any, error) {
	if !include {
		return map[int][]any{}, nil
	}
	imageIDs = Unique(imageIDs)
	got, writable := s.read(ctx, KeyImageTags, imageIDs, 0)
	if err := s.fillImageTags(ctx, imageIDs, got, writable); err != nil {
		return nil, err
	}
	votes, err := s.ImageTagVotes(ctx, imageIDs, viewerID)
	if err != nil {
		return nil, err
	}
	return imageTagsFrom(imageIDs, got, votes)
}

// ImageResources is imageResourcesCache.fetch for the public images endpoint.
func (s *Sources) ImageResources(ctx context.Context, imageIDs []int) (map[int][]ImageResource, error) {
	imageIDs = Unique(imageIDs)
	return imageResourcesFrom(imageIDs, s.Packed.Get(ctx, KeyImageResources, imageIDs, 0))
}
