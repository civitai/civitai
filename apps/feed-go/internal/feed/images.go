package feed

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
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
	Restricted        bool            `json:"restricted"`
	CursorID          int             `json:"cursorId"`
	// CursorNull: the cursor column was NULL (only an index-ordered query's, ImagesQuery.IndexOrder,
	// can be: `i."index"` is nullable).
	CursorNull bool `json:"cursorNull,omitempty"`
	// Collection is the row's collection item columns: set exactly on a collection page's rows
	// (ImagesQuery.CollectionID), nil on every other query's.
	Collection *CollectionItem `json:"collection,omitempty"`
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
	// ReadOnly reads entries but never writes one (the Go-first probe: it makes no writes).
	ReadOnly bool
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
// empty page (never cached) unless the query asks to throw, as Node answers a statement timeout (getAllImages: "feeds can accept an
// empty page after a timeout"), so a slow replica is not handed on to the Node app to run again. Only
// this query's own deadline does that: a cancelled or expired caller context is still an error.
//
// A personalized page (Built.PersonalizedViewerID) is the `statement-timeout` fallback instead: an
// empty page there reads as "you have none", so it is logged, counted and handed to the Node app,
// which errors on the same timeout (getAllImages' throwOnStatementTimeout).
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
	onError := func(err error) ([]RawImage, error) {
		if b.ThrowOnStatementTimeout || ctx.Err() != nil || !errors.Is(qctx.Err(), context.DeadlineExceeded) {
			return nil, err
		}
		if b.PersonalizedViewerID != 0 {
			return nil, fallback.Safef("statement-timeout", "viewer %d", b.PersonalizedViewerID)
		}
		return []RawImage{}, nil
	}
	rows, err := db.Query(qctx, b.SQL, b.Args...)
	if err != nil {
		return onError(err)
	}
	out, err := scanRows(rows, b.Collection)
	if err != nil {
		return onError(err)
	}
	if useCache && !cache.ReadOnly {
		if raw, err := json.Marshal(out); err == nil {
			// One pipelined round trip for the entry and its bust-tag memberships (a cluster client
			// splits it per node). Fail open: a cache write error never fails the request.
			_, _ = cache.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
				p.Set(ctx, key, raw, b.CacheTTL)
				for _, tag := range b.CacheTags {
					p.SAdd(ctx, cache.Prefix+"tag:"+tag, key)
				}
				return nil
			})
		}
	}
	return out, nil
}

