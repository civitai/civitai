package feed

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// V1Sources is the hydration the public images endpoint reads (implemented by *hydrate.Sources). It is
// narrower than Hydrator: the endpoint publishes no cosmetics, frames, tags, reactions or decorations,
// so their reads (and their cache-miss fallbacks) are skipped.
type V1Sources interface {
	// V1Page is the page's basic users, thumbnails, metric hashes and image resources, their cache
	// reads in one pipeline.
	V1Page(ctx context.Context, req hydrate.V1PageRequest) (*hydrate.V1Page, error)
	PostVersions(ctx context.Context, postIDs []int) (map[int]int, error)
	VersionModels(ctx context.Context, versionIDs []int) (map[int]int, error)
	UserIDByUsername(ctx context.Context, username string) (int, bool, error)
}

// V1Gallery is what the endpoint's gallery hold reads (implemented by *GalleryStore).
type V1Gallery interface {
	SettingsMany(ctx context.Context, modelIDs []int) (map[int]*GallerySettings, error)
	Withheld(ctx context.Context, modelIDs []int, viewerID int) (bool, error)
}

// V1Deps are the endpoint's collaborators.
type V1Deps struct {
	// Feed is the image feed service; nil = not configured (every request falls back).
	Feed    FeedFetcher
	Sources V1Sources
	Gallery V1Gallery
	// Rows loads one hydrate query's rows (production: FetchRows over the replica).
	Rows func(ctx context.Context, q ImagesQuery) ([]RawImage, error)
	// Addons returns the browsing-settings addons.
	Addons func(ctx context.Context) []browsing.Addon
	// ImageLocation is NEXT_PUBLIC_IMAGE_LOCATION, the edge URL prefix; "" = not configured (fall back).
	ImageLocation string
	// NodeProduction mirrors the Node app's isProd: nextPage is https://<host> there, else
	// http://localhost:3000.
	NodeProduction bool
	Now            func() time.Time
	// Ports are the switches of the shapes ported behind one (ParseV1With).
	Ports V1Ports
}

// V1Request is one call.
type V1Request struct {
	Input *V1Input
	// Viewer is nil when signed out or banned (getApiAuthSession whenBanned 'anonymous').
	Viewer *Viewer
	// ViewerUsername is the session user's name ("" with no Viewer): the legacy path's own-feed check
	// reads it (the feed path's viewer carries none).
	ViewerUsername   string
	RegionRestricted bool
	// Host and Path are the request's Host header and path (nextPage is built from them).
	Host string
	Path string
}

// emptyGate is the answer for a withheld or fully held gallery: `{ items: [], metadata: {} }`.
func emptyGate() superjson.Object {
	return superjson.Object{{Key: "items", Val: []any{}}, {Key: "metadata", Val: superjson.Object{}}}
}

// V1Answer is one computed answer.
type V1Answer struct {
	// Body is what Node writes with `res.status(200).json(...)`.
	Body superjson.Object
	// Trivial marks an answer computed without loading any image or running a page query (a legacy
	// page whose query ran is not trivial, even when empty). Such answers cost almost nothing on
	// either side, so they are kept out of the CPU-per-served-call and match series (outcome
	// `served_empty`, result `match_empty`).
	Trivial bool
}

// RequestedLevel is handleImagesRequest's `browsingLevel ?? nsfw ?? publicBrowsingLevelsFlag`: the
// level the request asks for, before a restricted region clamps it or a gallery hold narrows it.
func (in *V1Input) RequestedLevel() int {
	switch {
	case in.BrowsingLevel != nil:
		return *in.BrowsingLevel
	case in.Nsfw != nil:
		return *in.Nsfw
	}
	return browsing.PublicLevels
}

// WithinSFW is handleImagesRequest's `withinSfw` over RequestedLevel: an integer from 0 to
// sfwBrowsingLevelsFlag whose every bit is an SFW level. Outside it the handler answers
// `Cache-Control: private, no-store` (the body depends on the caller's region, which a shared cache
// does not key on).
func (in *V1Input) WithinSFW() bool {
	l := in.RequestedLevel()
	return l >= 0 && l <= browsing.SFWLevels && l&browsing.SFWLevels == l
}

