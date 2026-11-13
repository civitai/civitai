package feed

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// RawImage is one row of the getAllImages SELECT.
type RawImage struct {
	ID                int             `json:"id"`
	Name              *string         `json:"name"`
	URL               *string         `json:"url"`
	NsfwLevel         int             `json:"nsfwLevel"`
	Width             *int            `json:"width"`
	Height            *int            `json:"height"`
	Hash              *string         `json:"hash"`
	HideMeta          bool            `json:"hideMeta"`
	HasMeta           bool            `json:"hasMeta"`
	HasPositivePrompt bool            `json:"hasPositivePrompt"`
	OnSite            *bool           `json:"onSite"`
	RemixOfID         json.RawMessage `json:"remixOfId"`
	CreatedAt         time.Time       `json:"createdAt"`
	SortAt            time.Time       `json:"sortAt"`
	MimeType          *string         `json:"mimeType"`
	Type              string          `json:"type"`
	Metadata          json.RawMessage `json:"metadata"`
	Ingestion         string          `json:"ingestion"`
	BlockedFor        *string         `json:"blockedFor"`
	ScannedAt         *time.Time      `json:"scannedAt"`
	NeedsReview       *string         `json:"needsReview"`
	UserID            int             `json:"userId"`
	PostID            int             `json:"postId"`
	PostTitle         *string         `json:"postTitle"`
	Index             *int            `json:"index"`
	PublishedAt       *time.Time      `json:"publishedAt"`
	UnpublishedAt     *string         `json:"unpublishedAt"`
	ModelVersionID    *int            `json:"modelVersionId"`
	Model3DID         *int            `json:"model3dId"`
	Availability      string          `json:"availability"`
	Minor             bool            `json:"minor"`
	Poi               bool            `json:"poi"`
	AcceptableMinor   bool            `json:"acceptableMinor"`
	CursorID          int             `json:"cursorId"`
}

// Querier runs the page query.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// QueryCache is this service's OWN cache of page rows. It cannot share the Node keyspace: Node keys
// on a hash of Prisma's SQL fragments, which a different SQL text never reproduces. It does share the
// bust TAGS: each key is added to the same `tag:<tag>` sets Node's bustCacheTag empties on an image
// upload or update, so a model gallery is invalidated for both services at once.
type QueryCache struct {
	Redis   redis.UniversalClient
	Prefix  string // CACHE_KEY_NAMESPACE prefix; empty in production
	Enabled bool   // IMAGE_QUERY_CACHING
}