// scanRows reads the page query's rows. collection: the query selects the three collection item
// columns after "cursorId" (Built.Collection).
func scanRows(rows pgx.Rows, collection bool) ([]RawImage, error) {
	defer rows.Close()
	var out []RawImage
	for rows.Next() {
		var r RawImage
		var remix, meta []byte
		var cursorID *int
		dest := []any{
			&r.ID, &r.Name, &r.URL, &r.NsfwLevel, &r.Width, &r.Height, &r.Hash, &r.HideMeta, &r.HasMeta,
			&r.HasPositivePrompt, &r.OnSite, &remix, &r.CreatedAt, &r.SortAt, &r.MimeType, &r.Type, &meta,
			&r.Ingestion, &r.BlockedFor, &r.ScannedAt, &r.NeedsReview, &r.UserID, &r.PostID, &r.PostTitle,
			&r.Index, &r.PublishedAt, &r.UnpublishedAt, &r.ModelVersionID, &r.Model3DID, &r.Availability,
			&r.Minor, &r.Poi, &r.AcceptableMinor, &r.Restricted, &cursorID,
		}
		var item CollectionItem
		if collection {
			dest = append(dest, &item.Note, &item.Status, &item.AddedByID)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		if collection {
			r.Collection = &item
		}
		if cursorID != nil {
			r.CursorID = *cursorID
		} else {
			r.CursorNull = true
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
	PublishedAt any // the wire's sortAt Date (*time.Time, see SortAtWire) or Undefined
	ModelVerID  any
	User        superjson.Object
	Stats       superjson.Object
	// sortAt is the image's one `sortAt` Date as the wire holds it: getAllImagesUncaptured writes
	// `publishedAt: i.publishedAt ? i.sortAt : undefined`, and the gallery handler copies both onto the
	// post, so the Node answer holds ONE Date at up to four places. A shared pointer is that one Date to
	// the devalue writer (written once, referenced after); the superjson writer reads through it.
	sortAt *time.Time
}

// SortAtWire is the image's sortAt as it goes on the wire: the Date buildImage shared between the
// image's sortAt and publishedAt, or SortAt itself for an Image built without it.
func (img Image) SortAtWire() any {
	if img.sortAt != nil {
		return img.sortAt
	}
	return img.SortAt
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
	// Page is every cache-backed lookup of a page, its cache reads in one pipeline per dependency stage.
	Page(ctx context.Context, req hydrate.PageRequest) (*hydrate.Page, error)
	VisibleModel3DIDs(ctx context.Context, ids []int, viewerID int, isModerator bool) (map[int]bool, error)
}

// Hydrated is everything the per-image transform joins in.
type Hydrated struct {
	Basic         map[int]hydrate.BasicUser
	UserCosmetics map[int][]any
	ProfilePics   map[int]superjson.Object
	Frames        map[int]superjson.Object
	Thumbs        map[int]hydrate.Thumbnail
	Metrics       map[int]hydrate.Metrics
	TagIDs        map[int]any
	Decorations   map[int]superjson.Object
	Reactions     map[int][]any
	// Tags is each image's votable tags (include 'tags', image.getInfinite only); an image absent has
	// `tags: undefined`.
	Tags           map[int][]any
	VisibleModel3D map[int]bool
}

// Hydrate runs the hydration of getAllImagesUncaptured for include = [cosmetics, tagIds,
// profilePictures] (what the gallery handler always passes): every lookup of the page in one
// Hydrator.Page call, then the Model3D visibility of the linked models.
func Hydrate(ctx context.Context, h Hydrator, rows []RawImage, viewer Viewer, visibleEvents map[string]bool) (*Hydrated, error) {
	return hydrateRows(ctx, h, rows, viewer, visibleEvents, includes{profilePictures: true, cosmetics: true})
}

// includes is what an `include` list asks getAllImagesUncaptured to hydrate beyond the default: the
// creators' profile pictures, the cosmetics (user cosmetics and image frames) and the votable tags.
type includes struct {
	profilePictures, cosmetics, tags bool
}

// hydrateRows is Hydrate for the include list inc: without 'profilePictures' every creator's
// profilePicture is null, and its cache is not read; without 'cosmetics' every creator's cosmetics
// are [] and every image's frame null, and neither cache is read; with 'tags' the votable tags (and
// the viewer's votes on them) are read, without them every image's `tags` is undefined.
func hydrateRows(ctx context.Context, h Hydrator, rows []RawImage, viewer Viewer, visibleEvents map[string]bool, inc includes) (*Hydrated, error) {
	req := hydrate.PageRequest{
		UserIDs:           make([]int, 0, len(rows)),
		ImageIDs:          make([]int, 0, len(rows)),
		VisibleEvents:     visibleEvents,
		ViewerID:          viewer.ID,
		NoProfilePictures: !inc.profilePictures,
		NoCosmetics:       !inc.cosmetics,
		Tags:              inc.tags,
	}
	var model3dIDs []int
	for _, r := range rows {
		req.ImageIDs = append(req.ImageIDs, r.ID)
		req.UserIDs = append(req.UserIDs, r.UserID)
		if r.Type == "video" {
			req.VideoIDs = append(req.VideoIDs, r.ID)
		}
		if r.Model3DID != nil {
			model3dIDs = append(model3dIDs, *r.Model3DID)
		}
	}
	p, err := h.Page(ctx, req)
	if err != nil {
		return nil, err
	}
	out := &Hydrated{
		Basic: p.Basic, UserCosmetics: p.UserCosmetics, ProfilePics: p.ProfilePics, Frames: p.Frames,
		Thumbs: p.Thumbs, Metrics: p.Metrics, TagIDs: p.TagIDs, Decorations: p.Decorations, Reactions: p.Reactions,
	}
	if inc.tags {
		out.Tags = p.Tags
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
	// One Date for sortAt and publishedAt (`publishedAt: i.publishedAt ? i.sortAt : undefined`).
	sortAt := new(time.Time)
	*sortAt = r.SortAt
	var publishedAt any = superjson.Undefined{}
	if r.PublishedAt != nil {
		publishedAt = sortAt
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
	tags, hasTags := hy.Tags[r.ID]
	var frame any
	if f, ok := hy.Frames[r.ID]; ok {
		frame = f
	}
	var decoration any
	if d, ok := hy.Decorations[r.ID]; ok {
		decoration = d
	}
	// feedThumbnailFields: the level counts either way; the url only for a servable thumbnail, the
	// creator or a moderator.
	var thumbURL any = superjson.Undefined{}
	if hasThumb && (thumb.Servable || (viewer.ID != 0 && r.UserID == viewer.ID) || viewer.IsModerator) {
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
		{Key: "sortAt", Val: sortAt},
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
		{Key: "restricted", Val: r.Restricted},
		{Key: "modelVersionIds", Val: []any{}},
		{Key: "modelVersionIdsManual", Val: []any{}},
		{Key: "user", Val: user},
		{Key: "stats", Val: stats},
		{Key: "reactions", Val: reactions},
		// `tagsByImageId?.get(i.id)`: only built for include 'tags' (image.getInfinite; the gallery
		// falls back on it), and then undefined for an image with no tag. Node's wire carries an
		// undefined as `null` + ["undefined"]; the comparator decodes both the same (internal/shadow
		// applyUndefined).
		{Key: "tags", Val: orUndefined(any(tags), hasTags)},
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
		sortAt: sortAt,
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