// ServeV1 is the `/api/v1/images` handler (handleImagesRequest) on the feed-service path
// (runImageSearch → getImagesFromFeedServiceForRest), for the supported subset.
func ServeV1(ctx context.Context, d *V1Deps, req V1Request) (*V1Answer, error) {
	in := req.Input
	if d.Feed == nil {
		// Node answers from Postgres without a feed service (local development only).
		return nil, fallback.New("index-feed-unconfigured")
	}
	if d.ImageLocation == "" {
		return nil, fallback.New("v1-image-location-unconfigured")
	}
	usingPaging := in.Page != 0 && in.Cursor == ""
	if usingPaging && in.Page*in.Limit > 1000 {
		return nil, fallback.New("v1-page-limit") // Node answers a 429
	}
	viewer := Viewer{}
	if req.Viewer != nil {
		viewer = *req.Viewer
	}

	level := in.RequestedLevel()
	if req.RegionRestricted {
		level = browsing.SFWLevels
	}
	// A minor or SFW-only model's images are served only at its gallery's held level, and a taken-down
	// model's not at all (its owner and moderators included, on this route).
	if in.ModelID != 0 || in.ModelVersionID != 0 || in.PostID != 0 {
		modelIDs, ok, err := resolveImageModelIDs(ctx, d.Sources, in.ModelID, in.ModelVersionID, in.PostID, nil)
		if err != nil {
			return nil, err
		}
		if !ok {
			return &V1Answer{Body: emptyGate(), Trivial: true}, nil
		}
		withheld, err := d.Gallery.Withheld(ctx, modelIDs, 0)
		if err != nil {
			return nil, err
		}
		if withheld {
			return &V1Answer{Body: emptyGate(), Trivial: true}, nil
		}
		levels, err := heldLevels(ctx, d.Gallery, modelIDs, "v1-held-level-unset")
		if err != nil {
			return nil, err
		}
		if len(levels) > 0 {
			held := browsing.AllLevels
			for _, l := range levels {
				held &= l
			}
			level &= held
			if level == 0 {
				return &V1Answer{Body: emptyGate(), Trivial: true}, nil
			}
		}
	}

	var page *v1Result
	var err error
	if len(in.IDs) > 0 {
		viewerUsername := ""
		if req.Viewer != nil {
			viewerUsername = req.ViewerUsername
		}
		page, err = v1LegacyPage(ctx, d, in, viewer, viewerUsername, level, usingPaging)
	} else {
		page, err = v1Page(ctx, d, in, viewer, level)
	}
	if err != nil {
		return nil, err
	}
	items, err := withoutHeldImages(ctx, d, page.items)
	if err != nil {
		return nil, err
	}

	meta := superjson.Object{}
	if page.hasNext {
		meta = append(meta, superjson.Field{Key: "nextCursor", Val: page.next})
	}
	if usingPaging {
		meta = append(meta, superjson.Field{Key: "currentPage", Val: int64(in.Page)},
			superjson.Field{Key: "pageSize", Val: int64(in.Limit)})
	}
	// getNextPage: `!!nextCursor`, so a legacy cursor of 0 or null has no next page.
	if cursor, ok := nextCursorText(page); ok {
		next, err := nextPageURL(in, req.Host, req.Path, d.NodeProduction, usingPaging, cursor)
		if err != nil {
			return nil, err
		}
		meta = append(meta, superjson.Field{Key: "nextPage", Val: next})
	}
	wire := make([]any, len(items))
	for i, it := range items {
		wire[i] = it.wire
	}
	body := superjson.Object{{Key: "items", Val: wire}, {Key: "metadata", Val: meta}}
	return &V1Answer{Body: body, Trivial: !page.hydrated}, nil
}

// v1Item is one shaped image plus what withoutHeldImages reads.
type v1Item struct {
	wire          superjson.Object
	postID        int
	browsingLevel int
}

type v1Result struct {
	items []v1Item
	// next is the answer's nextCursor when hasNext (else undefined): the feed's `feed:<a>:<b>`, or on
	// the legacy path the look-ahead row's cursor column, a number (int64) or null (nil, a NULL index).
	next    any
	hasNext bool
	// hydrated: the page's rows were loaded, or on the legacy path its query ran (false = a trivial
	// answer, see V1Answer).
	hydrated bool
}

// feedNext is a feed page's result with its encoded cursor ("" = the end of the feed).
func feedNext(next string) *v1Result {
	if next == "" {
		return &v1Result{}
	}
	return &v1Result{next: next, hasNext: true}
}

// nextCursorText is the cursor getNextPage writes into nextPage, and whether it writes one at all
// (`!!nextCursor`: not for an empty string, a 0 or a null).
func nextCursorText(r *v1Result) (string, bool) {
	if !r.hasNext {
		return "", false
	}
	switch c := r.next.(type) {
	case string:
		return c, c != ""
	case int64:
		return strconv.FormatInt(c, 10), c != 0
	}
	return "", false
}

