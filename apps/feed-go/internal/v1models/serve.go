package v1models

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
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
	// Host is the request's Host header (isRedCapableHost, for the Training Data listing).
	Host string
	// TrainingDataSQL is the hash of Node's Training Data statement the sample carried
	// (TrainingDataSQLHeader); "" = none.
	TrainingDataSQL string
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
		if body, age, ok := d.cachedDetail(ctx, id, level); ok && age >= NodeBuiltWindow {
			// withListableTrainingData runs after the cache, which keys on neither the host nor a
			// restriction placed since the entry was written.
			out, err := d.withListableTrainingData(ctx, body, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL})
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
		return &Answer{Body: superjson.Object{{Key: "error", Val: "No model with id " + strconv.Itoa(id)}}, Trivial: true}, nil
	}
	// buildPublicModelResponse lists every Public file (Training Data too, without its metadata); the
	// listing is applied to the built body as to a cached one.
	body, err := shapeModel(res.items[0], shapeOptions{
		level: level, detail: true, downloadBase: d.Config.BaseURL, imageLocation: d.Config.ImageLocation,
	})
	if err != nil {
		return nil, err
	}
	out, err := d.withListableTrainingData(ctx, body, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL})
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
	// TrainingDataSQL is the hash of Node's Training Data statement the sample carried
	// (TrainingDataSQLHeader); "" = none.
	TrainingDataSQL string
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

// ServeList answers `GET /api/v1/models` for a signed-out caller with no text query (the
// Meilisearch path is not ported).
func ServeList(ctx context.Context, d *Deps, users UsernameResolver, req ListRequest) (*Answer, error) {
	in, err := ParseList(req.Query)
	if err != nil {
		return nil, err
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
	res, err := d.getModelsWithVersions(ctx, withVersionsInput{
		raw: RawInput{
			Take: in.Limit, Cursor: in.Cursor, Archived: in.Archived, DisablePoi: true, TargetUserID: target,
			Types: in.Types, BaseModels: in.BaseModels, Sort: in.Sort, Period: in.Period, PeriodMode: in.PeriodMode,
			IDs: in.IDs, EarlyAccess: in.EarlyAccess, BrowsingLevel: level,
		},
		hidePrivate: in.IDs == nil && in.Username == "",
	})
	if err != nil {
		return nil, err
	}
	// runModelSearch's trainingDataListing over every item's versions (all their files, before the
	// shaper's own filters).
	versions := make([]superjson.Object, 0, len(res.items))
	for _, it := range res.items {
		versions = append(versions, it.versions...)
	}
	listing, err := d.trainingDataListing(ctx, versions, listingRequest{host: req.Host, sqlHash: req.TrainingDataSQL})
	if err != nil {
		return nil, err
	}
	opts := shapeOptions{
		level: level, downloadBase: origin, nsfwImagePassthrough: in.Nsfw && !req.RegionRestricted,
		primaryFileOnly: in.PrimaryFileOnly, imageLocation: d.Config.ImageLocation, listing: listing,
	}
	items := make([]any, 0, len(res.items))
	for _, it := range res.items {
		o, err := shapeModel(it, opts)
		if err != nil {
			return nil, err
		}
		items = append(items, o)
	}
	meta := superjson.Object{}
	if res.nextCursor != "" {
		meta = append(meta, superjson.Field{Key: "nextCursor", Val: res.nextCursor})
		params := feed.WithParam(in.Query, "cursor", res.nextCursor)
		meta = append(meta, superjson.Field{Key: "nextPage", Val: origin + path + "?" + feed.QSStringify(params)})
	}
	if in.Page > 0 && in.Cursor == "" {
		meta = append(meta, superjson.Field{Key: "currentPage", Val: int64(in.Page)}, superjson.Field{Key: "pageSize", Val: int64(in.Limit)})
	}
	return &Answer{
		Body:    superjson.Object{{Key: "items", Val: items}, {Key: "metadata", Val: meta}},
		Trivial: len(res.items) == 0,
	}, nil
}
