package feed

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Cursor is a page cursor as the handler carries it between fetches: N, the Postgres path's image id
// (or a numeric cursor as the client sent it), or S, a string cursor (the feed service's
// `feed:<a>:<b>`, or the client's own string). The zero value is "no cursor", which is also how the
// handler tests a cursor: `if (!cursor)` (a string cursor is truthy even when it reads as 0).
type Cursor struct {
	N int
	S string
}

// None reports whether the cursor is falsy.
func (c Cursor) None() bool { return c.N == 0 && c.S == "" }

func (c Cursor) value() any {
	if c.S != "" {
		return c.S
	}
	if c.N != 0 {
		return int64(c.N)
	}
	return superjson.Undefined{}
}

// pageSource is the handler's `fetchFn`: getAllImages (Postgres) or getAllImagesIndex (the feed
// service picks the page, Postgres supplies the rows), chosen by the `image-index-feed` flag.
type pageSource interface {
	// Page is one paged fetch from cursor (None = the first page), at most limit images.
	Page(ctx context.Context, cursor Cursor, limit int) ([]Image, Cursor, error)
	// Posts is the post completion: postIDs' images, in the requested sort, at most limit rows.
	Posts(ctx context.Context, postIDs []int, limit int) ([]Image, error)
}

// FeedFetcher is the feed service (feedsvc.Client).
type FeedFetcher interface {
	Fetch(ctx context.Context, query string) (feedsvc.Answer, error)
}

// dbSource is getAllImages with the handler's page arguments.
type dbSource struct {
	d      *Deps
	q      ImagesQuery
	viewer Viewer
	now    time.Time
}

func (s *dbSource) Page(ctx context.Context, cursor Cursor, limit int) ([]Image, Cursor, error) {
	q := s.q
	q.Cursor, q.Limit = cursor.N, limit
	page, err := FetchImages(ctx, s.d.DB, s.d.Cache, s.d.Hydrator, q, s.viewer, s.d.Config.VisibleDecorationEvents, s.now)
	if err != nil {
		return nil, Cursor{}, err
	}
	return page.Images, Cursor{N: page.NextCursor}, nil
}

func (s *dbSource) Posts(ctx context.Context, postIDs []int, limit int) ([]Image, error) {
	q := s.q
	q.Cursor, q.Limit, q.PostIDs = 0, limit, postIDs
	page, err := FetchImages(ctx, s.d.DB, s.d.Cache, s.d.Hydrator, q, s.viewer, s.d.Config.VisibleDecorationEvents, s.now)
	if err != nil {
		return nil, err
	}
	return page.Images, nil
}

// indexSource is getAllImagesIndex with the feed service available (serveImagesFromFeedService →
// serveFromFeed → answerWithoutFeed).
type indexSource struct {
	feed FeedFetcher
	// base is the search input the mapper reads, without its cursor, limit and post ids.
	base feedsvc.Query
	// hydrate loads exactly ids (feedHydrateQuery: the request's filters without paging, period or
	// model scope), restricted to postIDs when set, in any order.
	hydrate func(ctx context.Context, ids, postIDs []int) ([]Image, error)
}

func (s *indexSource) Page(ctx context.Context, cursor Cursor, limit int) ([]Image, Cursor, error) {
	q := s.base
	q.Limit = limit
	if cursor.S != "" {
		q.CursorText = cursor.S
	} else {
		q.CursorNum = cursor.N
	}
	return s.serve(ctx, q)
}

func (s *indexSource) Posts(ctx context.Context, postIDs []int, limit int) ([]Image, error) {
	q := s.base
	q.Limit, q.PostIDs = limit, postIDs
	images, _, err := s.serve(ctx, q)
	return images, err
}