// v1Page is runImageSearch's feed-service arm: getImagesFromFeedServiceForRest, then the shaping.
func v1Page(ctx context.Context, d *V1Deps, in *V1Input, viewer Viewer, level int) (*v1Result, error) {
	if err := AssertFeedOffsetCursor(in.Cursor); err != nil {
		return nil, err
	}
	if in.Limit < 1 {
		return &v1Result{}, nil
	}

	// prepareImageFeedRequest: the addons are resolved at the request's level for this viewer. The
	// viewer there carries no username, so only a `userId` naming the viewer is their own feed (which
	// keeps its tag exclusions off). disablePoi / disableMinor are always on for this route.
	var excluded []int
	ownScoped := ownScope(viewer.ID, "", in.UserID, in.Username)
	if resolved := browsing.ResolveAddons(d.Addons(ctx), AddonLevel(level), viewer.IsModerator, ""); !ownScoped && len(resolved.ExcludedTagIDs) > 0 {
		excluded = unionInts(nil, resolved.ExcludedTagIDs)
	}
	userID := in.UserID
	if userID == 0 && in.Username != "" {
		id, err := d.userIDByUsername(ctx, in.Username)
		if err != nil {
			return nil, err
		}
		userID = id
	}

	types := []string(nil)
	if in.Type != "" {
		types = []string{in.Type}
	}
	q := feedsvc.Query{
		Rest:           true,
		BrowsingLevel:  level,
		ExcludedTagIDs: excluded,
		ModelID:        in.ModelID,
		ModelVersionID: in.ModelVersionID,
		PostID:         in.PostID,
		UserID:         userID,
		Types:          types,
		DisableMinor:   true,
		DisablePoi:     true,
		ViewerID:       viewer.ID,
		Sort:           in.Sort,
		Period:         in.Period,
		Limit:          in.Limit,
		CursorText:     in.Cursor,
		RequiringMeta:  in.RequiringMeta,
	}
	feedCursor := feedsvc.ParseCursor(in.Cursor) != ""
	query, refusal := feedsvc.Map(q)
	if refusal != nil {
		// A refused feed cursor is a 400 ("cannot be continued with these filters"), and so is a
		// rejected shape; every other refusal is an empty page (answerWithoutFeed).
		if refusal.Rejected || feedCursor {
			return nil, fallback.New("feed-refused")
		}
		return &v1Result{}, nil
	}
	ans, err := d.Feed.Fetch(ctx, query)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Wrap("feed-unavailable", err) // Node: a retryable 503
	}
	if ans.Status != 200 {
		// A 5xx is a 503 on Node; a 4xx is an empty page there (a 400 with a feed cursor). A feed that
		// refused this call but answered Node is not a page to compare, so every one falls back.
		return nil, fallback.Safef("feed-status", "%d", ans.Status)
	}
	var next string
	if ans.NextCursor != "" {
		next = feedsvc.EncodeCursor(ans.NextCursor)
	}
	if len(ans.IDs) == 0 {
		return feedNext(next), nil
	}

	// feedHydrateQuery: the request's filters without its paging, period or model scope.
	hq := ImagesQuery{
		IDs:                     ans.IDs,
		Limit:                   len(ans.IDs),
		Sort:                    in.Sort,
		Period:                  "AllTime",
		PeriodMode:              "published",
		BrowsingLevel:           level,
		Types:                   types,
		DisablePoi:              true,
		DisableMinor:            true,
		ExcludedTagIDs:          excluded,
		ViewerID:                viewer.ID,
		IsModerator:             viewer.IsModerator,
		PostID:                  in.PostID,
		TargetUserID:            userID,
		ThrowOnStatementTimeout: true,
	}
	rows, err := d.Rows(ctx, hq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Wrap("feed-hydrate-error", err) // Node: hydrate:error, a 503
	}
	if len(rows) > hq.Limit {
		rows = rows[:hq.Limit]
	}
	now := clock.Now()
	if d.Now != nil {
		now = d.Now()
	}
	rows = publishedFor(rows, viewer, now)
	if len(rows) == 0 {
		// Node retries an empty DataPacket hydrate on another replica (hydrateWithReadRescue), which
		// this service does not reach.
		return nil, fallback.New("feed-hydrate-empty")
	}
	byID := make(map[int]RawImage, len(rows))
	for _, r := range rows {
		byID[r.ID] = r
	}
	ordered := make([]RawImage, 0, len(ans.IDs))
	for _, id := range ans.IDs {
		if r, ok := byID[id]; ok {
			ordered = append(ordered, r)
		}
	}
	items, err := shapeV1Page(ctx, d, ordered, level, v1Shaping{withMeta: in.WithMeta, flatMeta: in.FlatMeta})
	if err != nil {
		return nil, err
	}
	res := feedNext(next)
	res.items, res.hydrated = items, true
	return res, nil
}