// Key is the cache key for a built query: sha256 over the SQL text and its bound values.
func (c *QueryCache) Key(b Built) string {
	h := sha256.New()
	h.Write([]byte(b.SQL))
	args, _ := json.Marshal(b.Args)
	h.Write(args)
	return c.Prefix + "feed-go:getAllImages:v1:" + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// statementTimeout is IMAGE_FEED_STATEMENT_TIMEOUT_MS. A var only so tests can shorten it.
var statementTimeout = 20 * time.Second

// FetchRows runs the page query through the cache. A query that runs past statementTimeout yields an
// empty page (never cached), as Node answers a statement timeout (getAllImages: "feeds can accept an
// empty page after a timeout"), so a slow replica is not handed on to the Node app to run again. Only
// this query's own deadline does that: a cancelled or expired caller context is still an error.
func FetchRows(ctx context.Context, db Querier, cache *QueryCache, b Built) ([]RawImage, error) {
	useCache := cache != nil && cache.Enabled && cache.Redis != nil && b.CacheTTL > 0
	var key string
	if useCache {
		key = cache.Key(b)
		if raw, err := cache.Redis.Get(ctx, key).Bytes(); err == nil {
			var rows []RawImage
			if json.Unmarshal(raw, &rows) == nil {
				return rows, nil
			}
		}
	}
	qctx, cancel := context.WithTimeout(ctx, statementTimeout)
	defer cancel()
	timedOut := func() bool {
		return ctx.Err() == nil && errors.Is(qctx.Err(), context.DeadlineExceeded)
	}
	rows, err := db.Query(qctx, b.SQL, b.Args...)
	if err != nil {
		if timedOut() {
			return []RawImage{}, nil
		}
		return nil, err
	}
	out, err := scanRows(rows)
	if err != nil {
		if timedOut() {
			return []RawImage{}, nil
		}
		return nil, err
	}
	if useCache {
		if raw, err := json.Marshal(out); err == nil {
			// Fail open: a cache write error never fails the request.
			_ = cache.Redis.Set(ctx, key, raw, b.CacheTTL).Err()
			for _, tag := range b.CacheTags {
				_ = cache.Redis.SAdd(ctx, cache.Prefix+"tag:"+tag, key).Err()
			}
		}
	}
	return out, nil
}

func scanRows(rows pgx.Rows) ([]RawImage, error) {
	defer rows.Close()
	var out []RawImage
	for rows.Next() {
		var r RawImage
		var remix, meta []byte
		if err := rows.Scan(
			&r.ID, &r.Name, &r.URL, &r.NsfwLevel, &r.Width, &r.Height, &r.Hash, &r.HideMeta, &r.HasMeta,
			&r.HasPositivePrompt, &r.OnSite, &remix, &r.CreatedAt, &r.SortAt, &r.MimeType, &r.Type, &meta,
			&r.Ingestion, &r.BlockedFor, &r.ScannedAt, &r.NeedsReview, &r.UserID, &r.PostID, &r.PostTitle,
			&r.Index, &r.PublishedAt, &r.UnpublishedAt, &r.ModelVersionID, &r.Model3DID, &r.Availability,
			&r.Minor, &r.Poi, &r.AcceptableMinor, &r.CursorID,
		); err != nil {
			return nil, err
		}
		if remix != nil {
			r.RemixOfID = json.RawMessage(remix)
		}
		if meta != nil {
			r.Metadata = json.RawMessage(meta)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Image is one image ready for the wire, plus the fields the post grouping reads.
type Image struct {
	Wire        superjson.Object
	ID          int
	PostID      int
	Index       int
	NsfwLevel   int
	SortAt      time.Time
	PublishedAt any // time.Time (= sortAt) or Undefined
	ModelVerID  any
	User        superjson.Object
	Stats       superjson.Object
}

// Page is one getAllImages result.
type Page struct {
	Images     []Image
	NextCursor int // 0 = none
}

// Viewer is who is asking.
type Viewer struct {
	ID          int
	IsModerator bool // moderatorView: a moderator on a cookie session
}

// Hydrator is the hydration surface FetchImages needs (implemented by *hydrate.Sources).
type Hydrator interface {
	BasicUsers(ctx context.Context, ids []int) (map[int]hydrate.BasicUser, error)
	UserCosmetics(ctx context.Context, ids []int) (map[int][]any, error)
	ProfilePictures(ctx context.Context, ids []int) (map[int]superjson.Object, error)
	ImageFrames(ctx context.Context, ids []int) (map[int]superjson.Object, error)
	Thumbnails(ctx context.Context, ids []int) (map[int]hydrate.Thumbnail, error)
	ImageMetrics(ctx context.Context, ids []int) (map[int]hydrate.Metrics, error)
	TagIDs(ctx context.Context, ids []int) (map[int]any, error)
	EventDecorations(ctx context.Context, ids []int, visible map[string]bool) (map[int]superjson.Object, error)
	Reactions(ctx context.Context, ids []int, viewerID int) (map[int][]any, error)
	VisibleModel3DIDs(ctx context.Context, ids []int, viewerID int, isModerator bool) (map[int]bool, error)
}

// Hydrated is everything the per-image transform joins in.
type Hydrated struct {
	Basic          map[int]hydrate.BasicUser
	UserCosmetics  map[int][]any
	ProfilePics    map[int]superjson.Object
	Frames         map[int]superjson.Object
	Thumbs         map[int]hydrate.Thumbnail
	Metrics        map[int]hydrate.Metrics
	TagIDs         map[int]any
	Decorations    map[int]superjson.Object
	Reactions      map[int][]any
	VisibleModel3D map[int]bool
}

// Hydrate runs the parallel fetch of getAllImagesUncaptured for include = [cosmetics, tagIds,
// profilePictures] (what the gallery handler always passes).
func Hydrate(ctx context.Context, h Hydrator, rows []RawImage, viewer Viewer, visibleEvents map[string]bool) (*Hydrated, error) {
	imageIDs := make([]int, 0, len(rows))
	userIDs := make([]int, 0, len(rows))
	var videoIDs, model3dIDs []int
	for _, r := range rows {
		imageIDs = append(imageIDs, r.ID)
		userIDs = append(userIDs, r.UserID)
		if r.Type == "video" {
			videoIDs = append(videoIDs, r.ID)
		}
		if r.Model3DID != nil {
			model3dIDs = append(model3dIDs, *r.Model3DID)
		}
	}
	out := &Hydrated{}
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { out.Basic, err = h.BasicUsers(gctx, userIDs); return })
	g.Go(func() (err error) { out.UserCosmetics, err = h.UserCosmetics(gctx, userIDs); return })
	g.Go(func() (err error) { out.ProfilePics, err = h.ProfilePictures(gctx, userIDs); return })
	g.Go(func() (err error) { out.Frames, err = h.ImageFrames(gctx, imageIDs); return })
	g.Go(func() (err error) { out.Thumbs, err = h.Thumbnails(gctx, videoIDs); return })
	g.Go(func() (err error) { out.Metrics, err = h.ImageMetrics(gctx, imageIDs); return })
	g.Go(func() (err error) { out.TagIDs, err = h.TagIDs(gctx, imageIDs); return })
	g.Go(func() (err error) { out.Decorations, err = h.EventDecorations(gctx, imageIDs, visibleEvents); return })
	g.Go(func() (err error) { out.Reactions, err = h.Reactions(gctx, imageIDs, viewer.ID); return })
	if err := g.Wait(); err != nil {
		return nil, err
	}
	if len(model3dIDs) > 0 {
		vis, err := h.VisibleModel3DIDs(ctx, model3dIDs, viewer.ID, viewer.IsModerator)
		if err != nil {
			return nil, err
		}
		out.VisibleModel3D = vis
	}
	return out, nil
}

// orUndefined returns v, or Undefined when ok is false.
func orUndefined(v any, ok bool) any {
	if !ok {
		return superjson.Undefined{}
	}
	return v
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func intOrNil(n *int) any {
	if n == nil {
		return nil
	}
	return int64(*n)
}

func timeOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func rawOrNil(r json.RawMessage) any {
	if len(r) == 0 {
		return nil
	}
	return r
}

// BuildImages is the per-image transform of getAllImagesUncaptured followed by both wire trims
// (stripImageForInfiniteWire and stripImageForAsPostsWire). The published filter drops, for anyone
// but a moderator, an image whose post is unpublished, scheduled or unpublished-again — except the
// viewer's own.
func BuildImages(rows []RawImage, hy *Hydrated, viewer Viewer, now time.Time) []Image {
	out := make([]Image, 0, len(rows))
	for _, r := range rows {
		if !viewer.IsModerator {
			hidden := r.PublishedAt == nil || r.PublishedAt.After(now) || r.UnpublishedAt != nil
			if hidden && r.UserID != viewer.ID {
				continue
			}
		}
		out = append(out, buildImage(r, hy, viewer))
	}
	return out
}

func buildImage(r RawImage, hy *Hydrated, viewer Viewer) Image {
	thumb, hasThumb := hy.Thumbs[r.ID]
	nsfw := r.NsfwLevel
	if hasThumb && thumb.NsfwLevel > nsfw {
		nsfw = thumb.NsfwLevel
	}
	var model3d any
	if r.Model3DID != nil && hy.VisibleModel3D[*r.Model3DID] {
		model3d = int64(*r.Model3DID)
	}
	var publishedAt any = superjson.Undefined{}
	if r.PublishedAt != nil {
		publishedAt = r.SortAt
	}

	basic, hasBasic := hy.Basic[r.UserID]
	user := superjson.Object{
		{Key: "id", Val: int64(r.UserID)},
		{Key: "username", Val: pick(hasBasic, basic.Username)},
		{Key: "image", Val: pick(hasBasic, basic.Image)},
		{Key: "deletedAt", Val: pick(hasBasic, basic.DeletedAt)},
	}
	if c, ok := hy.UserCosmetics[r.UserID]; ok {
		user = append(user, superjson.Field{Key: "cosmetics", Val: c})
	} else {
		user = append(user, superjson.Field{Key: "cosmetics", Val: []any{}})
	}
	if pp, ok := hy.ProfilePics[r.UserID]; ok {
		user = append(user, superjson.Field{Key: "profilePicture", Val: pp})
	} else {
		user = append(user, superjson.Field{Key: "profilePicture", Val: nil})
	}

	metrics, hasMetrics := hy.Metrics[r.ID]
	stats := hydrate.Stats(metrics, hasMetrics)

	reactions := []any{}
	if rs, ok := hy.Reactions[r.ID]; ok {
		reactions = rs
	}
	tagIDs, hasTagIDs := hy.TagIDs[r.ID]
	var frame any
	if f, ok := hy.Frames[r.ID]; ok {
		frame = f
	}
	var decoration any
	if d, ok := hy.Decorations[r.ID]; ok {
		decoration = d
	}
	var thumbURL any = superjson.Undefined{}
	if hasThumb {
		thumbURL = thumb.URL // `thumbnail?.url`: a thumbnail without a url is null, not undefined
	}

	// Key order follows the JS object: the SELECT's columns (spread), with in-place overrides keeping
	// their position, then the added keys. Dropped by the wire trims: hideMeta, scannedAt, mimeType,
	// postTitle, acceptableMinor, meta, availability, baseModel, judgeScore.
	wire := superjson.Object{
		{Key: "id", Val: int64(r.ID)},
		{Key: "name", Val: strOrNil(r.Name)},
		{Key: "url", Val: strOrNil(r.URL)},
		{Key: "nsfwLevel", Val: int64(nsfw)},
		{Key: "width", Val: intOrNil(r.Width)},
		{Key: "height", Val: intOrNil(r.Height)},
		{Key: "hash", Val: strOrNil(r.Hash)},
		{Key: "hasMeta", Val: r.HasMeta},
		{Key: "hasPositivePrompt", Val: r.HasPositivePrompt},
		{Key: "onSite", Val: boolOrNil(r.OnSite)},
		{Key: "remixOfId", Val: rawOrNil(r.RemixOfID)},
		{Key: "createdAt", Val: r.CreatedAt},
		{Key: "sortAt", Val: r.SortAt},
		{Key: "type", Val: r.Type},
		{Key: "metadata", Val: rawOrNil(r.Metadata)},
		{Key: "ingestion", Val: r.Ingestion},
		{Key: "blockedFor", Val: strOrNil(r.BlockedFor)},
		{Key: "needsReview", Val: strOrNil(r.NeedsReview)},
		{Key: "postId", Val: int64(r.PostID)},
		{Key: "index", Val: intOrNil(r.Index)},
		{Key: "publishedAt", Val: publishedAt},
		{Key: "modelVersionId", Val: intOrNil(r.ModelVersionID)},
		{Key: "model3dId", Val: model3d},
		{Key: "minor", Val: r.Minor},
		{Key: "poi", Val: r.Poi},
		{Key: "modelVersionIds", Val: []any{}},
		{Key: "modelVersionIdsManual", Val: []any{}},
		{Key: "user", Val: user},
		{Key: "stats", Val: stats},
		{Key: "reactions", Val: reactions},
		{Key: "tags", Val: superjson.Undefined{}},
		{Key: "tagIds", Val: orUndefined(tagIDs, hasTagIDs)},
		{Key: "cosmetic", Val: frame},
		{Key: "eventDecoration", Val: decoration},
		{Key: "thumbnailUrl", Val: thumbURL},
	}
	idx := 0
	if r.Index != nil {
		idx = *r.Index
	}
	return Image{
		Wire: wire, ID: r.ID, PostID: r.PostID, Index: idx, NsfwLevel: nsfw, SortAt: r.SortAt,
		PublishedAt: publishedAt, ModelVerID: intOrNil(r.ModelVersionID), User: user, Stats: stats,
	}
}

func pick(ok bool, v any) any {
	if !ok || v == nil {
		return nil
	}
	return v
}

func boolOrNil(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

// FetchImages is one getAllImages call: query, hydrate, transform.
func FetchImages(ctx context.Context, db Querier, cache *QueryCache, h Hydrator, q ImagesQuery, viewer Viewer, visibleEvents map[string]bool, now time.Time) (*Page, error) {
	b := q.Build()
	rows, err := FetchRows(ctx, db, cache, b)
	if err != nil {
		return nil, fmt.Errorf("image query: %w", err)
	}
	page := &Page{}
	if len(rows) > q.Limit {
		next := rows[len(rows)-1]
		rows = rows[:len(rows)-1]
		page.NextCursor = next.CursorID
	}
	hy, err := Hydrate(ctx, h, rows, viewer, visibleEvents)
	if err != nil {
		return nil, err
	}
	page.Images = BuildImages(rows, hy, viewer, now)
	return page, nil
}

// itoa is strconv.Itoa, kept short for keys.
func itoa(n int) string { return strconv.Itoa(n) }