// serve answers one getAllImagesIndex call, or falls back where Node answers with an error (or with
// something this service cannot reproduce).
func (s *indexSource) serve(ctx context.Context, q feedsvc.Query) ([]Image, Cursor, error) {
	query, refusal := feedsvc.Map(q)
	if refusal != nil {
		if refusal.Rejected {
			// answerWithoutFeed: a BAD_REQUEST (malformed cursor, too-deep offset, unknown sort).
			return nil, Cursor{}, fallback.New("feed-" + refusal.Reason)
		}
		// answerWithoutFeed's 'empty' branch: a shape the feed cannot express is an empty page.
		return nil, Cursor{}, nil
	}
	ans, err := s.feed.Fetch(ctx, query)
	if err != nil {
		// Node answers a failed call with a 503, or (feed-service-degrade on) with the pod's last good
		// copy of the page, which this service does not hold.
		return nil, Cursor{}, fallback.Newf("feed-unavailable", "%v", err)
	}
	if ans.Status != 200 {
		return nil, Cursor{}, fallback.Newf("feed-status", "%d", ans.Status)
	}
	var next Cursor
	if ans.NextCursor != "" {
		next.S = feedsvc.EncodeCursor(ans.NextCursor)
	}
	if len(ans.IDs) == 0 {
		return nil, next, nil
	}
	rows, err := s.hydrate(ctx, ans.IDs, q.PostIDs)
	if err != nil {
		return nil, Cursor{}, err
	}
	if len(rows) == 0 {
		// hydrateWithReadRescue retries an empty hydrate on the other read replica, which
		// this service does not reach; only then is it an empty page that keeps the feed's cursor.
		return nil, Cursor{}, fallback.New("feed-hydrate-empty")
	}
	byID := make(map[int]Image, len(rows))
	for _, r := range rows {
		byID[r.ID] = r
	}
	// The feed's order, restored over the rows (ids.flatMap).
	out := make([]Image, 0, len(ans.IDs))
	for _, id := range ans.IDs {
		if r, ok := byID[id]; ok {
			out = append(out, r)
		}
	}
	return out, next, nil
}

// postImageLimit is POST_IMAGE_LIMIT: a post's image count when its row count is unknown.
const postImageLimit = 20

// Completion fetch bounds (COMPLETION_POSTS_PER_FETCH, COMPLETION_ROWS_PER_FETCH = FEED_MAX_LIMIT).
const (
	completionPostsPerFetch = 25
	completionRowsPerFetch  = feedsvc.MaxLimit
)

// packPostCompletions groups posts into completion fetches of at most completionPostsPerFetch posts
// and completionRowsPerFetch rows, in order; a post larger than one fetch goes alone.
func packPostCompletions(postIDs []int, rowsOf func(int) int) [][]int {
	var batches [][]int
	var batch []int
	rows := 0
	for _, id := range postIDs {
		r := rowsOf(id)
		full := len(batch) >= completionPostsPerFetch || rows+r > completionRowsPerFetch
		if len(batch) > 0 && full {
			batches = append(batches, batch)
			batch, rows = nil, 0
		}
		batch = append(batch, id)
		rows += r
	}
	if len(batch) > 0 {
		batches = append(batches, batch)
	}
	return batches
}

// postImageCountsSQL is getPostImageCounts: every image row of each post, before any visibility
// filter (an upper bound on what a filtered fetch of the post returns).
const postImageCountsSQL = `
      SELECT i."postId", count(*)::int AS "count"
      FROM "Image" i
      WHERE i."postId" = ANY($1::int[])
      GROUP BY i."postId"
    `

// PostImageCounts is getPostImageCounts, under the image feed's statement timeout.
func PostImageCounts(ctx context.Context, db Querier, postIDs []int) (map[int]int, error) {
	out := map[int]int{}
	if len(postIDs) == 0 {
		return out, nil
	}
	qctx, cancel := context.WithTimeout(ctx, statementTimeout)
	defer cancel()
	rows, err := db.Query(qctx, postImageCountsSQL, postIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var postID, n int
		if err := rows.Scan(&postID, &n); err != nil {
			return nil, err
		}
		out[postID] = n
	}
	return out, rows.Err()
}

// completePosts is the handler's lazy-post-images completion: a post the page holds fewer images of
// than its row count is fetched again whole (in the requested sort), and the images it lacks are
// appended to it in the order the completions return them. counts nil = the count query failed,
// so every post counts as POST_IMAGE_LIMIT rows (Node completes all of them rather than leave one
// short).
func completePosts(ctx context.Context, src pageSource, posts map[int][]Image, postIDs []int, counts map[int]int) error {
	rowCountOf := func(id int) int {
		if n, ok := counts[id]; ok {
			return n
		}
		return postImageLimit
	}
	var partial []int
	for _, id := range postIDs {
		if rowCountOf(id) > len(posts[id]) {
			partial = append(partial, id)
		}
	}
	batches := packPostCompletions(partial, rowCountOf)
	results := make([][]Image, len(batches))
	g, gctx := errgroup.WithContext(ctx)
	for i, batch := range batches {
		limit := 0
		for _, id := range batch {
			limit += rowCountOf(id)
		}
		g.Go(func() error {
			images, err := src.Posts(gctx, batch, limit)
			if err != nil {
				return fmt.Errorf("post completion: %w", err)
			}
			results[i] = images
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	for _, images := range results {
		for _, img := range images {
			if img.PostID == 0 {
				continue
			}
			post, ok := posts[img.PostID]
			if !ok || hasImage(post, img.ID) {
				continue
			}
			posts[img.PostID] = append(post, img)
		}
	}
	return nil
}

func hasImage(images []Image, id int) bool {
	for _, x := range images {
		if x.ID == id {
			return true
		}
	}
	return false
}