// v1LegacyPage is runImageSearch's legacy arm for an `ids` batch: getAllImages itself. One Postgres
// page in getAllImages' own order (the id, descending, ascending for Oldest; a post's own media by
// its index), paged by `skip` or by a keyset cursor on that order, then the same shaping as the feed
// path. Unlike the feed's hydrate, an empty page is an answer here (getAllImages does no read rescue),
// and a statement timeout is an empty page, as Node answers it on this path.
func v1LegacyPage(ctx context.Context, d *V1Deps, in *V1Input, viewer Viewer, viewerUsername string, level int, usingPaging bool) (*v1Result, error) {
	cursor := 0
	if in.Cursor != "" {
		// getCursor binds a single-field sort's cursor as one integer (parseCursor); a cursor that is
		// not a positive integer is a 400 there, or a Date bound to an integer column (a 500), and a
		// "0" is truthy and bound (`<= 0`), an empty page. All of them fall back.
		n, err := v1Int(in.Cursor)
		if err != nil || n < 1 {
			return nil, fallback.New("v1-legacy-cursor")
		}
		cursor = n
	}
	// getAllImagesUncaptured: a level made only of unselectable bits is an empty page (none is PG).
	if level != 0 && browsing.OnlySelectable(level) == 0 {
		return &v1Result{}, nil
	}

	// enforceBlockedBrowsingTags: the addons at the request's level, for this viewer. Here the viewer
	// is the session user, username included, so a `username` naming the viewer is their own feed too.
	var excluded []int
	ownScoped := ownScope(viewer.ID, viewerUsername, in.UserID, in.Username)
	if resolved := browsing.ResolveAddons(d.Addons(ctx), AddonLevel(level), viewer.IsModerator, ""); !ownScoped && len(resolved.ExcludedTagIDs) > 0 {
		excluded = unionInts(nil, resolved.ExcludedTagIDs)
	}
	userID := in.UserID
	if userID == 0 && in.Username != "" {
		id, err := d.userIDByUsername(ctx, in.Username)
		if err != nil {
			return nil, err
		}
		userID = id
	}
	var types []string
	if in.Type != "" {
		types = []string{in.Type}
	}
	skip := 0
	if usingPaging {
		skip = (in.Page - 1) * in.Limit // getPagination
	}
	q := ImagesQuery{
		IDs:            in.IDs,
		Limit:          in.Limit,
		Skip:           skip,
		Cursor:         cursor,
		Sort:           in.Sort,
		Period:         in.Period,
		PeriodMode:     "published",
		BrowsingLevel:  level,
		ModelID:        in.ModelID,
		ModelVersionID: in.ModelVersionID,
		Types:          types,
		DisablePoi:     true,
		DisableMinor:   true,
		ExcludedTagIDs: excluded,
		ViewerID:       viewer.ID,
		IsModerator:    viewer.IsModerator,
		PostID:         in.PostID,
		TargetUserID:   userID,
		// `postId && !modelId`: a post's own media, in its order.
		IndexOrder: in.PostID != 0 && in.ModelID == 0,
	}
	rows, err := d.Rows(ctx, q)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Wrap("v1-legacy-error", err) // Node: a 500
	}
	res := &v1Result{hydrated: true} // the query ran, whatever it found
	if len(rows) > q.Limit {
		// The look-ahead row (LIMIT limit + 1) is popped; its cursor column is the next cursor.
		look := rows[len(rows)-1]
		rows = rows[:len(rows)-1]
		res.hasNext = true
		if !look.CursorNull {
			res.next = int64(look.CursorID)
		}
	}
	now := clock.Now()
	if d.Now != nil {
		now = d.Now()
	}
	rows = publishedFor(rows, viewer, now)
	if len(rows) == 0 {
		return res, nil
	}
	items, err := shapeV1Page(ctx, d, rows, level, v1Shaping{legacy: true, withMeta: in.WithMeta, flatMeta: in.FlatMeta})
	if err != nil {
		return nil, err
	}
	res.items = items
	return res, nil
}

// publishedFor is getAllImages' publish filter: for anyone but a moderator, an image whose post is
// unpublished, scheduled or unpublished-again is dropped unless it is the viewer's own.
func publishedFor(rows []RawImage, viewer Viewer, now time.Time) []RawImage {
	if viewer.IsModerator {
		return rows
	}
	out := rows[:0:0]
	for _, r := range rows {
		hidden := r.PublishedAt == nil || r.PublishedAt.After(now) || r.UnpublishedAt != nil
		if hidden && r.UserID != viewer.ID {
			continue
		}
		out = append(out, r)
	}
	return out
}

// userIDByUsername is findUserIdByUsername's replica read. Not found there falls back: Node reads the
// primary next, and answers an empty page only when that misses too.
func (d *V1Deps) userIDByUsername(ctx context.Context, username string) (int, error) {
	id, found, err := d.Sources.UserIDByUsername(ctx, username)
	if err != nil {
		return 0, err
	}
	if !found {
		return 0, fallback.New("v1-username-miss")
	}
	return id, nil
}

// v1Shaping is what of the request the shaping reads.
type v1Shaping struct {
	// legacy: the rows are the legacy Postgres path's (useLegacyMethod).
	legacy   bool
	withMeta bool
	flatMeta *bool
}

// v1Meta is the shaped `meta` member: null without withMeta; else the cached meta (null when the
// cache has none), flat when `flatMeta` says so (undefined: on the feed path only), otherwise
// wrapped as `{ id, meta }`.
func v1Meta(id int, metas map[int]any, s v1Shaping) any {
	if !s.withMeta {
		return nil
	}
	m := metas[id]
	flat := !s.legacy
	if s.flatMeta != nil {
		flat = *s.flatMeta
	}
	if flat {
		return m
	}
	return superjson.Object{{Key: "id", Val: int64(id)}, {Key: "meta", Val: m}}
}

