package v1models

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Answer is one computed REST body.
type Answer struct {
	Body superjson.Object
	// Trivial: no model was loaded (an empty page, a not-found id); kept apart in the CPU and match
	// series (DESIGN.md §13.6).
	Trivial bool
	// Cached: the `[id]` body came from the origin response cache, as Node's did (no build).
	Cached bool
	// NotFound: the `[id]` body is the not-found answer, which Node sends with a 404.
	NotFound bool
}

// NodeBuiltWindow is how recent an origin cache entry must be to count as the one Node built for the
// sampled request itself. Node builds on a miss and awaits the write before it answers; the sample
// is posted after the answer, its POST is cut at FEED_GO_SHADOW_TIMEOUT_MS (at most 10 s), and the
// comparison then runs from a bounded queue. So an entry Node wrote for this request is at most a
// few seconds old when it is read here, and 15 s covers the longest sample timeout with margin. Read
// as a hit, such an entry would be Node's own answer compared with itself (always `match_cached`);
// it is built instead, so the comparison measures the port. An entry older than this was served by
// Node from the cache as well, and is read (DESIGN.md §16.5).
const NodeBuiltWindow = 15 * time.Second

// DetailRequest is one `GET /api/v1/models/[id]`.
type DetailRequest struct {
	// ID is the path segment.
	ID string
	// RegionRestricted: the caller's region holds the level to PG/PG-13 (apiBrowsingLevel).
	RegionRestricted bool
	// Serving: a public request, not a shadow sample. Every fresh origin cache entry is read, as Node
	// reads it; a sample ignores one younger than NodeBuiltWindow.
	Serving bool
	// Host is the request's Host header (isRedCapableHost, for the Training Data listing).
	Host string
	// TrainingDataSQL is the Node Training Data rule-set id a sample carried (TrainingDataSQLHeader);
	// "" = none (always so on a public request, whose header is never read).
	TrainingDataSQL string
	// Rules, on a public request, vouches for this build's rules when the Node builds now answering
	// published exactly them; read only when the body has a Training Data candidate. With neither
	// vouching, a Training Data candidate falls back as drift.
	Rules *TrainingDataRules
}

// ServeDetail answers `GET /api/v1/models/[id]` (the PublicEndpoint path: no session is read).
func ServeDetail(ctx context.Context, d *Deps, req DetailRequest) (*Answer, error) {
	id, err := ParseID(req.ID)
	if err != nil {
		return nil, err
	}
	if d.Config.ImageLocation == "" || d.Config.BaseURL == "" {
		// The edge URLs and the download URLs would not be Node's.
		return nil, fallback.New("v1-models-unconfigured-urls")
	}
	level := browsing.AllLevels
	if req.RegionRestricted {
		level = browsing.SFWLevels
	}
	if d.Config.ResponseCacheTTL > 0 {
		if body, age, ok := d.cachedDetail(ctx, id, level); ok && (req.Serving || age >= NodeBuiltWindow) {
			// withListableTrainingData runs after the cache, which keys on neither the host nor a
			// restriction placed since the entry was written.
			out, err := d.withListableTrainingData(ctx, body, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL, rules: req.Rules})
			if err != nil {
				return nil, err
			}
			return &Answer{Body: out, Cached: true}, nil
		}
	}
	res, err := d.getModelsWithVersions(ctx, withVersionsInput{
		raw: RawInput{
			IDs: []int{id}, Sort: SortHighestRated, Archived: true, Period: "AllTime", PeriodMode: "published",
			BrowsingLevel: level,
		},
		ignoreAddons: true,
	})
	if err != nil {
		return nil, err
	}
	if len(res.items) == 0 {
		return &Answer{Body: superjson.Object{{Key: "error", Val: "No model with id " + strconv.Itoa(id)}}, Trivial: true, NotFound: true}, nil
	}
	// buildPublicModelResponse lists every Public file (Training Data too, without its metadata); the
	// listing is applied to the built body as to a cached one.
	body, err := shapeModel(res.items[0], shapeOptions{
		level: level, detail: true, downloadBase: d.Config.BaseURL, imageLocation: d.Config.ImageLocation,
	})
	if err != nil {
		return nil, err
	}
	out, err := d.withListableTrainingData(ctx, body, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL, rules: req.Rules})
	if err != nil {
		return nil, err
	}
	return &Answer{Body: out}, nil
}

