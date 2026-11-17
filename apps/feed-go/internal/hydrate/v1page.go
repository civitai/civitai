package hydrate

import "context"

// V1PageRequest is the ids one page of the public images endpoint hydrates. Duplicates and zeros are
// dropped.
type V1PageRequest struct {
	UserIDs  []int // every image's creator
	ImageIDs []int
	VideoIDs []int // the video images, whose thumbnails are joined
	// MetaIDs are the images whose cached meta is read (withMeta); none = no meta read.
	MetaIDs []int
}

// V1Page is what the public images endpoint publishes of a page's hydration.
type V1Page struct {
	Basic     map[int]BasicUser       // getBasicDataForUsers
	Thumbs    map[int]Thumbnail       // getThumbnailsForImages
	Metrics   map[int]Metrics         // getImageMetricsObject
	Resources map[int][]ImageResource // imageResourcesCache.fetch (includeBaseModel)
	Meta      map[int]any             // imageMetaCache.fetch (withMeta): each image's meta, nil = null
}

// V1Page reads the endpoint's lookups (basic users, video thumbnails, metric hashes, image resources,
// and with MetaIDs the image meta) with every cache read in ONE pipeline; none depends on another.
// The lookups are then finished one after another in the order the endpoint reads them (the meta
// last: Node reads it after getAllImages returns), so a page with several failures reports the same
// (first) one, and each lookup's misses, staleness and fallbacks are its finish half's
// (basicUsersFrom, thumbnailsFrom, metricsRead.result, imageResourcesFrom, imageMetasFrom).
func (s *Sources) V1Page(ctx context.Context, req V1PageRequest) (*V1Page, error) {
	users, images, videos := Unique(req.UserIDs), Unique(req.ImageIDs), Unique(req.VideoIDs)
	var metas []int
	if len(req.MetaIDs) > 0 {
		metas = Unique(req.MetaIDs)
	}
	b := NewBatch()
	basic := s.Packed.Queue(b, KeyBasicUsers, users, ttlDay)
	thumbs := s.Packed.Queue(b, KeyThumbnails, videos, ttlDay)
	metrics := s.queueMetrics(b, images)
	resources := s.Packed.Queue(b, KeyImageResources, images, 0)
	meta := s.queueMeta(b, metas)
	b.Exec(ctx)

	out := &V1Page{Thumbs: map[int]Thumbnail{}}
	var err error
	if out.Basic, err = s.basicUsersFrom(ctx, users, basic.Entries()); err != nil {
		return nil, err
	}
	if len(videos) > 0 {
		if out.Thumbs, err = s.thumbnailsFrom(ctx, videos, thumbs.Entries()); err != nil {
			return nil, err
		}
	}
	if out.Metrics, err = metrics.result(ctx, s); err != nil {
		return nil, err
	}
	if out.Resources, err = imageResourcesFrom(images, resources.Entries()); err != nil {
		return nil, err
	}
	if len(metas) > 0 {
		if out.Meta, err = s.imageMetasFrom(ctx, meta); err != nil {
			return nil, err
		}
	}
	return out, nil
}