// shapeV1Page hydrates what the endpoint publishes and shapes each image (runImageSearch's map).
func shapeV1Page(ctx context.Context, d *V1Deps, rows []RawImage, level int, s v1Shaping) ([]v1Item, error) {
	req := hydrate.V1PageRequest{UserIDs: make([]int, 0, len(rows)), ImageIDs: make([]int, 0, len(rows))}
	for _, r := range rows {
		req.ImageIDs = append(req.ImageIDs, r.ID)
		req.UserIDs = append(req.UserIDs, r.UserID)
		if r.Type == "video" {
			req.VideoIDs = append(req.VideoIDs, r.ID)
		}
	}
	if s.withMeta {
		req.MetaIDs = req.ImageIDs // imageMetaCache.fetch(items' ids)
	}
	page, err := d.Sources.V1Page(ctx, req)
	if err != nil {
		return nil, err
	}
	users, thumbs, metrics, resources := page.Basic, page.Thumbs, page.Metrics, page.Resources
	out := make([]v1Item, 0, len(rows))
	for _, r := range rows {
		thumb, hasThumb := thumbs[r.ID]
		m, hasMetrics := metrics[r.ID]
		res, hasRes := resources[r.ID]
		basic, hasBasic := users[r.UserID]
		it, err := ShapeV1Image(r, V1Hydrated{
			Thumb: thumb, HasThumb: hasThumb, Metrics: m, HasMetrics: hasMetrics,
			Resources: res, HasResources: hasRes, User: basic, HasUser: hasBasic,
			Meta: v1Meta(r.ID, page.Meta, s), OwnCreatedAt: s.legacy,
		}, level, d.ImageLocation)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

// V1Hydrated is one image's hydrated data.
type V1Hydrated struct {
	Thumb        hydrate.Thumbnail
	HasThumb     bool
	Metrics      hydrate.Metrics
	HasMetrics   bool
	Resources    []hydrate.ImageResource
	HasResources bool
	User         hydrate.BasicUser
	HasUser      bool
	// Meta is the image's shaped `meta` member (v1Meta; nil = null).
	Meta any
	// OwnCreatedAt: the row is the legacy path's, whose createdAt is the image's own; the feed path
	// publishes the row's sortAt as createdAt.
	OwnCreatedAt bool
}

// nsfwLevelReverseMapDeprecated / getNsfwLevelDeprecatedReverseMapping.
func deprecatedNsfwLevel(level int) string {
	switch level {
	case browsing.PG:
		return "None"
	case browsing.PG13:
		return "Soft"
	case browsing.R:
		return "Mature"
	case browsing.X, browsing.XXX:
		return "X"
	case browsing.Blocked:
		return "Blocked"
	}
	return "None"
}

// ShapeV1Image is one element of runImageSearch's `shaped` array.
func ShapeV1Image(r RawImage, h V1Hydrated, level int, location string) (v1Item, error) {
	nsfwLevel := r.NsfwLevel
	if h.HasThumb && h.Thumb.NsfwLevel > nsfwLevel {
		nsfwLevel = h.Thumb.NsfwLevel // getAllImages: Math.max(thumbnail?.nsfwLevel ?? 0, nsfwLevel)
	}
	dep := deprecatedNsfwLevel(nsfwLevel)
	var url any
	if r.URL != nil {
		url = EdgeURL(location, *r.URL, EdgeOptions{Type: r.Type, Original: boolPtr(true)})
	}
	thumbnail, err := publicVideoThumbnail(r, h, level, location)
	if err != nil {
		return v1Item{}, err
	}
	stats := hydrate.Stats(h.Metrics, h.HasMetrics)
	stat := func(k string) any { v, _ := stats.Get(k); return v }
	var username any
	if h.HasUser {
		username = h.User.Username
		switch u := username.(type) {
		case int64:
			username = strconv.FormatInt(u, 10)
		case uint64:
			username = strconv.FormatUint(u, 10)
		case float64:
			username = superjson.FormatNumber(u)
		}
	}
	// getBaseModelFromResources as image.service.ts imports it: the one in src/server/redis/caches.ts
	// (the checkpoint resource's raw baseModel, else null; no cache entry is null too), NOT the
	// same-named ecosystem-group helper in src/shared/constants/generation.constants.ts.
	var baseModel any
	modelVersionIDs := []any{}
	if h.HasResources {
		for _, res := range h.Resources {
			if res.ModelType == "Checkpoint" {
				baseModel = res.BaseModel
				break
			}
		}
		for _, res := range h.Resources {
			if res.Detected {
				modelVersionIDs = append(modelVersionIDs, int64(res.ModelVersionID))
			}
		}
	}
	createdAt := r.SortAt
	if h.OwnCreatedAt {
		createdAt = r.CreatedAt
	}
	wire := superjson.Object{
		{Key: "id", Val: int64(r.ID)},
		{Key: "url", Val: url},
		{Key: "hash", Val: strOrNil(r.Hash)},
		{Key: "width", Val: intOrNil(r.Width)},
		{Key: "height", Val: intOrNil(r.Height)},
		{Key: "nsfwLevel", Val: dep},
		{Key: "type", Val: r.Type},
		{Key: "nsfw", Val: dep != "None"},
		{Key: "browsingLevel", Val: int64(nsfwLevel)},
		// The feed path's createdAt is the row's sortAt (getImagesFromFeedServiceForRest); the legacy
		// path's is the image's own.
		{Key: "createdAt", Val: createdAt},
		{Key: "postId", Val: int64(r.PostID)},
		{Key: "thumbnail", Val: thumbnail},
		{Key: "stats", Val: superjson.Object{
			{Key: "cryCount", Val: stat("cryCountAllTime")},
			{Key: "laughCount", Val: stat("laughCountAllTime")},
			{Key: "likeCount", Val: stat("likeCountAllTime")},
			{Key: "dislikeCount", Val: stat("dislikeCountAllTime")},
			{Key: "heartCount", Val: stat("heartCountAllTime")},
			{Key: "commentCount", Val: stat("commentCountAllTime")},
		}},
		{Key: "meta", Val: h.Meta},
		{Key: "username", Val: username},
		{Key: "baseModel", Val: baseModel},
		{Key: "modelVersionIds", Val: modelVersionIDs},
		// `tags` is undefined without withTags (a fallback shape), so JSON.stringify omits it.
	}
	return v1Item{wire: wire, postID: r.PostID, browsingLevel: nsfwLevel}, nil
}

func boolPtr(b bool) *bool { return &b }

// EdgeOptions are the getEdgeUrl options the REST ports pass.
type EdgeOptions struct {
	Type      string
	Anim      *bool
	Transcode bool
	// Width is the requested width (0 = none), snapped up to the cacher's ladder and capped at 1800.
	Width     int
	Original  *bool
	Optimized *bool
	Skip      *float64
	// Name is the file name segment's source (nil = undefined: the src is used).
	Name *string
}

// edgeWidthLadder is COMMON_IMAGE_WIDTHS (src/client-utils/edge-url.ts).
var edgeWidthLadder = []int{96, 320, 450, 512, 800, 1200, 1600, 2200}

// snapEdgeWidth is clampEdgeWidth(snapWidthToCommonSize(width)).
func snapEdgeWidth(width int) int {
	for _, size := range edgeWidthLadder {
		if size >= width {
			width = size
			break
		}
	}
	return min(width, 1800)
}

var edgeExtensions = map[string]string{"image": ".jpeg", "video": ".mp4", "audio": ".mp3"}

// EdgeURL is getEdgeUrl (src/client-utils/edge-url.ts) for options without a height.
func EdgeURL(location, src string, o EdgeOptions) string {
	if src == "" || strings.HasPrefix(src, "http") || strings.HasPrefix(src, "blob") {
		return src // isEdgeUrlPassthrough
	}
	original := o.Original
	if original == nil && o.Width == 0 {
		original = boolPtr(true) // no width, no height, original undefined
	}
	width := o.Width
	if original != nil && *original {
		width = 0
	}
	var params []string
	if o.Anim != nil && !*o.Anim {
		params = append(params, "anim=false") // `anim ? undefined : anim`
	}
	if o.Transcode {
		params = append(params, "transcode=true")
	}
	if width > 0 {
		params = append(params, "width="+strconv.Itoa(snapEdgeWidth(width)))
	}
	if original != nil {
		params = append(params, "original="+strconv.FormatBool(*original))
	}
	if o.Optimized != nil {
		params = append(params, "optimized="+strconv.FormatBool(*o.Optimized))
	}
	if o.Skip != nil {
		params = append(params, "skip="+superjson.FormatNumber(*o.Skip))
	}
	ext, ok := edgeExtensions[o.Type]
	if !ok {
		ext = edgeExtensions["image"]
	}
	name := src
	if o.Name != nil {
		name = *o.Name
	}
	name = strings.ReplaceAll(name, "%", "")
	if i := strings.LastIndex(name, "."); i >= 0 {
		name = name[:i] + ext
	} else {
		name += ext
	}
	parts := make([]string, 0, 4)
	for _, p := range []string{location, src, strings.Join(params, ","), name} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "/")
}

// stillURL is getStillUrl (src/server/utils/public-video-thumbnail.ts).
func stillURL(location, src string, o EdgeOptions) string {
	o.Original, o.Optimized = boolPtr(false), boolPtr(true)
	return strings.Replace(EdgeURL(location, src, o), "original=false,", "", 1)
}

// publicVideoThumbnail is getPublicVideoThumbnail.
func publicVideoThumbnail(r RawImage, h V1Hydrated, level int, location string) (any, error) {
	if r.Type != "video" {
		return nil, nil
	}
	allowed := level & browsing.AllLevels
	// servableThumbnails: only a servable custom thumbnail is used.
	if h.HasThumb && h.Thumb.Servable && h.Thumb.NsfwLevel != 0 && h.Thumb.NsfwLevel&allowed != 0 {
		src, ok := h.Thumb.URL.(string)
		if !ok {
			return nil, fallback.New("v1-thumbnail-url") // Node throws on a non-string url
		}
		return superjson.Object{
			{Key: "url", Val: stillURL(location, src, EdgeOptions{Type: "image", Anim: boolPtr(false)})},
			{Key: "width", Val: h.Thumb.Width},
			{Key: "height", Val: h.Thumb.Height},
		}, nil
	}
	if r.URL == nil || *r.URL == "" {
		return nil, fallback.New("v1-thumbnail-url")
	}
	return superjson.Object{
		{Key: "url", Val: stillURL(location, *r.URL, EdgeOptions{Type: "image", Anim: boolPtr(false), Transcode: true, Skip: SkipValue(r.Metadata)})},
		{Key: "width", Val: intOrNil(r.Width)},
		{Key: "height", Val: intOrNil(r.Height)},
	}, nil
}

// maxAnimationDurationSeconds is MAX_ANIMATION_DURATION_SECONDS.
const maxAnimationDurationSeconds = 30

// The member types of videoMetadataSchema (src/server/schema/media.schema.ts): "number", "string",
// "boolean"; a "?" suffix admits null too (nullish); height and width are required.
var videoMetadataFields = map[string]string{
	"height": "number", "width": "number", "hash": "string", "size": "number", "ruleId": "number",
	"ruleReason": "string", "remixSourceReviewed": "boolean", "profilePicture": "boolean",
	"coverImage": "boolean", "username": "string", "userId": "number", "nsfwLevelReason": "string?",
	"duration": "number", "audio": "boolean", "thumbnailFrame": "number?", "youtubeVideoId": "string",
	"youtubeUploadAttempt": "number", "youtubeUploadEnqueuedAt": "string", "vimeoVideoId": "string",
	"vimeoUploadAttempt": "number", "vimeoUploadEnqueuedAt": "string", "thumbnailId": "number",
	"parentId": "number",
}

// SkipValue is getSkipValue for a video (no thumbnailUrl): the frame to start a still from when the
// video is longer than an animation, else nil. Metadata that does not parse as videoMetadataSchema
// gives nil, as safeParse's failure does.
func SkipValue(metadata json.RawMessage) *float64 {
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(string(metadata)))
	dec.UseNumber()
	if len(metadata) == 0 || dec.Decode(&m) != nil || m == nil {
		return nil
	}
	for key, typ := range videoMetadataFields {
		v, present := m[key]
		required := key == "height" || key == "width"
		if !present {
			if required {
				return nil
			}
			continue
		}
		if v == nil {
			if strings.HasSuffix(typ, "?") {
				continue
			}
			return nil // optional() admits undefined, not null
		}
		switch strings.TrimSuffix(typ, "?") {
		case "number":
			if _, ok := v.(json.Number); !ok {
				return nil
			}
		case "string":
			if _, ok := v.(string); !ok {
				return nil
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return nil
			}
		}
	}
	d, ok := m["duration"].(json.Number)
	if !ok {
		return nil
	}
	duration, err := d.Float64()
	if err != nil || duration == 0 || duration <= maxAnimationDurationSeconds {
		return nil
	}
	frame := 4.0
	if f, ok := m["thumbnailFrame"].(json.Number); ok {
		if v, err := f.Float64(); err == nil {
			frame = v
		}
	}
	return &frame
}