// cachedDetail is fetchModelResponseCached's read: the packed `{ data, cachedAt }` entry, served when
// it is within the logical TTL, with its age. A miss, a stale or malformed entry, or a read failure
// builds.
func (d *Deps) cachedDetail(ctx context.Context, id, level int) (superjson.Object, time.Duration, bool) {
	if d.Packed == nil {
		return nil, 0, false
	}
	key := KeyPublicModelResponse + ":v2:" + strconv.Itoa(id) + ":" + strconv.Itoa(level)
	entry, ok := d.Packed.GetOrdered(ctx, key)
	if !ok {
		return nil, 0, false
	}
	data, ok := getVal(entry, "data").(superjson.Object)
	if !ok {
		return nil, 0, false
	}
	at, ok := numberOf(getVal(entry, "cachedAt"))
	if !ok {
		return nil, 0, false
	}
	ageMS := float64(d.now().UnixMilli()) - at
	if ageMS > float64(d.Config.ResponseCacheTTL/time.Millisecond) {
		return nil, 0, false
	}
	return data, time.Duration(ageMS) * time.Millisecond, true
}

// ListRequest is one `GET /api/v1/models`.
type ListRequest struct {
	// Query is the raw query string, Path the request path, Host its Host header.
	Query, Path, Host string
	// RegionRestricted: the caller's region holds the level to PG/PG-13.
	RegionRestricted bool
	// TrainingDataSQL and Rules vouch for the listing, as on DetailRequest.
	TrainingDataSQL string
	Rules           *TrainingDataRules
	// Serving: a public request, not a shadow sample. A text query is answered serving only with
	// Config.ServeQuery (FEED_GO_V1_MODELS_SERVE_QUERY); a sample is computed whenever a search
	// backend is configured (the Node sampler sends one only with FEED_GO_SHADOW_V1_MODELS_QUERY).
	Serving bool
}

// UsernameResolver is the `username` filter's user lookup on the replica.
type UsernameResolver interface {
	UserIDByUsername(ctx context.Context, username string) (int, bool, error)
}