// resolveImageModelIDs is resolveImageModelIds for a model, a version and posts: the named model, the
// version's model and each listed post's version's model (postId and postIds). ok is false when the named
// version or the postId cannot be found (Node: null — withheld, and held at nothing); a postIds entry the
// cache lacks is skipped.
func resolveImageModelIDs(ctx context.Context, s modelResolver, modelID, versionID, postID int, postIDs []int) ([]int, bool, error) {
	var listed []int
	if postID != 0 || len(postIDs) > 0 {
		// `new Set(postIds)` then the `postId`: every listed post's version counts; only a `postId` the
		// cache does not hold makes the selector unresolvable. (Unique drops a 0, which no post has.)
		ids := hydrate.Unique(append(append([]int(nil), postIDs...), postID))
		posts, err := s.PostVersions(ctx, ids)
		if err != nil {
			return nil, false, err
		}
		if postID != 0 {
			if _, found := posts[postID]; !found {
				return nil, false, nil
			}
		}
		for _, id := range ids {
			if v := posts[id]; v != 0 {
				listed = append(listed, v)
			}
		}
	}
	var required []int
	if versionID != 0 {
		required = append(required, versionID)
	}
	versionIDs := unionInts(listed, required)
	var modelIDs []int
	if modelID != 0 {
		modelIDs = append(modelIDs, modelID)
	}
	if len(versionIDs) > 0 {
		versions, err := s.VersionModels(ctx, versionIDs)
		if err != nil {
			return nil, false, err
		}
		for _, id := range required {
			if _, ok := versions[id]; !ok {
				return nil, false, nil
			}
		}
		for _, id := range versionIDs {
			if m, ok := versions[id]; ok {
				modelIDs = append(modelIDs, m)
			}
		}
	}
	return unionInts(nil, modelIDs), true, nil
}

// modelResolver is what resolveImageModelIDs reads: the post→version and version→model caches.
type modelResolver interface {
	PostVersions(ctx context.Context, postIDs []int) (map[int]int, error)
	VersionModels(ctx context.Context, versionIDs []int) (map[int]int, error)
}

// heldLevels is getShowcaseHeldLevels for models whose flags the caller did not read: each held
// model's gallery level. A held model whose settings carry no level falls back with unsetReason
// (Node's reading of an undefined level differs between its callers).
func heldLevels(ctx context.Context, g V1Gallery, modelIDs []int, unsetReason string) (map[int]int, error) {
	out := map[int]int{}
	ids := hydrate.Unique(modelIDs)
	if len(ids) == 0 {
		return out, nil
	}
	settings, err := g.SettingsMany(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		s := settings[id]
		if s == nil || s.SfwHeld == nil || !*s.SfwHeld {
			continue
		}
		if s.Level == nil {
			return nil, fallback.New(unsetReason)
		}
		out[id] = *s.Level
	}
	return out, nil
}

// postHold is a post's hold: the minor or SFW-only model its version belongs to, and that model's
// held gallery level.
type postHold struct{ modelID, level int }

// heldByPost is getHeldLevelsByPost (src/server/services/model.service.ts) without its owner read: each
// post (of postIDs) whose version's model is held, with that model's level. The post→version and
// version→model caches are read only for what the step before found; no version, no hold.
func heldByPost(ctx context.Context, s modelResolver, g V1Gallery, postIDs []int, unsetReason string) (map[int]postHold, error) {
	out := map[int]postHold{}
	postIDs = hydrate.Unique(postIDs)
	if len(postIDs) == 0 {
		return out, nil
	}
	posts, err := s.PostVersions(ctx, postIDs)
	if err != nil {
		return nil, err
	}
	var versionIDs []int
	for _, id := range postIDs {
		if v := posts[id]; v != 0 {
			versionIDs = append(versionIDs, v)
		}
	}
	versionIDs = hydrate.Unique(versionIDs)
	if len(versionIDs) == 0 {
		return out, nil
	}
	versions, err := s.VersionModels(ctx, versionIDs)
	if err != nil {
		return nil, err
	}
	var modelIDs []int
	for _, v := range versionIDs {
		if m, ok := versions[v]; ok {
			modelIDs = append(modelIDs, m)
		}
	}
	levels, err := heldLevels(ctx, g, modelIDs, unsetReason)
	if err != nil {
		return nil, err
	}
	for _, id := range postIDs {
		if v := posts[id]; v != 0 {
			if m, ok := versions[v]; ok {
				if l, held := levels[m]; held {
					out[id] = postHold{modelID: m, level: l}
				}
			}
		}
	}
	return out, nil
}