var (
	listPathRE = regexp.MustCompile(`^/api/v1/models/?$`)
	hostRE     = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]{1,5})?$`)
)

// origin is getNextPage's baseUrl.origin: https://<host> in production (the WHATWG URL lowercases the
// host and drops https's default port), else http://localhost:3000.
func (d *Deps) origin(host string) (string, error) {
	if !d.Config.Production {
		return "http://localhost:3000", nil
	}
	h := strings.ToLower(host)
	if h == "" || !hostRE.MatchString(h) {
		return "", fallback.New("v1-models-host")
	}
	return "https://" + strings.TrimSuffix(h, ":443"), nil
}

// ServeList answers `GET /api/v1/models` for a signed-out caller. A truthy `query` is the text search
// (DESIGN.md §16.11): answered only with a search backend (Deps.Search) and, on a public request, with
// Config.ServeQuery; otherwise it falls back (`v1-models-query`).
func ServeList(ctx context.Context, d *Deps, users UsernameResolver, req ListRequest) (*Answer, error) {
	in, err := ParseList(req.Query)
	if err != nil {
		return nil, err
	}
	if in.Text != "" && (d.Search == nil || (req.Serving && !d.Config.ServeQuery)) {
		return nil, fallback.New("v1-models-query")
	}
	if d.Config.ImageLocation == "" {
		return nil, fallback.New("v1-models-unconfigured-urls")
	}
	path := req.Path
	if path == "" {
		path = "/api/v1/models"
	}
	if !listPathRE.MatchString(path) {
		return nil, fallback.New("v1-models-path")
	}
	origin, err := d.origin(req.Host)
	if err != nil {
		return nil, err
	}
	level := browsing.PublicLevels
	if in.Nsfw {
		level = browsing.AllLevels
	}
	if req.RegionRestricted {
		level = browsing.SFWLevels
	}
	// The text search runs before getModelsRaw (resolveModelSearchIds): its ids are the page, its
	// lookahead the cursor, whatever the statement then returns.
	var text *textPage
	if in.Text != "" {
		if text, err = d.searchPage(ctx, in, level); err != nil {
			return nil, err
		}
	}
	// enforceBlockedBrowsingTagsForModels, ahead of every lookup in getModelsRaw: a blocked tag name
	// is an empty page (`{ items: [] }`, no cursor but the text search's), with no statement and no
	// username read.
	blocked, err := d.tagBlocked(ctx, in.Tag)
	if err != nil {
		return nil, err
	}
	if blocked {
		return listAnswer(in, nil, text.cursorOr(""), origin, path), nil
	}
	target := 0
	if in.Username != "" {
		if users == nil {
			return nil, fallback.New("v1-models-username-miss")
		}
		id, ok, err := users.UserIDByUsername(ctx, in.Username)
		if err != nil {
			return nil, err
		}
		if !ok {
			// Node reads the primary next, then answers 404: neither is reached here.
			return nil, fallback.New("v1-models-username-miss")
		}
		target = id
	}
	// getModelsRaw's tag clause: `dbRead.tag.findUnique({ where: { name } })` (Tag.name is citext:
	// the name is passed as given, matched case-insensitively by the replica); a name no tag has adds
	// no clause.
	var tagID *int
	if in.Tag != "" {
		id, found, err := hydrate.TagIDByName(ctx, d.DB, in.Tag)
		if err != nil {
			return nil, err
		}
		if found {
			tagID = &id
		}
	}
	raw := RawInput{
		Take: in.Limit, Cursor: in.Cursor, Archived: in.Archived, DisablePoi: true, TargetUserID: target, TagID: tagID,
		Types: in.Types, BaseModels: in.BaseModels, Sort: in.Sort, Period: in.Period, PeriodMode: in.PeriodMode,
		IDs: in.IDs, EarlyAccess: in.EarlyAccess, BrowsingLevel: level,
	}
	if text != nil {
		if len(text.ids) == 0 {
			// No hit is no result (runModelSearch's noTextMatches): Node's statement then carries no
			// id clause and its rows are discarded, so it is not sent here.
			return listAnswer(in, nil, text.cursor, origin, path), nil
		}
		// `ids: searchIds`, no cursor and no skip: the search's offset is the page.
		raw.IDs, raw.Cursor = text.ids, ""
	}
	res, err := d.getModelsWithVersions(ctx, withVersionsInput{
		raw: raw,
		// hidePrivateModels is `!ids && !username`: the search's ids are an array, even empty.
		hidePrivate: raw.IDs == nil && in.Username == "",
	})
	if err != nil {
		return nil, err
	}
	items := res.items
	cursor := res.nextCursor
	if text != nil {
		// The search's order, not the statement's (getModelsWithVersions re-sorts): each hit the
		// statement returned, in hit order; a hit it did not return is left out.
		items = inSearchOrder(text.ids, items)
		cursor = text.cursor
	}
	// runModelSearch's trainingDataListing over every item's versions (all their files, before the
	// shaper's own filters).
	versions := make([]superjson.Object, 0, len(items))
	for _, it := range items {
		versions = append(versions, it.versions...)
	}
	listing, err := d.trainingDataListing(ctx, versions, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL, rules: req.Rules})
	if err != nil {
		return nil, err
	}
	opts := shapeOptions{
		level: level, downloadBase: origin, nsfwImagePassthrough: in.Nsfw && !req.RegionRestricted,
		primaryFileOnly: in.PrimaryFileOnly, imageLocation: d.Config.ImageLocation, listing: listing,
	}
	shaped := make([]any, 0, len(items))
	for _, it := range items {
		o, err := shapeModel(it, opts)
		if err != nil {
			return nil, err
		}
		shaped = append(shaped, o)
	}
	return listAnswer(in, shaped, cursor, origin, path), nil
}

// textPage is resolveModelSearchIds' answer: the page's ids in the index's order, and the next
// offset when the lookahead hit came back ("" = none).
type textPage struct {
	ids    []int
	cursor string
}

func (t *textPage) cursorOr(def string) string {
	if t == nil {
		return def
	}
	return t.cursor
}

// searchPage runs the request's text search. A failed search falls back
// (`v1-models-query-search-failed`): Node makes its own call and answers it (a 503 on a brownout). A
// search the guard rejected (ErrSearchRejected: the circuit open, the concurrency cap reached) was
// never made: it is handed back at once as an unanswered text query (`v1-models-query`), counted on
// its own by the guard's OnReject.
func (d *Deps) searchPage(ctx context.Context, in *ListInput, level int) (*textPage, error) {
	hits, err := d.Search.SearchModelIDs(ctx, searchRequest(in, level))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, ErrSearchRejected) {
			return nil, fallback.New("v1-models-query")
		}
		return nil, fallback.New("v1-models-query-search-failed")
	}
	page := &textPage{ids: hits}
	if len(hits) > in.Limit {
		page.ids = hits[:in.Limit]
		page.cursor = strconv.Itoa(in.TextOffset + in.Limit)
	}
	return page, nil
}

// inSearchOrder is `searchIds.map((id) => items.find((m) => m.id === id)).filter(isDefined)`.
func inSearchOrder(ids []int, items []*item) []*item {
	byID := make(map[int]*item, len(items))
	for _, it := range items {
		if id, ok := intOf(getVal(it.base, "id")); ok {
			if _, seen := byID[id]; !seen {
				byID[id] = it
			}
		}
	}
	out := make([]*item, 0, len(ids))
	for _, id := range ids {
		if it := byID[id]; it != nil {
			out = append(out, it)
		}
	}
	return out
}

// listAnswer is the handler's body: `{ items, metadata: { nextCursor, nextPage, currentPage?,
// pageSize? } }`, the undefined members left out. cursor is the next cursor ("" = none).
func listAnswer(in *ListInput, items []any, cursor, origin, path string) *Answer {
	if items == nil {
		items = []any{}
	}
	meta := superjson.Object{}
	if cursor != "" {
		meta = append(meta, superjson.Field{Key: "nextCursor", Val: cursor})
		params := feed.WithParam(in.Query, "cursor", cursor)
		meta = append(meta, superjson.Field{Key: "nextPage", Val: origin + path + "?" + feed.QSStringify(params)})
	}
	if in.Page > 0 && in.Cursor == "" {
		meta = append(meta, superjson.Field{Key: "currentPage", Val: int64(in.Page)}, superjson.Field{Key: "pageSize", Val: int64(in.Limit)})
	}
	return &Answer{
		Body:    superjson.Object{{Key: "items", Val: items}, {Key: "metadata", Val: meta}},
		Trivial: len(items) == 0,
	}
}

// tagBlocked is isBlockedTagName(tagname ?? tag, blocked names lowercased): the name, lowercased, is
// one of the blocked tags' names. An empty name is never blocked. The name is ASCII (ParseList); a
// blocked name that is not falls back, since Go's lowercasing of it is not always JS's.
func (d *Deps) tagBlocked(ctx context.Context, tag string) (bool, error) {
	if tag == "" {
		return false, nil
	}
	if d.Blocked == nil {
		return false, fallback.New("blocked-tags-unconfigured")
	}
	names, ascii, err := d.Blocked.NamesASCII(ctx)
	if err != nil {
		return false, err
	}
	if !ascii {
		return false, fallback.New("v1-models-tag")
	}
	return names[strings.ToLower(tag)], nil
}