// withoutHeldImages leaves out the images above the held gallery level of their post's minor or
// SFW-only model (getHeldLevelsByPost without owners: no one is exempt on this route).
func withoutHeldImages(ctx context.Context, d *V1Deps, items []v1Item) ([]v1Item, error) {
	if len(items) == 0 {
		return items, nil
	}
	postIDs := make([]int, 0, len(items))
	for _, it := range items {
		postIDs = append(postIDs, it.postID)
	}
	holds, err := heldByPost(ctx, d.Sources, d.Gallery, postIDs, "v1-held-level-unset")
	if err != nil {
		return nil, err
	}
	if len(holds) == 0 {
		return items, nil
	}
	out := items[:0:0]
	for _, it := range items {
		if h, held := holds[it.postID]; held && h.level&it.browsingLevel == 0 {
			continue
		}
		out = append(out, it)
	}
	return out, nil
}

var v1PathRE = regexp.MustCompile(`^/api/v1/images/?$`)

// nextPageURL is getNextPage: the request's own URL with `page` (paging) or `cursor` set to the next
// page's, on https://<host> in production (else http://localhost:3000).
func nextPageURL(in *V1Input, host, path string, production, usingPaging bool, nextCursor string) (string, error) {
	if path == "" {
		path = "/api/v1/images"
	}
	if !v1PathRE.MatchString(path) {
		return "", fallback.New("v1-path")
	}
	origin := "http://localhost:3000"
	if production && host != "" {
		h := strings.ToLower(host)
		if !hostRE.MatchString(h) {
			return "", fallback.New("v1-host")
		}
		origin = "https://" + strings.TrimSuffix(h, ":443") // the WHATWG URL drops https's default port
	}
	params := in.Query
	if usingPaging {
		params = withParam(params, "page", strconv.Itoa(in.Page+1))
	} else {
		params = withParam(params, "cursor", nextCursor)
	}
	return origin + path + "?" + QSStringify(params), nil
}

var hostRE = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]{1,5})?$`)
