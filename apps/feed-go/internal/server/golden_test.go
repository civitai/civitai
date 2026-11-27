package server

// Golden tests: each fixture under testdata/golden is one request with everything feed-go reads
// for it (the feed service's replies, Redis values, Postgres rows) and the answer the NODE code
// path gives (see testdata/golden/README.md; the expectations come from gen.mjs, a transcription
// of the Node handlers, never from this service's output). A real *Server over testkit fakes
// computes the request, and the shadow comparator decides parity.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const (
	goldenDir = "../../testdata/golden"
	// The fixture counts gen.mjs writes: a glob that matches fewer fails, so a moved directory or a
	// renamed extension cannot pass as zero fixtures.
	goldenMinAsPosts  = 37
	goldenMinV1       = 52
	goldenMinInfinite = 164
	goldenMinModels   = 75
	goldenIssuer      = "https://auth.example.test"
	goldenCookieName  = "__Secure-civ-token"
)

// goldenHosts are the fixtures' synthetic domains (SERVER_DOMAIN_GREEN/BLUE/RED).
var goldenHosts = browsing.HostColors{
	"green": {"green.example.test"},
	"blue":  {"blue.example.test"},
	"red":   {"red.example.test"},
}

// goldenPrimaries is each color's SERVER_DOMAIN_<COLOR>: every fixture host is its color's primary.
var goldenPrimaries = map[string]string{"green": "green.example.test", "blue": "blue.example.test", "red": "red.example.test"}

// goldenTime is a timestamp written as {"$date": "<ISO>"}, or null.
type goldenTime struct{ T *time.Time }

func (g *goldenTime) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var m struct {
		Date string `json:"$date"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	t, err := time.Parse(time.RFC3339Nano, m.Date)
	if err != nil {
		return err
	}
	g.T = &t
	return nil
}

type goldenFixture struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Now         time.Time `json:"now"`
	Config      struct {
		ImageIndexFeed    bool     `json:"imageIndexFeed"`
		LazyPostImages    bool     `json:"lazyPostImages"`
		CreatorPromotions string   `json:"creatorPromotions"`
		DecorationEvents  []string `json:"decorationEvents"`
		ImageLocation     string   `json:"imageLocation"`
		// model.getAll's flag mirrors (model-getall/ fixtures).
		BaseModelMetrics bool `json:"baseModelMetrics"`
		ModelImagesSlim  bool `json:"modelImagesSlim"`
		CoverageNext     bool `json:"coverageNext"`
		LoadingOpenToAll bool `json:"loadingOpenToAll"`
		// FrameCacheNegative is the frame-cache-negative flag the fixture's Node run had.
		FrameCacheNegative bool `json:"frameCacheNegative"`
		// ComputeMissesOff runs the model harness with FEED_GO_COMPUTE_MISSES off (a fixture of a
		// fallback only that state still has).
		ComputeMissesOff bool `json:"computeMissesOff"`
		// ServeSortRandom is FEED_GO_INFINITE_SERVE_SORT_RANDOM (feed.InfinitePorts.SortRandom; absent:
		// off, a collection's Random sort falls back).
		ServeSortRandom bool `json:"serveSortRandom"`
		// ServeGallerySettingsMiss is FEED_GO_INFINITE_SERVE_GALLERY_SETTINGS_MISS (infinite/
		// fixtures; absent: off, a gallery-settings miss falls back).
		ServeGallerySettingsMiss bool `json:"serveGallerySettingsMiss"`
		// ServeInputIDs / ServeInputFollowed are the model.getAll input ports' switches
		// (FEED_GO_GETALL_SERVE_INPUT_IDS / _FOLLOWED; absent: off, the fixture's shape falls back).
		ServeInputIDs      bool `json:"serveInputIds"`
		ServeInputFollowed bool `json:"serveInputFollowed"`
		// ServeHidePaid is FEED_GO_GETALL_SERVE_HIDE_PAID (absent: off, Hide Paid falls back).
		ServeHidePaid bool `json:"serveHidePaid"`
		// ServeVerifiedBot, ServeInputNewCreators and ServePublishedRange are
		// FEED_GO_GETALL_SERVE_VERIFIED_BOT, FEED_GO_GETALL_SERVE_INPUT_NEW_CREATORS and
		// FEED_GO_GETALL_SERVE_INPUT_PUBLISHED_RANGE (model-getall/; absent: off, a verified-crawler
		// header, `newCreators` or a published range falls back).
		ServeVerifiedBot      bool `json:"serveVerifiedBot"`
		ServeInputNewCreators bool `json:"serveInputNewCreators"`
		ServePublishedRange   bool `json:"servePublishedRange"`
		// ServeUserCosmeticsMiss is FEED_GO_GETALL_SERVE_USER_COSMETICS_MISS (model-getall/; absent:
		// off, an owner's user-cosmetics miss falls back).
		ServeUserCosmeticsMiss bool `json:"serveUserCosmeticsMiss"`
		// ServeMembershipMiss is FEED_GO_GETALL_SERVE_MEMBERSHIP_MISS (model-getall/; absent: off, an
		// owner's creator-membership miss falls back).
		ServeMembershipMiss bool `json:"serveMembershipMiss"`
		// ServePublishedOnly is FEED_GO_INFINITE_SERVE_INPUT_PUBLISHED_ONLY (infinite/ fixtures; absent:
		// off, the fixture's `publishedOnly` falls back).
		ServePublishedOnly bool `json:"servePublishedOnly"`
		// ServePostIDs is FEED_GO_INFINITE_SERVE_INPUT_POST_IDS (infinite/ fixtures; absent: off, the
		// fixture's `postIds` falls back).
		ServePostIDs bool `json:"servePostIds"`
		// ServeHubID is FEED_GO_INFINITE_SERVE_INPUT_HUB_ID (infinite/ fixtures; absent: off, the
		// fixture's `hubId` falls back).
		ServeHubID bool `json:"serveHubId"`
		// ServeJudgeScore / ServeHatTurfIgnored are FEED_GO_INFINITE_SERVE_JUDGE_SCORE /
		// _HAT_TURF_IGNORED (infinite/ fixtures; absent: off, a judged item / a hat key falls back).
		ServeJudgeScore     bool `json:"serveJudgeScore"`
		ServeHatTurfIgnored bool `json:"serveHatTurfIgnored"`
		// ServeV1ImageID / ServeV1ModelOnly are FEED_GO_V1_IMAGES_SERVE_IMAGE_ID / _MODEL_ONLY
		// (v1-images/ fixtures; absent: off, the fixture's `imageId` / model without a version falls back).
		ServeV1ImageID   bool `json:"serveV1ImageId"`
		ServeV1ModelOnly bool `json:"serveV1ModelOnly"`
		// UserHubs is what the `user-hubs` flag reads for the fixture's viewer (Server.UserHubs): "on",
		// "off" or "error" (a failed read); absent: no flag reader configured.
		UserHubs string `json:"userHubs"`
	} `json:"config"`
	Request struct {
		Input   string            `json:"input"`
		Query   string            `json:"query"`
		Path    string            `json:"path"`
		Headers map[string]string `json:"headers"`
		Session *struct {
			UserID int `json:"userId"`
		} `json:"session"`
	} `json:"request"`
	Feed     []goldenFeedReply           `json:"feed"`
	Redis    map[string]goldenRedisEntry `json:"redis"`
	SysRedis map[string]goldenRedisEntry `json:"sysRedis"`
	DB       goldenDB                    `json:"db"`
	Expect   struct {
		Fallback  string          `json:"fallback"`
		Envelope  json.RawMessage `json:"envelope"`
		Cacheable *bool           `json:"cacheable"`
		// ViewerClass is the viewer class a model-getall fixture sending headers is counted under
		// (FeedViewerClasses: `crawler` for a verified crawler); "" = derived from the session.
		ViewerClass string          `json:"viewerClass"`
		Body        json.RawMessage `json:"body"`
		// Writes is every cache key Node's fetches write for the request's misses (a served
		// fixture; none when the caches are warm): a packed value, with its expiry.
		Writes map[string]goldenWrite `json:"writes"`
	} `json:"expect"`
}

// goldenWrite is one cache write Node makes on a miss.
type goldenWrite struct {
	Packed string `json:"packed"`
	EX     int    `json:"ex"`
}

type goldenFeedReply struct {
	Query  string          `json:"query"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// goldenRedisEntry is one key: a msgpack value (base64 of msgpackr's bytes), a raw string, or a hash.
type goldenRedisEntry struct {
	Packed string            `json:"packed"`
	Raw    *string           `json:"raw"`
	Hash   map[string]string `json:"hash"`
}

type goldenImage struct {
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
	CreatedAt         goldenTime      `json:"createdAt"`
	SortAt            goldenTime      `json:"sortAt"`
	MimeType          *string         `json:"mimeType"`
	Type              string          `json:"type"`
	Metadata          json.RawMessage `json:"metadata"`
	Ingestion         string          `json:"ingestion"`
	BlockedFor        *string         `json:"blockedFor"`
	ScannedAt         goldenTime      `json:"scannedAt"`
	NeedsReview       *string         `json:"needsReview"`
	UserID            int             `json:"userId"`
	PostID            int             `json:"postId"`
	PostTitle         *string         `json:"postTitle"`
	Index             *int            `json:"index"`
	PublishedAt       goldenTime      `json:"publishedAt"`
	UnpublishedAt     *string         `json:"unpublishedAt"`
	ModelVersionID    *int            `json:"modelVersionId"`
	Model3DID         *int            `json:"model3dId"`
	Availability      string          `json:"availability"`
	Minor             bool            `json:"minor"`
	Poi               bool            `json:"poi"`
	AcceptableMinor   bool            `json:"acceptableMinor"`
	Restricted        bool            `json:"restricted"`
	// Resources are the image's ImageResourceNew rows.
	Resources []struct {
		ModelVersionID int  `json:"modelVersionId"`
		Detected       bool `json:"detected"`
	} `json:"_resources"`
	// Tags are the image's TagsOnImageDetails tag ids (infinite/ fixtures, and a fixture whose query
	// filters by `tags`: the tag scope).
	Tags []int `json:"_tags"`
	// Tools are the image's ImageTool tool ids (only in a fixture whose query filters by `tools`).
	Tools []int `json:"_tools"`
	// Techniques are the image's ImageTechnique ids (only in a fixture whose query filters by
	// `techniques`).
	Techniques []int `json:"_techniques"`
	// Meta is the image's `meta` jsonb as Postgres prints it (v1-images/ fixtures only: the
	// image-meta cache's lookup); null when NULL.
	Meta *string `json:"_meta"`
}

// goldenImageColumns is the getAllImages SELECT list, in the order scanRows scans it.
var goldenImageColumns = []string{
	"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hideMeta", "hasMeta", "hasPositivePrompt",
	"onSite", "remixOfId", "createdAt", "sortAt", "mimeType", "type", "metadata", "ingestion", "blockedFor",
	"scannedAt", "needsReview", "userId", "postId", "postTitle", "index", "publishedAt", "unpublishedAt",
	"modelVersionId", "model3dId", "availability", "minor", "poi", "acceptableMinor", "restricted", "cursorId",
}

func goldenPtr[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func goldenTimeVal(t goldenTime) any {
	if t.T == nil {
		return nil
	}
	return *t.T
}

// goldenJSONTypeText is jsonb_typeof and `->>` of a JSON value: nil, nil for none (SQL NULL), else its
// type and its text (a string unquoted).
func goldenJSONTypeText(r json.RawMessage) (any, any) {
	if len(r) == 0 || string(r) == "null" {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(r, &v); err != nil {
		return nil, nil
	}
	switch t := v.(type) {
	case string:
		return "string", t
	case float64:
		return "number", string(r)
	case bool:
		return "boolean", string(r)
	case []any:
		return "array", string(r)
	}
	return "object", string(r)
}

func goldenJSONVal(r json.RawMessage) any {
	if len(r) == 0 || string(r) == "null" {
		return nil
	}
	return string(r)
}

// row is the image as the getAllImages SELECT returns it; cursor is its cursor column (the id, or a
// post-scoped query's index).
func (g goldenImage) row(cursor any) []any {
	return []any{
		g.ID, goldenPtr(g.Name), goldenPtr(g.URL), g.NsfwLevel, goldenPtr(g.Width), goldenPtr(g.Height),
		goldenPtr(g.Hash), g.HideMeta, g.HasMeta, g.HasPositivePrompt, goldenPtr(g.OnSite),
		goldenJSONVal(g.RemixOfID), goldenTimeVal(g.CreatedAt), goldenTimeVal(g.SortAt), goldenPtr(g.MimeType),
		g.Type, goldenJSONVal(g.Metadata), g.Ingestion, goldenPtr(g.BlockedFor), goldenTimeVal(g.ScannedAt),
		goldenPtr(g.NeedsReview), g.UserID, g.PostID, goldenPtr(g.PostTitle), goldenPtr(g.Index),
		goldenTimeVal(g.PublishedAt), goldenPtr(g.UnpublishedAt), goldenPtr(g.ModelVersionID),
		goldenPtr(g.Model3DID), g.Availability, g.Minor, g.Poi, g.AcceptableMinor, g.Restricted, cursor,
	}
}

type goldenDB struct {
	Images []goldenImage `json:"images"`
	Posts  []struct {
		ID             int  `json:"id"`
		ModelVersionID *int `json:"modelVersionId"`
	} `json:"posts"`
	ModelVersions []struct {
		ID      int `json:"id"`
		ModelID int `json:"modelId"`
		// BaseModel is the version's `baseModel` (only in a fixture whose query filters by `baseModels`).
		BaseModel string `json:"baseModel"`
	} `json:"modelVersions"`
	// Hubs are the UserHub rows (with their UserHubSource rows) a `hubId` fixture's request reads.
	Hubs   []goldenHub `json:"hubs"`
	Models []struct {
		ID           int             `json:"id"`
		UserID       int             `json:"userId"`
		Mode         *string         `json:"mode"`
		Minor        bool            `json:"minor"`
		SfwOnly      bool            `json:"sfwOnly"`
		GalleryLevel json.RawMessage `json:"galleryLevel"`
	} `json:"models"`
	Reviews []struct {
		ID             int     `json:"id"`
		UserID         int     `json:"userId"`
		ModelID        int     `json:"modelId"`
		ModelVersionID int     `json:"modelVersionId"`
		Rating         int     `json:"rating"`
		Details        *string `json:"details"`
		Recommended    bool    `json:"recommended"`
		PostID         *int    `json:"postId"`
	} `json:"reviews"`
	Reactions []struct {
		ImageID  int    `json:"imageId"`
		UserID   int    `json:"userId"`
		Reaction string `json:"reaction"`
	} `json:"reactions"`
	// SystemPosts are the system user's (-1) posts on each version Node looked one up for
	// (getAllImages' hasSystemPosts; an infinite/ fixture of `prioritizedUserIds: [-1]`).
	SystemPosts []struct {
		ID             int `json:"id"`
		ModelVersionID int `json:"modelVersionId"`
	} `json:"systemPosts"`
	// TagVotes are TagsOnImageVote rows (an infinite/ fixture whose signed-in request has the 'tags'
	// include: the votes the handler merges).
	TagVotes []struct {
		ImageID int `json:"imageId"`
		TagID   int `json:"tagId"`
		UserID  int `json:"userId"`
		Vote    int `json:"vote"`
	} `json:"tagVotes"`
	Placements []struct {
		ID         int             `json:"id"`
		Surface    string          `json:"surface"`
		TargetType string          `json:"targetType"`
		TargetID   int             `json:"targetId"`
		Status     string          `json:"status"`
		ResolvedAt goldenTime      `json:"resolvedAt"`
		Data       json.RawMessage `json:"data"`
	} `json:"placements"`
	Users []struct {
		ID        int        `json:"id"`
		Username  *string    `json:"username"`
		Image     *string    `json:"image"`
		DeletedAt goldenTime `json:"deletedAt"`
	} `json:"users"`

	// model-getall/ fixtures: the page query's answer per call, in order, with the cursor Node sent
	// for it; the paid-access gates, cover lookups, tags by name, creators by name and collections
	// Node read.
	ModelPages []struct {
		Cursor *string `json:"cursor"`
		// Bound is what Node's parseCursor binds for Cursor: a {"$date"} instant or an integer per token.
		Bound []json.RawMessage `json:"bound"`
		Rows  []goldenModelRow  `json:"rows"`
		// Collection is what Node binds into the page's CollectionItem semi-join (absent: no
		// collection filter): the collection, the viewer whose in-review items it keeps (null signed
		// out) and the collection tag (null: none).
		Collection *goldenCollectionFilter `json:"collection"`
		// OnlyModelIDs / ExcludeModelIDs are the official pin's id filters Node binds into the page
		// (absent: none), `mm."modelId" IN (…)` and `NOT IN (…)`.
		OnlyModelIDs    []int `json:"onlyModelIds"`
		ExcludeModelIDs []int `json:"excludeModelIds"`
		// IDs is a non-empty `ids` list Node binds into the page (`mm."modelId" IN (…)`; absent: none).
		IDs []int `json:"ids"`
		// FollowedUserIDs is the follow list Node binds for a signed-in `followed`
		// (`mm."userId" IN (…)`; absent: none), FollowedNone its `1 = 0` for a viewer who follows no one.
		FollowedUserIDs []int `json:"followedUserIds"`
		FollowedNone    bool  `json:"followedNone"`
		// NewCreatorUserIDs is the "new & upcoming" board Node binds for `newCreators`
		// (`mm."userId" IN (…)`; absent: none), NewCreatorsNone its `1 = 0` for an empty board.
		NewCreatorUserIDs []int `json:"newCreatorUserIds"`
		NewCreatorsNone   bool  `json:"newCreatorsNone"`
		// Published is a published range's bounds Node binds (`m."publishedAt" >= gte` and `< lt`, and
		// the same pair in the `ranged` CTE; absent: none).
		Published *struct {
			Gte goldenTime `json:"gte"`
			Lt  goldenTime `json:"lt"`
		} `json:"published"`
	} `json:"modelPages"`
	// UserFollows are the Follow rows of UserEngagement (userId, targetUserId) a model-getall fixture's
	// `followed` read, and FollowsRead how many times Node read them (once per getModelsRaw call).
	UserFollows []struct {
		UserID       int `json:"userId"`
		TargetUserID int `json:"targetUserId"`
	} `json:"userFollows"`
	FollowsRead int `json:"followsRead"`
	// ModelDataVersions, ModelHashes and TagsOnModels are what dataForModelsCache's and modelTagCache's
	// lookups read for a fixture's cold keys (the version rows with their modelId, the SHA256 model
	// hashes, the TagsOnModels rows), in the order the queries returned them.
	ModelDataVersions []goldenModelVersionRow `json:"modelDataVersions"`
	ModelHashes       []struct {
		ModelID int    `json:"modelId"`
		Hash    string `json:"hash"`
	} `json:"modelHashes"`
	TagsOnModels []struct {
		ModelID int `json:"modelId"`
		TagID   int `json:"tagId"`
	} `json:"tagsOnModels"`
	// Subscriptions are the CustomerSubscription rows (with their product's metadata, both as JSON
	// text) getValidCreatorMembershipMap's origin read for a model-getall fixture's cold membership
	// keys, after its status filter.
	Subscriptions []struct {
		UserID          int    `json:"userId"`
		Metadata        string `json:"metadata"`
		ProductMetadata string `json:"productMetadata"`
	} `json:"subscriptions"`
	// OfficialModels are the official, published models getOfficialModelIds' fetchFn reads (a fixture
	// whose request reads the official-models entry).
	OfficialModels []struct {
		ID   int    `json:"id"`
		Type string `json:"type"`
	} `json:"officialModels"`
	// CollectionItems are CollectionItem rows (an infinite/ fixture whose request names a collection:
	// every item of it, whatever its status or tag).
	CollectionItems []goldenCollectionItem `json:"collectionItems"`
	// Collections are the Collection rows Node's permission read found, each with the contributor
	// rows it holds.
	Collections []struct {
		ID           int    `json:"id"`
		Read         string `json:"read"`
		UserID       int    `json:"userId"`
		Contributors []struct {
			UserID      int      `json:"userId"`
			Permissions []string `json:"permissions"`
		} `json:"contributors"`
	} `json:"collections"`
	PaidAccess []struct {
		ModelID    int        `json:"modelId"`
		Deadline   goldenTime `json:"deadline"`
		VersionIDs []int      `json:"versionIds"`
	} `json:"paidAccess"`
	CoverImages []struct {
		ID             int `json:"id"`
		UserID         int `json:"userId"`
		ModelVersionID int `json:"modelVersionId"`
		ModelID        int `json:"modelId"`
	} `json:"coverImages"`
	Tags []struct {
		Name string `json:"name"`
		ID   int    `json:"id"`
	} `json:"tags"`
	Creators []struct {
		Username string `json:"username"`
		ID       int    `json:"id"`
	} `json:"creators"`
	// UserCosmetics are UserCosmetic rows, `data` as Postgres prints the jsonb (null when NULL).
	UserCosmetics []struct {
		UserID         int     `json:"userId"`
		CosmeticID     int     `json:"cosmeticId"`
		Data           *string `json:"data"`
		Equipped       bool    `json:"equippedAt"` // equippedAt IS NOT NULL
		EquippedToID   *int    `json:"equippedToId"`
		EquippedToType *string `json:"equippedToType"`
	} `json:"userCosmetics"`
	Cosmetics []struct {
		ID          int    `json:"id"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		Source      string `json:"source"`
		Data        string `json:"data"`
		Flags       int    `json:"flags"`
		CreatedByID *int   `json:"createdById"`
	} `json:"cosmetics"`
	CosmeticShopItems []struct {
		CosmeticID      int     `json:"cosmeticId"`
		AddedByID       *int    `json:"addedById"`
		Status          string  `json:"status"`
		Meta            string  `json:"meta"`
		RejectionReason *string `json:"rejectionReason"`
	} `json:"cosmeticShopItems"`
}

// goldenHub is one UserHub row and its UserHubSource rows.
type goldenHub struct {
	ID                  int    `json:"id"`
	UserID              int    `json:"userId"`
	Availability        string `json:"availability"`
	ForcedBrowsingLevel int    `json:"forcedBrowsingLevel"`
	Sources             []struct {
		ID       int    `json:"id"`
		Type     string `json:"type"`
		TargetID int    `json:"targetId"`
		Enabled  bool   `json:"enabled"`
		Exclude  bool   `json:"exclude"`
		GroupKey *int   `json:"groupKey"`
	} `json:"sources"`
}

// goldenHubRoutes answer the hub resolution's reads (feed.GalleryStore's HubReader) from the
// fixture's tables: the hub row under hubViewerWhere (the visibility clause asserted to be the one
// for the viewer the request carries), its enabled sources in id order, the per-model version ranking,
// an excluded model's versions, and the taken-down models among a hub's versions.
func goldenHubRoutes(fx *goldenFixture) []testkit.Route {
	db := &fx.DB
	return []testkit.Route{
		{Match: `FROM "UserHub" h`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			cols := []string{"forcedBrowsingLevel"}
			public := strings.Contains(sql, `h.availability = 'Public'`)
			owner := strings.Contains(sql, `h."userId" = $2`)
			if owner && len(args) != 2 || !owner && len(args) != 1 || owner && !public {
				return nil, fmt.Errorf("golden: an unexpected hub visibility clause (%d args): %s", len(args), sql)
			}
			for _, h := range db.Hubs {
				if h.ID != goldenInt(args[0]) {
					continue
				}
				if public && h.Availability != "Public" && (!owner || h.UserID != goldenInt(args[1])) {
					break
				}
				return testkit.NewRows(cols, []any{h.ForcedBrowsingLevel}), nil
			}
			return testkit.NewRows(cols), nil
		}},
		{Match: `FROM "UserHubSource" s`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, h := range db.Hubs {
				if h.ID != goldenInt(args[0]) {
					continue
				}
				srcs := slices.Clone(h.Sources)
				sort.Slice(srcs, func(a, b int) bool { return srcs[a].ID < srcs[b].ID })
				for _, src := range srcs {
					if src.Enabled {
						rows = append(rows, []any{src.Type, src.TargetID, src.Exclude, goldenPtr(src.GroupKey)})
					}
				}
			}
			return testkit.NewRows([]string{"type", "targetId", "exclude", "groupKey"}, rows...), nil
		}},
		{Match: `ROW_NUMBER() OVER (PARTITION BY mv."modelId" ORDER BY mv.id DESC)`, Rows: func(args []any) (*testkit.Rows, error) {
			byModel := map[int][]int{}
			for _, v := range db.ModelVersions {
				if goldenHas(goldenInts(args[0]), v.ModelID) {
					byModel[v.ModelID] = append(byModel[v.ModelID], v.ID)
				}
			}
			type ranked struct{ id, model, rn int }
			var list []ranked
			for m, ids := range byModel {
				sort.Sort(sort.Reverse(sort.IntSlice(ids)))
				for i, id := range ids {
					if i+1 <= goldenInt(args[1]) {
						list = append(list, ranked{id, m, i + 1})
					}
				}
			}
			sort.Slice(list, func(a, b int) bool { return list[a].id > list[b].id })
			rows := make([][]any, 0, len(list))
			for _, r := range list {
				rows = append(rows, []any{r.id, r.model, int64(r.rn)})
			}
			return testkit.NewRows([]string{"id", "modelId", "rn"}, rows...), nil
		}},
		{Match: `SELECT id FROM "ModelVersion" WHERE "modelId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var ids []int
			for _, v := range db.ModelVersions {
				if goldenHas(goldenInts(args[0]), v.ModelID) {
					ids = append(ids, v.ID)
				}
			}
			sort.Ints(ids)
			rows := make([][]any, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, []any{id})
			}
			return testkit.NewRows([]string{"id"}, rows...), nil
		}},
		{Match: `SELECT id, "userId", mode::text FROM "Model"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, m := range db.Models {
				if goldenHas(goldenInts(args[0]), m.ID) {
					rows = append(rows, []any{m.ID, m.UserID, goldenPtr(m.Mode)})
				}
			}
			return testkit.NewRows([]string{"id", "userId", "mode"}, rows...), nil
		}},
	}
}

// goldenUserHubs is the `user-hubs` flag as a fixture's config states it (nil: no reader).
type goldenUserHubs string

func (g goldenUserHubs) Enabled(context.Context, string, map[string]string) (bool, error) {
	if g == "error" {
		return false, errors.New("golden: the user-hubs flag read failed")
	}
	return g == "on", nil
}

// goldenCollectionItem is one CollectionItem row.
type goldenCollectionItem struct {
	ID           int     `json:"id"`
	CollectionID int     `json:"collectionId"`
	ImageID      int     `json:"imageId"`
	Status       string  `json:"status"`
	AddedByID    *int    `json:"addedById"`
	Note         *string `json:"note"`
	TagID        *int    `json:"tagId"`
	// SortKeys is the item's Random sort key by seed, as Postgres computes it
	// (`abs(mod(hashtext(concat(<id>::text, '<seed>')), 1000000000))`; a Random fixture only).
	SortKeys map[string]int `json:"sortKeys"`
}

// goldenModelRow is one row of model.getAll's page query (getModelsRaw's SELECT).
type goldenModelRow struct {
	ID              int             `json:"id"`
	Name            string          `json:"name"`
	SfwName         *string         `json:"sfwName"`
	CoverImageID    *int            `json:"coverImageId"`
	SfwCoverImageID *int            `json:"sfwCoverImageId"`
	Type            string          `json:"type"`
	Minor           bool            `json:"minor"`
	SfwOnly         bool            `json:"sfwOnly"`
	Poi             bool            `json:"poi"`
	Nsfw            bool            `json:"nsfw"`
	NsfwLevel       int             `json:"nsfwLevel"`
	Status          string          `json:"status"`
	CreatedAt       goldenTime      `json:"createdAt"`
	LastVersionAt   goldenTime      `json:"lastVersionAt"`
	PublishedAt     goldenTime      `json:"publishedAt"`
	Locked          bool            `json:"locked"`
	Meta            json.RawMessage `json:"meta"`
	Mode            *string         `json:"mode"`
	Availability    string          `json:"availability"`
	Rank            json.RawMessage `json:"rank"`
	UserID          int             `json:"userId"`
	CursorID        string          `json:"cursorId"`
}

// goldenModelVersionRow is one row of dataForModelsCache's versions query.
type goldenModelVersionRow struct {
	ModelID              int        `json:"modelId"`
	ID                   int        `json:"id"`
	Index                *int       `json:"index"`
	Name                 string     `json:"name"`
	EarlyAccessTimeFrame int        `json:"earlyAccessTimeFrame"`
	BaseModel            string     `json:"baseModel"`
	BaseModelType        *string    `json:"baseModelType"`
	CreatedAt            goldenTime `json:"createdAt"`
	TrainingStatus       *string    `json:"trainingStatus"`
	PublishedAt          goldenTime `json:"publishedAt"`
	Status               string     `json:"status"`
	Flags                int        `json:"flags"`
	Availability         string     `json:"availability"`
	NsfwLevel            int        `json:"nsfwLevel"`
	Description          *string    `json:"description"`
	TrainedWords         []string   `json:"trainedWords"`
	VaeID                *int       `json:"vaeId"`
	Covered              bool       `json:"covered"`
	CoveredNext          bool       `json:"coveredNext"`
}

var goldenModelVersionColumns = []string{"id", "index", "modelId", "name", "earlyAccessTimeFrame", "baseModel",
	"baseModelType", "createdAt", "trainingStatus", "publishedAt", "status", "flags", "availability", "nsfwLevel",
	"description", "trainedWords", "vaeId", "covered", "coveredNext"}

// row is the version row (int4 as int64, text[] as []any).
func (g goldenModelVersionRow) row() []any {
	var index any
	if g.Index != nil {
		index = int64(*g.Index)
	}
	var vae any
	if g.VaeID != nil {
		vae = int64(*g.VaeID)
	}
	words := make([]any, len(g.TrainedWords))
	for i, w := range g.TrainedWords {
		words[i] = w
	}
	return []any{int64(g.ID), index, int64(g.ModelID), g.Name, int64(g.EarlyAccessTimeFrame), g.BaseModel,
		goldenPtr(g.BaseModelType), goldenTimeVal(g.CreatedAt), goldenPtr(g.TrainingStatus), goldenTimeVal(g.PublishedAt),
		g.Status, int64(g.Flags), g.Availability, int64(g.NsfwLevel), goldenPtr(g.Description), words, vae, g.Covered,
		g.CoveredNext}
}

var goldenModelColumns = []string{"id", "name", "sfwName", "coverImageId", "sfwCoverImageId", "type", "minor", "sfwOnly",
	"poi", "nsfw", "nsfwLevel", "status", "createdAt", "lastVersionAt", "publishedAt", "locked", "meta", "mode",
	"availability", "rank", "userId", "cursorId"}

func (g goldenModelRow) row() []any {
	return []any{g.ID, g.Name, goldenPtr(g.SfwName), goldenPtr(g.CoverImageID), goldenPtr(g.SfwCoverImageID), g.Type,
		g.Minor, g.SfwOnly, g.Poi, g.Nsfw, g.NsfwLevel, g.Status, goldenTimeVal(g.CreatedAt), goldenTimeVal(g.LastVersionAt),
		goldenTimeVal(g.PublishedAt), g.Locked, goldenJSONVal(g.Meta), goldenPtr(g.Mode), g.Availability, string(g.Rank),
		g.UserID, g.CursorID}
}

// goldenCosmeticEvent reports whether the cosmetic's data has a string `event` (the frame and event
// lookups' `jsonb_typeof(c.data->'event') = 'string'`).
func goldenCosmeticEvent(db *goldenDB, id int) bool {
	for _, c := range db.Cosmetics {
		if c.ID == id {
			var d map[string]any
			_ = json.Unmarshal([]byte(c.Data), &d)
			_, ok := d["event"].(string)
			return ok
		}
	}
	return false
}

func goldenCosmeticCreator(db *goldenDB, id int) any {
	for _, c := range db.Cosmetics {
		if c.ID == id {
			return goldenPtr(c.CreatedByID)
		}
	}
	return nil
}

// goldenReEntity is the CosmeticEntity literal of a frame or event lookup.
var goldenReEntity = regexp.MustCompile(`uc\."equippedToType" = '(\w+)'::"CosmeticEntity"`)

// goldenEntityCosmetics answers the frame (event false) and event (event true) lookups: the rows on
// one of the ids, equipped to the lookup's entity (an Image, or a Model for model.getAll's frames),
// in table order.
func goldenEntityCosmetics(db *goldenDB, sql string, args []any, event bool, cols []string) (*testkit.Rows, error) {
	m := goldenReEntity.FindStringSubmatch(sql)
	if m == nil {
		return nil, errors.New("golden: an entity lookup without its entity")
	}
	var rows [][]any
	for _, r := range db.UserCosmetics {
		if r.EquippedToID == nil || !goldenHas(goldenInts(args[0]), *r.EquippedToID) || r.EquippedToType == nil ||
			*r.EquippedToType != m[1] || goldenCosmeticEvent(db, r.CosmeticID) != event {
			continue
		}
		if event {
			rows = append(rows, []any{r.CosmeticID, *r.EquippedToID, r.UserID})
		} else {
			rows = append(rows, []any{r.CosmeticID, *r.EquippedToID, goldenPtr(r.Data), goldenCosmeticCreator(db, r.CosmeticID)})
		}
	}
	return testkit.NewRows(cols, rows...), nil
}

// goldenFrameColumns are the frame lookup's columns.
var goldenFrameColumns = []string{"cosmeticId", "equippedToId", "userData", "createdById"}

// goldenTagRoutes answer the tag-ids miss lookup: the image's tag rows (every fixture tag an enabled
// User row: the fixtures record no source) and the tag records it reads (a fixture tag is a
// UserGenerated tag).
func goldenTagRoutes(db *goldenDB) []testkit.Route {
	return []testkit.Route{
		{Match: `FROM "TagsOnImageDetails" WHERE "imageId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, id := range goldenInts(args[0]) {
				for _, img := range db.Images {
					if img.ID != id {
						continue
					}
					for _, tag := range img.Tags {
						rows = append(rows, []any{img.ID, "User", tag})
					}
				}
			}
			return testkit.NewRows([]string{"imageId", "source", "tagId"}, rows...), nil
		}},
		{Match: `name::text AS name, type::text AS type FROM "Tag"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, tag := range db.Tags {
				if goldenHas(goldenInts(args[0]), tag.ID) {
					rows = append(rows, []any{tag.ID, tag.Name, "UserGenerated"})
				}
			}
			return testkit.NewRows([]string{"id", "name", "type"}, rows...), nil
		}},
	}
}

// --- the Postgres fake: each query this service sends, answered over the fixture's tables ------

var (
	goldenReIDs       = regexp.MustCompile(`i\."id" = ANY\(\$(\d+)::int\[\]\)`)
	goldenRePostIDs   = regexp.MustCompile(`i\."postId" = ANY\(\$(\d+)::int\[\]\)`)
	goldenRePostID    = regexp.MustCompile(`i\."postId" = \$(\d+)`)
	goldenReImageID   = regexp.MustCompile(`i\.id = \$(\d+)`)
	goldenReVersion   = regexp.MustCompile(`irr\."modelVersionId" = \$(\d+)`)
	goldenReModel     = regexp.MustCompile(`mv\."modelId" = \$(\d+)`)
	goldenReLevel     = regexp.MustCompile(`\(i\."nsfwLevel" & \$(\d+)\) != 0`)
	goldenReTarget    = regexp.MustCompile(` AND i\."userId" = \$(\d+)`)
	goldenReFollowed  = regexp.MustCompile(`i\."userId" = ANY\(\$(\d+)::int\[\]\)`)
	goldenRePostVer   = regexp.MustCompile(`p\."modelVersionId" = \$(\d+)`)
	goldenReReactions = regexp.MustCompile(`ir\."userId" = \$(\d+) AND ir\.reaction = ANY\(\$(\d+)::text\[\]::"ReviewReactions"\[\]\)`)
	goldenReExclUsers = regexp.MustCompile(`i\."userId" != ALL\(\$(\d+)::int\[\]\)`)
	goldenReTypes     = regexp.MustCompile(`i\.type = ANY\(\$(\d+)::text`)
	goldenReCursor    = regexp.MustCompile(`\(\((i\."id"|irr\."imageId"|i\."index"|ct\."collectionItemId") (<=|>=) \$(\d+)\)\)`)
	goldenReTags      = regexp.MustCompile(`WHERE "tagId" = ANY\(\$(\d+)::int\[\]\) AND "disabled" = FALSE`)
	goldenReTechnique = regexp.MustCompile(`it\."techniqueId" = ANY\(\$(\d+)::int\[\]\)`)
	goldenReTools     = regexp.MustCompile(`HAVING array_agg\(it\."toolId" ORDER BY it\."toolId"\) @> \$(\d+)::integer\[\]`)
	goldenReBaseMdl   = regexp.MustCompile(`WHERE mv\."baseModel" = ANY\(\$(\d+)::text\[\]\)`)
	goldenReLimit     = regexp.MustCompile(`LIMIT \$(\d+)\s*$`)
	goldenReOffset    = regexp.MustCompile(`OFFSET (\d+)\s+LIMIT`)
	goldenReMinorOwn  = regexp.MustCompile(`\(i\."minor" != TRUE OR i\."userId" = \$(\d+)\)`)
	goldenReRRModel   = regexp.MustCompile(`rr\."modelId" = \$(\d+)`)
	goldenReRRVersion = regexp.MustCompile(`rr\."modelVersionId" = \$(\d+)`)
	// The collection page: the `ct` CTE's collection, tag and viewer (whose own not-REJECTED items it
	// keeps), and the acceptableMinor owner exemption.
	goldenReCollection = regexp.MustCompile(`ci\."collectionId" = \$(\d+)`)
	goldenReCollTag    = regexp.MustCompile(`ci\."tagId" = \$(\d+)`)
	goldenReCollOwner  = regexp.MustCompile(`ci\."status" <> 'REJECTED' AND ci\."addedById" = \$(\d+)`)
	// A collection page's Random order: the seed the CTE hashes with, and its cursor clause.
	goldenReCollSeed   = regexp.MustCompile(`hashtext\(concat\(ci\.id::text, \$(\d+)::text\)\)`)
	goldenReCollRandom = regexp.MustCompile(`WHERE \(\s*"sortKey" < \$(\d+)\s*OR \(\s*"sortKey" = \$(\d+)\s*AND "imageId" < \$(\d+)\s*\)\s*\)`)
	goldenReMinorOwner = regexp.MustCompile(`\(i\."acceptableMinor" = FALSE OR i\."userId" = \$(\d+)\)`)
	// The minor content rule (minorMatureImageVisibleSql): a minor-flagged image rated NULL, 0 or at
	// least the captured level is kept only for the bound owner (none bound: for nobody).
	goldenReMinorMature = regexp.MustCompile(`\(NOT \(\(COALESCE\(i\."minor", FALSE\)\) AND \(i\."nsfwLevel" IS NULL OR i\."nsfwLevel" = 0 OR i\."nsfwLevel" >= (\d+)\)\)(?: OR i\."userId" = \$(\d+))?\)`)
	// The block clauses (blockedMediaListConditions, image-visibility.ts): the owner's exemption from
	// a blockedFor reason where ownerMediaAllowed allows it, and the owner's own images held to
	// ownerMediaAllowed (ownerMediaSql).
	goldenReBlockedOwner = regexp.MustCompile(`\(i\."blockedFor" IS NULL OR \(i\."userId" = \$(\d+) AND ` + regexp.QuoteMeta(goldenOwnerMediaAllowed) + `\)\)`)
	// The REST legacy path's `requiringMeta`: only images blocked for the bound reason.
	goldenReBlockedReason = regexp.MustCompile(`i\."blockedFor" = \$(\d+)`)
	goldenReOwnerMedia    = regexp.MustCompile(`\("i"\."userId" <> \$(\d+) OR ` + regexp.QuoteMeta(goldenOwnerMediaAllowed) + `\)`)
)

// goldenOwnerMediaAllowed is ownerMediaAllowedSql('i') as the image query spells it, with
// OWNER_MEDIA_EXEMPT_BLOCKS (src/server/common/image-block-marker.ts) inlined: goldenBlockedFor
// evaluates it with that list, so a query spelling another list is a clause the harness refuses.
const goldenOwnerMediaAllowed = `(CASE WHEN "i"."blockedFor" IS NOT NULL THEN "i"."blockedFor" IN ('AiNotVerified') ELSE "i"."ingestion" <> 'Blocked'::"ImageIngestionStatus" END)`

// goldenBlockedFor reads the image query's block clauses from sql and returns whether an image passes
// all of them, each evaluated as Postgres would over the row: `(i."blockedFor" IS NULL)`, the owner's
// exemption where ownerMediaAllowed allows it, and the owner's own images held to ownerMediaAllowed.
// Any other mention of "blockedFor" outside the SELECT list (a bare owner exemption from any reason
// included) is an error, so a block clause the harness does not evaluate never reads as passing.
func goldenBlockedFor(args []any, sql string) (func(goldenImage) bool, error) {
	ownerAllowed := func(img goldenImage) bool {
		if img.BlockedFor != nil {
			return *img.BlockedFor == "AiNotVerified"
		}
		return img.Ingestion != "Blocked"
	}
	var keeps []func(goldenImage) bool
	rest := sql
	take := func(re *regexp.Regexp, keep func(viewer int) func(goldenImage) bool) error {
		for _, m := range re.FindAllStringSubmatch(rest, -1) {
			n, _ := strconv.Atoi(m[1])
			if n < 1 || n > len(args) || goldenInt(args[n-1]) == 0 {
				return fmt.Errorf("golden: a block clause's viewer is not bound: %s", m[0])
			}
			keeps = append(keeps, keep(goldenInt(args[n-1])))
			rest = strings.Replace(rest, m[0], "", 1)
		}
		return nil
	}
	if err := take(goldenReBlockedOwner, func(v int) func(goldenImage) bool {
		return func(img goldenImage) bool { return img.BlockedFor == nil || (img.UserID == v && ownerAllowed(img)) }
	}); err != nil {
		return nil, err
	}
	if err := take(goldenReOwnerMedia, func(v int) func(goldenImage) bool {
		return func(img goldenImage) bool { return img.UserID != v || ownerAllowed(img) }
	}); err != nil {
		return nil, err
	}
	for _, m := range goldenReBlockedReason.FindAllStringSubmatch(rest, -1) {
		n, _ := strconv.Atoi(m[1])
		reason, ok := "", n >= 1 && n <= len(args)
		if ok {
			reason, ok = args[n-1].(string)
		}
		if !ok || reason == "" {
			return nil, fmt.Errorf("golden: a blockedFor reason clause without its reason: %s", m[0])
		}
		keeps = append(keeps, func(img goldenImage) bool { return img.BlockedFor != nil && *img.BlockedFor == reason })
		rest = strings.Replace(rest, m[0], "", 1)
	}
	if n := strings.Count(rest, `(i."blockedFor" IS NULL)`); n > 0 {
		keeps = append(keeps, func(img goldenImage) bool { return img.BlockedFor == nil })
		rest = strings.ReplaceAll(rest, `(i."blockedFor" IS NULL)`, "")
	}
	rest = strings.ReplaceAll(rest, `i."blockedFor",`, "") // the SELECT column
	if strings.Contains(rest, `blockedFor`) {
		return nil, errors.New("golden: a blockedFor clause the harness does not evaluate")
	}
	return func(img goldenImage) bool {
		for _, keep := range keeps {
			if !keep(img) {
				return false
			}
		}
		return true
	}, nil
}

// goldenMinorMature reads the minor content rule's clause from sql: present, the level it restricts
// from, and the owner it exempts (0: none).
func goldenMinorMature(args []any, sql string) (present bool, from, owner int) {
	m := goldenReMinorMature.FindStringSubmatch(sql)
	if m == nil {
		return false, 0, 0
	}
	from, _ = strconv.Atoi(m[1])
	if m[2] != "" {
		if n, _ := strconv.Atoi(m[2]); n >= 1 && n <= len(args) {
			owner = goldenInt(args[n-1])
		}
	}
	return true, from, owner
}

func goldenArg(args []any, re *regexp.Regexp, sql string) (any, bool) {
	m := re.FindStringSubmatch(sql)
	if m == nil {
		return nil, false
	}
	n, _ := strconv.Atoi(m[len(m)-1])
	if n < 1 || n > len(args) {
		return nil, false
	}
	return args[n-1], true
}

func goldenInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int32:
		return int(t)
	case int64:
		return int(t)
	}
	return 0
}

func goldenInts(v any) []int {
	switch t := v.(type) {
	case []int:
		return t
	case []int32:
		out := make([]int, len(t))
		for i, n := range t {
			out[i] = int(n)
		}
		return out
	case []int64:
		out := make([]int, len(t))
		for i, n := range t {
			out[i] = int(n)
		}
		return out
	}
	return nil
}

func goldenHas(list []int, n int) bool {
	for _, x := range list {
		if x == n {
			return true
		}
	}
	return false
}

// goldenImageRows answers the getAllImages page query: the clauses the fixtures reach, evaluated
// over the images table as Postgres would (ids, posts, version or model scope, level, creator,
// followed creators, excluded creators, types, tools, base models, the minor exclusion, the minor
// content rule, published-before-now, order, cursor, offset, limit).
func goldenImageRows(fx *goldenFixture, sql string, args []any) (*testkit.Rows, error) {
	versionModel := map[int]int{}
	versionBase := map[int]string{}
	for _, v := range fx.DB.ModelVersions {
		versionModel[v.ID] = v.ModelID
		versionBase[v.ID] = v.BaseModel
	}
	ids, hasIDs := goldenArg(args, goldenReIDs, sql)
	postIDs, hasPostIDs := goldenArg(args, goldenRePostIDs, sql)
	postID, hasPostID := goldenArg(args, goldenRePostID, sql)
	imageID, hasImageID := goldenArg(args, goldenReImageID, sql)
	version, hasVersion := goldenArg(args, goldenReVersion, sql)
	model, hasModel := goldenArg(args, goldenReModel, sql)
	level, hasLevel := goldenArg(args, goldenReLevel, sql)
	target, hasTarget := goldenArg(args, goldenReTarget, sql)
	// Every `i."userId" = ANY(<list>)` clause (the follow list, the new-creators board, the prioritized
	// creators): an image must be in each.
	var userLists [][]int
	for _, m := range goldenReFollowed.FindAllStringSubmatch(sql, -1) {
		n, _ := strconv.Atoi(m[1])
		if n < 1 || n > len(args) {
			return nil, errors.New("golden: a creator list bound past the arguments")
		}
		userLists = append(userLists, goldenInts(args[n-1]))
	}
	postVersion, hasPostVersion := goldenArg(args, goldenRePostVer, sql)
	var reactionUser int
	var reactionKinds []string
	if m := goldenReReactions.FindStringSubmatch(sql); m != nil {
		u, _ := strconv.Atoi(m[1])
		k, _ := strconv.Atoi(m[2])
		reactionUser = goldenInt(args[u-1])
		reactionKinds, _ = args[k-1].([]string)
		if reactionUser == 0 || len(reactionKinds) == 0 {
			return nil, errors.New("golden: a reaction clause without its viewer or kinds")
		}
	}
	// An empty new-creators board: `1 = 0`, no row at all.
	noRow := strings.Contains(sql, ` AND 1 = 0 AND `)
	exclUsers, hasExcl := goldenArg(args, goldenReExclUsers, sql)
	types, hasTypes := goldenArg(args, goldenReTypes, sql)
	minorOwner, hasMinorOwner := goldenArg(args, goldenReMinorOwn, sql)
	tags, hasTags := goldenArg(args, goldenReTags, sql)
	techniques, hasTechniques := goldenArg(args, goldenReTechnique, sql)
	tools, hasTools := goldenArg(args, goldenReTools, sql)
	baseModels, hasBaseModels := goldenArg(args, goldenReBaseMdl, sql)
	minorAll := strings.Contains(sql, `(i."minor" != TRUE)`)
	published := strings.Contains(sql, `(p."publishedAt" < now())`)
	acceptableMinorOwner, hasAcceptableMinorOwner := goldenArg(args, goldenReMinorOwner, sql)
	acceptableMinorAll := strings.Contains(sql, ` AND i."acceptableMinor" = FALSE AND `)
	minorMature, minorMatureFrom, minorMatureOwner := goldenMinorMature(args, sql)
	collection, hasCollection := goldenArg(args, goldenReCollection, sql)
	collTag, hasCollTag := goldenArg(args, goldenReCollTag, sql)
	collOwner, hasCollOwner := goldenArg(args, goldenReCollOwner, sql)
	// getAllImages leaves the level and reviewed gates out only for `requiringMeta` on the red domain,
	// which then binds its blockedFor reason: any other query without a level clause is refused.
	if !hasLevel && !goldenReBlockedReason.MatchString(sql) {
		return nil, errors.New("golden: image query without a level clause")
	}
	blockedKeeps, err := goldenBlockedFor(args, sql)
	if err != nil {
		return nil, err
	}
	if hasCollection != strings.Contains(sql, `JOIN ct ON ct."imageId" = i.id`) ||
		(hasCollection && !strings.Contains(sql, `AND ci."imageId" IS NOT NULL`)) {
		return nil, errors.New("golden: a collection CTE without its join, or the join without the CTE")
	}
	// itemsOf is the `ct` CTE's rows of an image: the collection's items, with the tag, and ACCEPTED
	// or (with a viewer) the viewer's own that are not REJECTED.
	itemsOf := func(imageID int) []goldenCollectionItem {
		var out []goldenCollectionItem
		for _, ci := range fx.DB.CollectionItems {
			if ci.CollectionID != goldenInt(collection) || ci.ImageID != imageID {
				continue
			}
			if hasCollTag && (ci.TagID == nil || *ci.TagID != goldenInt(collTag)) {
				continue
			}
			own := hasCollOwner && ci.Status != "REJECTED" && ci.AddedByID != nil && *ci.AddedByID == goldenInt(collOwner)
			if ci.Status == "ACCEPTED" || own {
				out = append(out, ci)
			}
		}
		return out
	}
	var out [][]any
	var kept []goldenImage
	itemOf := map[int]goldenCollectionItem{} // kept index -> its item (a collection page)
	for _, img := range fx.DB.Images {
		if hasIDs && !goldenHas(goldenInts(ids), img.ID) {
			continue
		}
		if hasPostIDs && !goldenHas(goldenInts(postIDs), img.PostID) {
			continue
		}
		if hasPostID && img.PostID != goldenInt(postID) {
			continue
		}
		if hasImageID && img.ID != goldenInt(imageID) {
			continue
		}
		// FROM "ImageResourceNew" irr JOIN … (JOIN "ModelVersion" mv for a model): one row per matching
		// resource row. A version matches at most one row of an image; a model, one per version of it the
		// image used, so such an image is listed once per version.
		copies := 1
		if hasVersion || hasModel {
			copies = 0
			for _, r := range img.Resources {
				if (hasVersion && r.ModelVersionID == goldenInt(version)) || (!hasVersion && versionModel[r.ModelVersionID] == goldenInt(model)) {
					copies++
				}
			}
			if copies == 0 {
				continue
			}
		}
		if lv := goldenInt(level); hasLevel && (img.NsfwLevel&lv == 0 || img.NsfwLevel == 0) {
			continue
		}
		if hasTarget && img.UserID != goldenInt(target) {
			continue
		}
		inLists := true
		for _, list := range userLists {
			inLists = inLists && goldenHas(list, img.UserID)
		}
		if !inLists || noRow {
			continue
		}
		if hasPostVersion && (img.ModelVersionID == nil || *img.ModelVersionID != goldenInt(postVersion)) {
			continue
		}
		if reactionUser != 0 {
			reacted := false
			for _, r := range fx.DB.Reactions {
				reacted = reacted || (r.UserID == reactionUser && r.ImageID == img.ID && slices.Contains(reactionKinds, r.Reaction))
			}
			if !reacted {
				continue
			}
		}
		if hasTags {
			carries := false
			for _, t := range img.Tags {
				carries = carries || goldenHas(goldenInts(tags), t)
			}
			if !carries {
				continue
			}
		}
		if hasTechniques {
			// EXISTS (… "techniqueId" = ANY(<techniques>)): a row for any listed technique.
			holdsAny := false
			for _, t := range img.Techniques {
				holdsAny = holdsAny || goldenHas(goldenInts(techniques), t)
			}
			if !holdsAny {
				continue
			}
		}
		if hasExcl && goldenHas(goldenInts(exclUsers), img.UserID) {
			continue
		}
		if hasTools {
			// array_agg(toolId) @> <tools>: the image holds every listed tool (none held: no group).
			holdsAll := len(img.Tools) > 0
			for _, t := range goldenInts(tools) {
				holdsAll = holdsAll && goldenHas(img.Tools, t)
			}
			if !holdsAll {
				continue
			}
		}
		if hasBaseModels {
			// EXISTS (ModelVersion RIGHT JOIN ImageResourceNew … WHERE mv."baseModel" = ANY(<names>)): a
			// resource row whose version exists and carries one of the names.
			names, _ := baseModels.([]string)
			matched := false
			for _, r := range img.Resources {
				if b, ok := versionBase[r.ModelVersionID]; ok {
					for _, n := range names {
						matched = matched || n == b
					}
				}
			}
			if !matched {
				continue
			}
		}
		if hasTypes {
			list, _ := types.([]string)
			found := false
			for _, t := range list {
				found = found || t == img.Type
			}
			if !found {
				continue
			}
		}
		if img.Minor && (minorAll || (hasMinorOwner && img.UserID != goldenInt(minorOwner))) {
			continue
		}
		if minorMature && img.Minor && (img.NsfwLevel == 0 || img.NsfwLevel >= minorMatureFrom) &&
			(minorMatureOwner == 0 || img.UserID != minorMatureOwner) {
			continue
		}
		if published && (img.PublishedAt.T == nil || !img.PublishedAt.T.Before(fx.Now)) {
			continue
		}
		if !blockedKeeps(img) {
			continue
		}
		if img.AcceptableMinor && (acceptableMinorAll || (hasAcceptableMinorOwner && img.UserID != goldenInt(acceptableMinorOwner))) {
			continue
		}
		if hasCollection {
			// JOIN ct: one row per matching item.
			for _, ci := range itemsOf(img.ID) {
				itemOf[len(kept)] = ci
				kept = append(kept, img)
			}
			continue
		}
		for range copies {
			kept = append(kept, img)
		}
	}
	if hasCollection {
		// Carry each row's item through the sort and the paging below.
		return goldenCollectionRows(sql, args, kept, itemOf)
	}
	// The system user's IIF ahead of the sort's own order (prioritizedUserIds [-1] without a post of
	// its own), or the prioritized creators' oldest-post order in place of it.
	const iifPrefix = `ORDER BY IIF(i."userId" IN (-1), i.index, 1000),  `
	iif := strings.Contains(sql, iifPrefix)
	oldestPost := strings.Contains(sql, `ORDER BY (i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`)
	order := "ORDER BY "
	if iif {
		order = iifPrefix
	}
	asc := strings.Contains(sql, order+`i."id" ASC`)
	// A post's own media: ORDER BY i."index", i."id", and the index is the cursor column.
	byIndex := strings.Contains(sql, order+`i."index", i."id"`)
	indexOf := func(img goldenImage) int {
		if img.Index == nil {
			return 0
		}
		return *img.Index
	}
	iifOf := func(img goldenImage) int {
		if img.UserID == -1 {
			if img.Index == nil {
				return math.MaxInt // NULL sorts last ascending; no fixture row has one
			}
			return *img.Index
		}
		return 1000
	}
	sort.SliceStable(kept, func(a, b int) bool {
		switch {
		case oldestPost:
			ka, kb := kept[a].PostID*100+indexOf(kept[a]), kept[b].PostID*100+indexOf(kept[b])
			if ka != kb {
				return ka < kb
			}
			return kept[a].ID < kept[b].ID
		case iif && iifOf(kept[a]) != iifOf(kept[b]):
			return iifOf(kept[a]) < iifOf(kept[b])
		case byIndex && indexOf(kept[a]) != indexOf(kept[b]):
			return indexOf(kept[a]) < indexOf(kept[b])
		case asc || byIndex:
			return kept[a].ID < kept[b].ID
		}
		return kept[a].ID > kept[b].ID
	})
	if m := goldenReCursor.FindStringSubmatch(sql); m != nil {
		n, _ := strconv.Atoi(m[3])
		c := goldenInt(args[n-1])
		var paged []goldenImage
		for _, img := range kept {
			v := img.ID
			if m[1] == `i."index"` {
				v = indexOf(img)
			}
			if (m[2] == "<=" && v <= c) || (m[2] == ">=" && v >= c) {
				paged = append(paged, img)
			}
		}
		kept = paged
	}
	if m := goldenReOffset.FindStringSubmatch(sql); m != nil {
		n, _ := strconv.Atoi(m[1])
		kept = kept[min(n, len(kept)):]
	}
	if limit, ok := goldenArg(args, goldenReLimit, sql); ok && len(kept) > goldenInt(limit) {
		kept = kept[:goldenInt(limit)]
	}
	for _, img := range kept {
		var cursor any = img.ID
		if strings.Contains(sql, `i."index" "cursorId"`) {
			cursor = goldenPtr(img.Index)
		}
		out = append(out, img.row(cursor))
	}
	return testkit.NewRows(goldenImageColumns, out...), nil
}

// goldenCollectionRows orders and pages a collection page's rows (kept[i] joined to itemOf[i]):
// `ORDER BY ct."collectionItemId" DESC` or the id orders, the inclusive cursor on the sort's column,
// the limit; each row with its item's note, status and adder after the cursor column.
func goldenCollectionRows(sql string, args []any, kept []goldenImage, itemOf map[int]goldenCollectionItem) (*testkit.Rows, error) {
	type joined struct {
		img  goldenImage
		item goldenCollectionItem
	}
	rows := make([]joined, len(kept))
	for i, img := range kept {
		rows[i] = joined{img, itemOf[i]}
	}
	byItem := strings.Contains(sql, `ORDER BY ct."collectionItemId" DESC`)
	asc := strings.Contains(sql, `ORDER BY i."id" ASC`)
	// The Random order: each item's sort key under the bound seed (the fixture's, from Postgres), the
	// CTE's own cursor clause, then `ct."sortKey" DESC, i."id" DESC`.
	seedArg, random := goldenArg(args, goldenReCollSeed, sql)
	if random != strings.Contains(sql, `ORDER BY ct."sortKey" DESC, i."id" DESC`) {
		return nil, errors.New("golden: a seeded sort key without the Random order, or the order without the seed")
	}
	if random {
		seed, ok := seedArg.(string)
		if !ok {
			return nil, fmt.Errorf("golden: the Random seed is bound as %T, want text", seedArg)
		}
		keyOf := func(r joined) (int, error) {
			k, ok := r.item.SortKeys[seed]
			if !ok {
				return 0, fmt.Errorf("golden: item %d has no sort key for seed %q", r.item.ID, seed)
			}
			return k, nil
		}
		keys := make(map[int]int, len(rows))
		for _, r := range rows {
			k, err := keyOf(r)
			if err != nil {
				return nil, err
			}
			keys[r.item.ID] = k
		}
		if m := goldenReCollRandom.FindStringSubmatch(sql); m != nil {
			at := func(s string) int { n, _ := strconv.Atoi(s); return goldenInt(args[n-1]) }
			if m[1] != m[2] {
				return nil, errors.New("golden: the Random cursor compares two different sort keys")
			}
			ck, cid := at(m[1]), at(m[3])
			var paged []joined
			for _, r := range rows {
				if k := keys[r.item.ID]; k < ck || (k == ck && r.img.ID < cid) {
					paged = append(paged, r)
				}
			}
			rows = paged
		}
		if goldenReCursor.MatchString(sql) {
			return nil, errors.New("golden: a Random page with a getCursor clause")
		}
		sort.SliceStable(rows, func(a, b int) bool {
			if ka, kb := keys[rows[a].item.ID], keys[rows[b].item.ID]; ka != kb {
				return ka > kb
			}
			return rows[a].img.ID > rows[b].img.ID
		})
		if limit, ok := goldenArg(args, goldenReLimit, sql); ok && len(rows) > goldenInt(limit) {
			rows = rows[:goldenInt(limit)]
		}
		cols := append(append([]string(nil), goldenImageColumns...), "collectionItemNote", "collectionItemStatus", "collectionItemAddedById")
		out := make([][]any, 0, len(rows))
		for _, r := range rows {
			out = append(out, append(r.img.row(keys[r.item.ID]), goldenPtr(r.item.Note), r.item.Status, goldenPtr(r.item.AddedByID)))
		}
		return testkit.NewRows(cols, out...), nil
	}
	if !byItem && !asc && !strings.Contains(sql, `ORDER BY i."id" DESC`) {
		return nil, errors.New("golden: a collection page in an order the fake does not evaluate")
	}
	key := func(r joined) int {
		if byItem {
			return r.item.ID
		}
		return r.img.ID
	}
	sort.SliceStable(rows, func(a, b int) bool {
		if asc {
			return key(rows[a]) < key(rows[b])
		}
		return key(rows[a]) > key(rows[b])
	})
	if m := goldenReCursor.FindStringSubmatch(sql); m != nil {
		if (m[1] == `ct."collectionItemId"`) != byItem {
			return nil, fmt.Errorf("golden: cursor column %s for the order of %q", m[1], sql)
		}
		n, _ := strconv.Atoi(m[3])
		c := goldenInt(args[n-1])
		var paged []joined
		for _, r := range rows {
			if v := key(r); (m[2] == "<=" && v <= c) || (m[2] == ">=" && v >= c) {
				paged = append(paged, r)
			}
		}
		rows = paged
	}
	if limit, ok := goldenArg(args, goldenReLimit, sql); ok && len(rows) > goldenInt(limit) {
		rows = rows[:goldenInt(limit)]
	}
	cols := append(append([]string(nil), goldenImageColumns...), "collectionItemNote", "collectionItemStatus", "collectionItemAddedById")
	out := make([][]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, append(r.img.row(key(r)), goldenPtr(r.item.Note), r.item.Status, goldenPtr(r.item.AddedByID)))
	}
	return testkit.NewRows(cols, out...), nil
}

// newGoldenPG is the fixture's Postgres: one route per query this service sends, each answered
// over the fixture's tables. A query no route matches fails (testkit.DB), so the test fails too.
func newGoldenPG(fx *goldenFixture) *testkit.DB {
	db := &fx.DB
	return &testkit.DB{Routes: append([]testkit.Route{
		{Match: `count(*)::int AS "count"`, Rows: func(args []any) (*testkit.Rows, error) {
			counts := map[int]int{}
			for _, img := range db.Images {
				counts[img.PostID]++
			}
			var rows [][]any
			for _, id := range goldenInts(args[0]) {
				if n := counts[id]; n > 0 {
					rows = append(rows, []any{id, n})
				}
			}
			return testkit.NewRows([]string{"postId", "count"}, rows...), nil
		}},
		{Match: `"cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			return goldenImageRows(fx, sql, args)
		}},
		// The collection permission read (image.getInfinite's `collectionId`): the fixture's
		// Collection row and the viewer's contributor permissions (none: an empty list); a collection
		// the fixture does not hold is no row. The contributor row is joined exactly for a viewer.
		{Match: `FROM "Collection" c`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			cols := []string{"read", "userId", "permissions"}
			viewer := 0
			if len(args) > 1 {
				viewer = goldenInt(args[1])
			}
			if (viewer != 0) != strings.Contains(sql, `"CollectionContributor"`) {
				return nil, fmt.Errorf("golden: the collection read joins the contributor row exactly for a viewer (viewer %d)", viewer)
			}
			for _, c := range db.Collections {
				if c.ID != goldenInt(args[0]) {
					continue
				}
				perms := []string{}
				for _, cc := range c.Contributors {
					if cc.UserID == viewer {
						perms = cc.Permissions
					}
				}
				return testkit.NewRows(cols, []any{c.Read, c.UserID, perms}), nil
			}
			return testkit.NewRows(cols), nil
		}},
		{Match: `SELECT "modelId" FROM "ModelVersion" WHERE id = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, v := range db.ModelVersions {
				if v.ID == goldenInt(args[0]) {
					return testkit.NewRows([]string{"modelId"}, []any{v.ModelID}), nil
				}
			}
			return testkit.NewRows([]string{"modelId"}), nil
		}},
		{Match: `SELECT id, "modelId" FROM "ModelVersion"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, v := range db.ModelVersions {
				if goldenHas(goldenInts(args[0]), v.ID) {
					rows = append(rows, []any{v.ID, v.ModelID})
				}
			}
			return testkit.NewRows([]string{"id", "modelId"}, rows...), nil
		}},
		// getHeldLevelsByPost's owner read (image.getInfinite's `ids`): each existing model's owner.
		{Match: `SELECT id, "userId" FROM "Model" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, m := range db.Models {
				if goldenHas(goldenInts(args[0]), m.ID) {
					rows = append(rows, []any{m.ID, m.UserID})
				}
			}
			return testkit.NewRows([]string{"id", "userId"}, rows...), nil
		}},
		// getAllImages' hasSystemPosts (`prioritizedUserIds: [-1]` on a version): a post of the system
		// user on the version, or none.
		{Match: `SELECT id FROM "Post" WHERE "userId" = -1 AND "modelVersionId" = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, p := range db.SystemPosts {
				if p.ModelVersionID == goldenInt(args[0]) {
					return testkit.NewRows([]string{"id"}, []any{p.ID}), nil
				}
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
		{Match: `SELECT "userId", mode::text FROM "Model"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, m := range db.Models {
				if goldenHas(goldenInts(args[0]), m.ID) {
					rows = append(rows, []any{m.UserID, goldenPtr(m.Mode)})
				}
			}
			return testkit.NewRows([]string{"userId", "mode"}, rows...), nil
		}},
		// The gallery-hold computation of a gallery-settings miss (getGallerySettingsByModelId's
		// rebuild): each existing model's flags and its stored level's JSON type and text.
		{Match: `SELECT id, minor, "sfwOnly", jsonb_typeof("gallerySettings"->'level')`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, m := range db.Models {
				if goldenHas(goldenInts(args[0]), m.ID) {
					typ, text := goldenJSONTypeText(m.GalleryLevel)
					rows = append(rows, []any{m.ID, m.Minor, m.SfwOnly, typ, text})
				}
			}
			return testkit.NewRows([]string{"id", "minor", "sfwOnly", "levelType", "level"}, rows...), nil
		}},
		{Match: `SELECT minor, "sfwOnly"`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, m := range db.Models {
				if m.ID == goldenInt(args[0]) {
					return testkit.NewRows([]string{"minor", "sfwOnly", "level"}, []any{m.Minor, m.SfwOnly, goldenJSONVal(m.GalleryLevel)}), nil
				}
			}
			return testkit.NewRows([]string{"minor", "sfwOnly", "level"}), nil
		}},
		{Match: `FROM "Placement"`, Rows: func(args []any) (*testkit.Rows, error) {
			since, err := time.Parse("2006-01-02T15:04:05.000", fmt.Sprint(args[1]))
			if err != nil {
				return nil, err
			}
			var rows [][]any
			for _, p := range db.Placements {
				if p.Surface == "galleryPromotion" && p.TargetType == "model" && p.TargetID == goldenInt(args[0]) &&
					p.Status == "approved" && p.ResolvedAt.T != nil && p.ResolvedAt.T.After(since) {
					rows = append(rows, []any{p.ID, goldenTimeVal(p.ResolvedAt), string(p.Data)})
				}
			}
			return testkit.NewRows([]string{"id", "resolvedAt", "data"}, rows...), nil
		}},
		{Match: `FROM "ResourceReview" rr`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			model, hasModel := goldenArg(args, goldenReRRModel, sql)
			version, hasVersion := goldenArg(args, goldenReRRVersion, sql)
			type review struct {
				userID, rating, id int
				details            *string
				recommended        bool
			}
			var list []review
			for _, r := range db.Reviews {
				if !goldenHas(goldenInts(args[0]), r.UserID) || (hasModel && r.ModelID != goldenInt(model)) ||
					(hasVersion && r.ModelVersionID != goldenInt(version)) {
					continue
				}
				if r.PostID != nil {
					return nil, errors.New("golden: a review on a post is not modelled")
				}
				list = append(list, review{r.UserID, r.Rating, r.ID, r.Details, r.Recommended})
			}
			sort.SliceStable(list, func(a, b int) bool { return list[a].rating > list[b].rating })
			var rows [][]any
			for _, r := range list {
				rows = append(rows, []any{r.userID, r.rating, goldenPtr(r.details), r.id, r.recommended})
			}
			return testkit.NewRows([]string{"userId", "rating", "details", "id", "recommended"}, rows...), nil
		}},
		{Match: `FROM "ImageReaction"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, r := range db.Reactions {
				if goldenHas(goldenInts(args[0]), r.ImageID) && r.UserID == goldenInt(args[1]) {
					rows = append(rows, []any{r.ImageID, r.Reaction})
				}
			}
			return testkit.NewRows([]string{"imageId", "reaction"}, rows...), nil
		}},
		{Match: `FROM "TagsOnImageVote"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, v := range db.TagVotes {
				if goldenHas(goldenInts(args[0]), v.ImageID) && v.UserID == goldenInt(args[1]) {
					rows = append(rows, []any{v.ImageID, v.TagID, v.Vote})
				}
			}
			return testkit.NewRows([]string{"imageId", "tagId", "vote"}, rows...), nil
		}},
		{Match: `SELECT "imageId", "modelVersionId" FROM "ImageResourceNew"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, img := range db.Images {
				if !goldenHas(goldenInts(args[0]), img.ID) {
					continue
				}
				for _, r := range img.Resources {
					rows = append(rows, []any{img.ID, r.ModelVersionID})
				}
			}
			return testkit.NewRows([]string{"imageId", "modelVersionId"}, rows...), nil
		}},
		{Match: `SELECT id, "modelVersionId" FROM "Post"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, p := range db.Posts {
				if goldenHas(goldenInts(args[0]), p.ID) {
					rows = append(rows, []any{p.ID, goldenPtr(p.ModelVersionID)})
				}
			}
			return testkit.NewRows([]string{"id", "modelVersionId"}, rows...), nil
		}},
		{Match: `ELSE i.meta END)::text AS "meta" FROM "Image" i`, Rows: func(args []any) (*testkit.Rows, error) {
			// imageMetaCache's lookup: the meta of each image found, NULL when it hides it.
			var rows [][]any
			for _, img := range db.Images {
				if !goldenHas(goldenInts(args[0]), img.ID) {
					continue
				}
				var meta any
				if !img.HideMeta {
					meta = goldenPtr(img.Meta)
				}
				rows = append(rows, []any{img.ID, meta})
			}
			return testkit.NewRows([]string{"id", "meta"}, rows...), nil
		}},
		{Match: `SELECT id FROM "User" WHERE username = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, u := range db.Users {
				if u.Username != nil && *u.Username == fmt.Sprint(args[0]) {
					return testkit.NewRows([]string{"id"}, []any{u.ID}), nil
				}
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
		{Match: `FROM "UserCosmetic" WHERE "userId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, r := range db.UserCosmetics {
				if goldenHas(goldenInts(args[0]), r.UserID) && r.Equipped && r.EquippedToID == nil {
					rows = append(rows, []any{r.UserID, r.CosmeticID, goldenPtr(r.Data)})
				}
			}
			return testkit.NewRows([]string{"userId", "cosmeticId", "data"}, rows...), nil
		}},
		{Match: `jsonb_typeof(c.data->'event') IS DISTINCT FROM 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			return goldenEntityCosmetics(db, sql, args, false, goldenFrameColumns)
		}},
		{Match: `jsonb_typeof(c.data->'event') = 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			return goldenEntityCosmetics(db, sql, args, true, []string{"cosmeticId", "equippedToId", "userId"})
		}},
		{Match: `FROM "CosmeticShopItem" si`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, x := range db.CosmeticShopItems {
				if goldenHas(goldenInts(args[0]), x.CosmeticID) {
					rows = append(rows, []any{x.CosmeticID, goldenPtr(x.AddedByID), x.Status, x.Meta, goldenPtr(x.RejectionReason), goldenCosmeticCreator(db, x.CosmeticID)})
				}
			}
			return testkit.NewRows([]string{"cosmeticId", "addedById", "status", "meta", "rejectionReason", "createdById"}, rows...), nil
		}},
		{Match: `SELECT id, flags FROM "Cosmetic"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, c := range db.Cosmetics {
				if goldenHas(goldenInts(args[0]), c.ID) && c.CreatedByID != nil {
					rows = append(rows, []any{c.ID, c.Flags})
				}
			}
			return testkit.NewRows([]string{"id", "flags"}, rows...), nil
		}},
		{Match: `SELECT id, username, "deletedAt", image FROM "User"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, u := range db.Users {
				if goldenHas(goldenInts(args[0]), u.ID) {
					rows = append(rows, []any{u.ID, goldenPtr(u.Username), goldenTimeVal(u.DeletedAt), goldenPtr(u.Image)})
				}
			}
			return testkit.NewRows([]string{"id", "username", "deletedAt", "image"}, rows...), nil
		}},
	}, append(goldenHubRoutes(fx), goldenTagRoutes(db)...)...)}
}

// --- the feed service fake -----------------------------------------------------------------------

type goldenFeed struct {
	mu         sync.Mutex
	replies    map[string]goldenFeedReply
	hits       map[string]int
	unexpected []string
}

func (f *goldenFeed) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := r.URL.RawQuery
	reply, ok := f.replies[q]
	if r.URL.Path != "/v1/feed" || !ok {
		f.unexpected = append(f.unexpected, r.URL.Path+"?"+q)
		w.WriteHeader(http.StatusTeapot)
		return
	}
	f.hits[q]++
	status := reply.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(reply.Body)
}

func (f *goldenFeed) check(t *testing.T, requireAll bool) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, q := range f.unexpected {
		t.Errorf("feed-go asked the feed service for a query Node does not send:\n  %s", q)
	}
	if !requireAll {
		return
	}
	for q := range f.replies {
		if f.hits[q] == 0 {
			t.Errorf("feed-go never sent a query Node sends:\n  %s", q)
		}
	}
}

// --- sessions: ES256 tokens against an httptest JWKS ---------------------------------------------

func goldenJWKS(t testing.TB) (*httptest.Server, *ecdsa.PrivateKey) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pad := func(b []byte) []byte {
		out := make([]byte, 32)
		copy(out[32-len(b):], b)
		return out
	}
	jwk := map[string]string{
		"kty": "EC", "crv": "P-256", "kid": "golden", "use": "sig", "alg": "ES256",
		"x": base64.RawURLEncoding.EncodeToString(pad(priv.X.Bytes())),
		"y": base64.RawURLEncoding.EncodeToString(pad(priv.Y.Bytes())),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{jwk}})
	}))
	t.Cleanup(srv.Close)
	return srv, priv
}

func goldenToken(t testing.TB, priv *ecdsa.PrivateKey, userID int, now time.Time) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": "golden", "typ": "JWT"})
	p, _ := json.Marshal(map[string]any{
		"sub": strconv.Itoa(userID), "jti": "golden-" + strconv.Itoa(userID), "iss": goldenIssuer,
		"exp": now.Add(time.Hour).Unix(), "iat": now.Unix(),
		"signedAt": now.UnixMilli(), "iat0": now.Add(-time.Hour).UnixMilli(),
	})
	input := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// --- building the server --------------------------------------------------------------------------

type goldenEnv struct {
	server  *Server
	feed    *goldenFeed
	headers map[string]string
	// The stores the server reads, for a fixture that wires more of them (model.getAll).
	cache, sys *testkit.Redis
	now        func() time.Time
}

func goldenRedis(t testing.TB, entries map[string]goldenRedisEntry) *testkit.Redis {
	t.Helper()
	r := testkit.NewRedis()
	for key, e := range entries {
		switch {
		case e.Packed != "":
			b, err := base64.StdEncoding.DecodeString(e.Packed)
			if err != nil {
				t.Fatalf("redis %s: %v", key, err)
			}
			r.SetString(key, b)
		case e.Raw != nil:
			r.SetString(key, []byte(*e.Raw))
		case e.Hash != nil:
			r.SetHash(key, e.Hash)
		default:
			t.Fatalf("redis %s: no packed, raw or hash value", key)
		}
	}
	return r
}

// seedUncuratedShowcase writes, for a request with prioritizedUserIds and a modelVersionId (the one
// image.getInfinite shape that reads the version-showcase cache, getCarouselShowcaseIds), the entry
// getVersionShowcaseCache's lookup writes for an uncurated version, unless the fixture holds one: no
// fixture's world curates a showcase, so Node reads the version as uncurated.
func seedUncuratedShowcase(r *testkit.Redis, fx *goldenFixture) {
	if fx.Request.Input == "" {
		return
	}
	var in struct {
		JSON struct {
			ModelVersionID     int   `json:"modelVersionId"`
			PrioritizedUserIDs []int `json:"prioritizedUserIds"`
		} `json:"json"`
	}
	if err := json.Unmarshal([]byte(fx.Request.Input), &in); err != nil || in.JSON.ModelVersionID == 0 || len(in.JSON.PrioritizedUserIDs) == 0 {
		return
	}
	key := hydrate.KeyVersionShowcase + ":" + strconv.Itoa(in.JSON.ModelVersionID)
	if _, own := fx.Redis[key]; own {
		return
	}
	r.SetString(key, jspack.Pack(jspack.O("modelVersionId", in.JSON.ModelVersionID, "rows", []any{}, "community", []any{})))
}

func goldenSetup(t testing.TB, fx *goldenFixture) *goldenEnv {
	t.Helper()
	return goldenSetupMode(t, fx, false)
}

// goldenWrites is the write-back set of a golden mode: every cache with writeBack, none without.
func goldenWrites(writeBack bool) hydrate.WriteSet {
	if writeBack {
		return hydrate.AllWrites()
	}
	return nil
}

// goldenSetupMode builds the server as main does: misses computed (hydrate.MissCompute), written
// back only with writeBack.
func goldenSetupMode(t testing.TB, fx *goldenFixture, writeBack bool) *goldenEnv {
	t.Helper()
	now := fx.Now
	nowFn := func() time.Time { return now }

	cache := goldenRedis(t, fx.Redis)
	seedUncuratedShowcase(cache, fx)
	sys := goldenRedis(t, fx.SysRedis)
	db := newGoldenPG(fx)

	replies := map[string]goldenFeedReply{}
	for _, r := range fx.Feed {
		replies[r.Query] = r
	}
	fake := &goldenFeed{replies: replies, hits: map[string]int{}}
	feedSrv := httptest.NewServer(fake)
	t.Cleanup(feedSrv.Close)
	jwks, priv := goldenJWKS(t)

	packed := &hydrate.PackedReader{Redis: cache, Now: nowFn}
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: db, Compute: &hydrate.MissCompute{
		WriteBack:     goldenWrites(writeBack),
		FrameNegative: fx.Config.FrameCacheNegative,
		Now:           nowFn,
	}}
	if writeBack {
		sources.Compute.Primary = db // the fixture's one database (the frame and event lookups read the primary)
	}
	resolver := &auth.Resolver{
		Verifier:    &auth.Verifier{Issuer: goldenIssuer, JWKSURL: jwks.URL, HTTP: jwks.Client(), Now: nowFn},
		Revocation:  &auth.Revocation{Redis: sys},
		Sessions:    packed,
		CookieNames: auth.FixedCookieNames(goldenCookieName),
	}
	events := map[string]bool{}
	for _, e := range fx.Config.DecorationEvents {
		events[e] = true
	}
	queryCache := &feed.QueryCache{Redis: cache}
	blocked := &feed.BlockedTags{Cache: cache}
	deps := &feed.Deps{
		DB:       db,
		Cache:    queryCache,
		Hydrator: sources,
		Gallery:  &feed.GalleryStore{Cache: cache, DB: db},
		Addons:   &feed.AddonSource{Sys: sys},
		Feed:     &feedsvc.Client{BaseURL: feedSrv.URL, HTTP: feedSrv.Client()},
		Blocked:  blocked,
		Config: feed.Config{
			CreatorPromotions:       feed.ParsePromotionAudience(fx.Config.CreatorPromotions),
			LazyPostImages:          fx.Config.LazyPostImages,
			ImageIndexFeed:          fx.Config.ImageIndexFeed,
			VisibleDecorationEvents: events,
		},
		Now: nowFn,
	}
	// As main: the tag-ids computation's gate is the blocked list and addons the procedures read.
	sources.Compute.TagGate = feed.ImageTagGate(blocked, deps.Addons.Addons)
	v1 := &feed.V1Deps{
		Feed:    deps.Feed,
		Sources: sources,
		Gallery: deps.Gallery,
		Rows: func(ctx context.Context, q feed.ImagesQuery) ([]feed.RawImage, error) {
			return feed.FetchRows(ctx, db, queryCache, q.Build())
		},
		Addons:         deps.Addons.Addons,
		ImageLocation:  fx.Config.ImageLocation,
		NodeProduction: true,
		Now:            nowFn,
		Ports:          feed.V1Ports{ImageID: fx.Config.ServeV1ImageID, ModelOnly: fx.Config.ServeV1ModelOnly},
	}
	infinite := &feed.InfiniteDeps{Deps: deps, Sources: sources, Blocked: blocked,
		NewCreators: &feed.NewCreatorBoards{Cache: cache, Now: nowFn},
		Ports: feed.InfinitePorts{PublishedOnly: fx.Config.ServePublishedOnly, PostIDs: fx.Config.ServePostIDs,
			SortRandom: fx.Config.ServeSortRandom, GallerySettingsMiss: fx.Config.ServeGallerySettingsMiss,
			HubID: fx.Config.ServeHubID, JudgeScore: fx.Config.ServeJudgeScore, HatTurfIgnored: fx.Config.ServeHatTurfIgnored},
		RandomSeed:   &feed.RandomSeed{Sys: sys},
		GalleryHolds: sources}
	s := &Server{Resolver: resolver, Deps: deps, Hosts: goldenHosts, HostPrimaries: goldenPrimaries, V1: v1, Infinite: infinite}
	if fx.Config.UserHubs != "" {
		s.UserHubs = goldenUserHubs(fx.Config.UserHubs)
	}

	headers := map[string]string{}
	for k, v := range fx.Request.Headers {
		headers[k] = v
	}
	if fx.Request.Session != nil {
		headers["cookie"] = goldenCookieName + "=" + goldenToken(t, priv, fx.Request.Session.UserID, now)
	}
	return &goldenEnv{server: s, feed: fake, headers: headers, cache: cache, sys: sys, now: nowFn}
}

// --- loading and running --------------------------------------------------------------------------

// goldenFiles lists a fixture directory, and fails when it holds fewer fixtures than gen.mjs writes.
func goldenFiles(t testing.TB, sub string, min int) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(goldenDir, sub, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < min {
		t.Fatalf("%s: %d fixtures, want at least %d (did the glob match nothing?)", sub, len(files), min)
	}
	sort.Strings(files)
	return files
}

func goldenLoad(t testing.TB, path string) *goldenFixture {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // G304: path is a fixture from the testdata glob
	if err != nil {
		t.Fatal(err)
	}
	fx := &goldenFixture{}
	if err := json.Unmarshal(raw, fx); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	if fx.Name == "" || fx.Now.IsZero() {
		t.Fatalf("%s: a fixture needs a name and a now", path)
	}
	if fx.Expect.Fallback == "" && len(fx.Expect.Envelope) == 0 && len(fx.Expect.Body) == 0 {
		t.Fatalf("%s: a fixture expects a fallback or an answer", path)
	}
	return fx
}

// goldenReport fails the test on a comparison that does not match, naming every differing path.
func goldenReport(t *testing.T, rep *shadow.Report, goPayload []byte) {
	t.Helper()
	if rep.Match {
		return
	}
	paths := make([]string, 0, len(rep.Diffs))
	for _, d := range rep.Diffs {
		paths = append(paths, d.Kind+": "+d.Path)
	}
	t.Errorf("feed-go's answer differs from Node's (%d paths, truncated=%v):\n  %s", len(rep.Diffs), rep.Truncated, strings.Join(paths, "\n  "))
	const max = 60000
	if len(goPayload) > max {
		goPayload = goPayload[:max]
	}
	t.Logf("feed-go payload: %s", goPayload)
}

// goldenUndefinedWritten checks the BYTES the decoded comparison cannot see: for every path Node's
// envelope annotates ["undefined"], feed-go's json must hold that key with a literal null, as
// superjson's walker writes it (undefined -> null before JSON.stringify), not omit it. Both decode
// to the same object, so shadow.Compare matches either way. It returns the paths it checked and one
// problem per path feed-go omitted or wrote as something else.
func goldenUndefinedWritten(goPayload, nodeEnvelope []byte) (checked int, problems []string) {
	var node struct {
		Meta struct {
			Values json.RawMessage `json:"values"`
		} `json:"meta"`
	}
	var goEnv struct {
		JSON any `json:"json"`
	}
	if err := json.Unmarshal(nodeEnvelope, &node); err != nil {
		return 0, []string{"node envelope: " + err.Error()}
	}
	if err := json.Unmarshal(goPayload, &goEnv); err != nil {
		return 0, []string{"feed-go envelope: " + err.Error()}
	}
	var values map[string][]string
	if len(node.Meta.Values) == 0 || json.Unmarshal(node.Meta.Values, &values) != nil {
		return 0, nil // no annotations, or a root annotation (a bare array): no member to check
	}
	paths := make([]string, 0, len(values))
	for p, typ := range values {
		if len(typ) == 1 && typ[0] == "undefined" {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	for _, p := range paths {
		checked++
		if problem := goldenNullAt(goEnv.JSON, p); problem != "" {
			problems = append(problems, p+": "+problem)
		}
	}
	return checked, problems
}

// The instrument behind goldenUndefinedWritten, validated both ways. Negative control: the bytes this
// service wrote before 0.0.51 (the member omitted, the annotation kept) and a value where Node has
// null must be reported. Positive control: the Node fixtures do carry ["undefined"] members (a
// checker that never finds one would pass anything), and Node's own envelope passes its own check.
func TestGoldenUndefinedWrittenInstrument(t *testing.T) {
	node := []byte(`{"json":{"items":[{"id":1,"a.b":null}],"nextCursor":null},` +
		`"meta":{"values":{"items.0.a\\.b":["undefined"],"nextCursor":["undefined"]},"v":1}}`)
	if n, problems := goldenUndefinedWritten(node, node); n != 2 || len(problems) != 0 {
		t.Fatalf("Node's bytes: checked %d, problems %v; want 2, none", n, problems)
	}
	omitted := []byte(`{"json":{"items":[{"id":1}]},"meta":{"values":{"items.0.a\\.b":["undefined"],"nextCursor":["undefined"]},"v":1}}`)
	_, problems := goldenUndefinedWritten(omitted, node)
	if want := []string{"items.0.a\\.b: omitted, want null", "nextCursor: omitted, want null"}; !reflect.DeepEqual(problems, want) {
		t.Fatalf("omitted members: problems %q, want %q", problems, want)
	}
	valued := []byte(`{"json":{"items":[{"id":1,"a.b":3}],"nextCursor":null}}`)
	if _, problems := goldenUndefinedWritten(valued, node); len(problems) != 1 || problems[0] != "items.0.a\\.b: 3, want null" {
		t.Fatalf("a value where Node has null: problems %q", problems)
	}
	total := 0
	for _, dir := range []string{"as-posts", "infinite", "model-getall"} {
		for _, path := range goldenFiles(t, dir, 1) {
			fx := goldenLoad(t, path)
			if len(fx.Expect.Envelope) == 0 {
				continue
			}
			n, problems := goldenUndefinedWritten(fx.Expect.Envelope, fx.Expect.Envelope)
			if len(problems) != 0 {
				t.Errorf("%s: Node's own envelope fails the check: %v", fx.Name, problems)
			}
			total += n
		}
	}
	if total == 0 {
		t.Fatal("no Node fixture annotates an undefined member: the golden check would observe nothing")
	}
}

// goldenNullAt is "" when the superjson path p names a member or element of v that holds null, else
// what is there instead.
func goldenNullAt(v any, p string) string {
	cur := v
	for _, seg := range goldenParsePath(p) {
		switch t := cur.(type) {
		case map[string]any:
			next, ok := t[seg]
			if !ok {
				return "omitted, want null"
			}
			cur = next
		case []any:
			n, err := strconv.Atoi(seg)
			if err != nil || n < 0 || n >= len(t) {
				return "no such array element"
			}
			cur = t[n]
		default:
			return fmt.Sprintf("parent %v is not an object or array", cur)
		}
	}
	if cur != nil {
		return fmt.Sprintf("%v, want null", cur)
	}
	return ""
}

// goldenParsePath is superjson's parsePath: segments split on an unescaped ".", a backslash taking
// the next character literally (escapeKey writes `\.` for "." and `\\` for a backslash).
func goldenParsePath(p string) []string {
	var out []string
	var seg strings.Builder
	for i := 0; i < len(p); i++ {
		switch c := p[i]; {
		case c == '\\' && i+1 < len(p):
			i++
			seg.WriteByte(p[i])
		case c == '.':
			out = append(out, seg.String())
			seg.Reset()
		default:
			seg.WriteByte(c)
		}
	}
	return append(out, seg.String())
}

// goldenCacheState is every key of the fake cache: its value (string bytes, or a hash as sorted
// field=value lines) and expiry.
func goldenCacheState(r *testkit.Redis) map[string]string {
	out := map[string]string{}
	for _, k := range r.AllKeys() {
		v := ""
		if b, ok := r.String(k); ok {
			v = "string:" + base64.StdEncoding.EncodeToString(b)
		} else if h := r.Hash(k); h != nil {
			fields := make([]string, 0, len(h))
			for f, x := range h {
				fields = append(fields, f+"="+x)
			}
			sort.Strings(fields)
			v = "hash:" + strings.Join(fields, "\n")
		}
		out[k] = v + " ex:" + r.Expiry(k).String()
	}
	return out
}

// goldenWriteProblems compares what the computation changed in the cache with what Node writes on
// the fixture's misses: nothing at all with write-back off, exactly expect.writes with it on. Each
// difference is one problem.
func goldenWriteProblems(fx *goldenFixture, before, after map[string]string, writeBack bool) []string {
	var problems []string
	want := map[string]string{}
	if writeBack {
		for k, w := range fx.Expect.Writes {
			want[k] = "string:" + w.Packed + " ex:" + (time.Duration(w.EX) * time.Second).String()
		}
	}
	got := map[string]string{}
	for k, v := range after {
		if before[k] != v {
			got[k] = v
		}
	}
	for k := range before {
		if _, ok := after[k]; !ok {
			got[k] = "(deleted)"
		}
	}
	for k, v := range want {
		if got[k] != v {
			problems = append(problems, fmt.Sprintf("write-back %v: %s = %q, want Node's %q", writeBack, k, got[k], v))
		}
	}
	for k, v := range got {
		if _, ok := want[k]; !ok {
			problems = append(problems, fmt.Sprintf("write-back %v: wrote %s = %q, which Node does not write", writeBack, k, v))
		}
	}
	sort.Strings(problems)
	return problems
}

func goldenRunAsPosts(t *testing.T, fx *goldenFixture) {
	for _, writeBack := range []bool{false, true} {
		t.Run(map[bool]string{false: "writeback-off", true: "writeback-on"}[writeBack], func(t *testing.T) {
			goldenRunAsPostsMode(t, fx, writeBack)
		})
	}
}

func goldenRunAsPostsMode(t *testing.T, fx *goldenFixture, writeBack bool) {
	env := goldenSetupMode(t, fx, writeBack)
	before := goldenCacheState(env.cache)
	ctx := context.Background()
	r, err := SyntheticRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	c, err := env.server.compute(ctx, r)
	if want := fx.Expect.Fallback; want != "" {
		if err == nil {
			t.Fatalf("served; want fallback %q", want)
		}
		if got := fallback.Reason(err); got != want {
			t.Fatalf("fallback reason %q (%v), want %q", got, err, want)
		}
		env.feed.check(t, false)
		return
	}
	if err != nil {
		t.Fatalf("compute: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	rep, err := shadow.Compare(c.payload, fx.Expect.Envelope)
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	goldenReport(t, rep, c.payload)
	if _, problems := goldenUndefinedWritten(c.payload, fx.Expect.Envelope); len(problems) > 0 {
		t.Errorf("undefined members not written as Node writes them:\n  %s", strings.Join(problems, "\n  "))
	}
	for _, p := range goldenWriteProblems(fx, before, goldenCacheState(env.cache), writeBack) {
		t.Error(p)
	}
	if fx.Expect.Cacheable != nil {
		if *fx.Expect.Cacheable && c.ttl == nil {
			t.Error("signed out: want the public cache TTL, got none")
		}
		if !*fx.Expect.Cacheable && c.ttl != nil {
			t.Errorf("a session user: want no cache TTL, got %+v", *c.ttl)
		}
	}
	env.feed.check(t, true)
}

func goldenRunV1(t *testing.T, fx *goldenFixture) {
	env := goldenSetup(t, fx)
	ctx := context.Background()
	r, err := SyntheticV1Request(ctx, ShadowRequest{Input: fx.Request.Query, Path: fx.Request.Path, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	c, err := env.server.computeV1(ctx, r)
	if want := fx.Expect.Fallback; want != "" {
		if err == nil {
			t.Fatalf("served; want fallback %q", want)
		}
		if got := fallback.Reason(err); got != want {
			t.Fatalf("fallback reason %q (%v), want %q", got, err, want)
		}
		env.feed.check(t, false)
		return
	}
	if err != nil {
		t.Fatalf("computeV1: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	rep, err := shadow.CompareJSON(c.payload, fx.Expect.Body)
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	goldenReport(t, rep, c.payload)
	env.feed.check(t, true)
}

// goldenRunInfinite runs a fixture with write-back off and on, as goldenRunAsPosts: the procedure
// shares the page hydrator, so its cache misses are computed and written the same way.
func goldenRunInfinite(t *testing.T, fx *goldenFixture) {
	for _, writeBack := range []bool{false, true} {
		t.Run(map[bool]string{false: "writeback-off", true: "writeback-on"}[writeBack], func(t *testing.T) {
			goldenRunInfiniteMode(t, fx, writeBack)
		})
	}
}

func goldenRunInfiniteMode(t *testing.T, fx *goldenFixture, writeBack bool) {
	env := goldenSetupMode(t, fx, writeBack)
	before := goldenCacheState(env.cache)
	ctx := context.Background()
	r, err := SyntheticInfiniteRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	c, err := env.server.computeInfinite(ctx, r)
	if want := fx.Expect.Fallback; want != "" {
		if err == nil {
			t.Fatalf("served; want fallback %q", want)
		}
		if got := fallback.Reason(err); got != want {
			t.Fatalf("fallback reason %q (%v), want %q", got, err, want)
		}
		env.feed.check(t, false)
		return
	}
	if err != nil {
		t.Fatalf("computeInfinite: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	rep, err := shadow.Compare(c.payload, fx.Expect.Envelope)
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	goldenReport(t, rep, c.payload)
	if _, problems := goldenUndefinedWritten(c.payload, fx.Expect.Envelope); len(problems) > 0 {
		t.Errorf("undefined members not written as Node writes them:\n  %s", strings.Join(problems, "\n  "))
	}
	for _, p := range goldenWriteProblems(fx, before, goldenCacheState(env.cache), writeBack) {
		t.Error(p)
	}
	// createContext's policy: the public TTL when signed out, unless the answer depends on the viewer.
	if fx.Expect.Cacheable == nil {
		t.Fatal("an image.getInfinite fixture without expect.cacheable")
	}
	if *fx.Expect.Cacheable && (c.ttl == nil || *c.ttl != trpc.SignedOutTTL) {
		t.Errorf("signed out: want the public cache TTL %+v, got %v", trpc.SignedOutTTL, c.ttl)
	}
	if !*fx.Expect.Cacheable && c.ttl != nil {
		t.Errorf("signed in, or a viewer-scoped input: want no cache TTL, got %+v", *c.ttl)
	}
	env.feed.check(t, true)
}

// --- model.getAll --------------------------------------------------------------------------------

// goldenModelPG is a model-getall fixture's Postgres: the page query answered page by page from the
// fixture (each page asserted to carry the cursor Node sent for it), and the lookups Node made.
type goldenModelPG struct {
	*testkit.DB
	mu    sync.Mutex
	pages int
	// collectionReads counts the collection permission reads; followReads the follow-list reads.
	collectionReads int
	followReads     int
}

func newGoldenModelPG(t testing.TB, fx *goldenFixture) *goldenModelPG {
	db := &fx.DB
	g := &goldenModelPG{}
	g.DB = &testkit.DB{Routes: []testkit.Route{
		// The version showcase miss lookup: the fixtures record no showcase rows (only the cache
		// entries Node read), so it fails rather than answer the cover-image route below.
		{Match: `AS full_mv(id)`, Rows: func(_ []any) (*testkit.Rows, error) {
			return nil, errors.New("golden: the fixture records no showcase rows")
		}},
		{Match: `"cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			g.mu.Lock()
			defer g.mu.Unlock()
			if g.pages >= len(db.ModelPages) {
				return nil, fmt.Errorf("golden: page query %d, the fixture lists %d", g.pages+1, len(db.ModelPages))
			}
			page := db.ModelPages[g.pages]
			g.pages++
			if page.Cursor == nil {
				if strings.Contains(sql, "UNION ALL") || strings.Contains(sql, ") OR (") {
					return nil, fmt.Errorf("golden: page %d has no cursor in Node, feed-go sent one", g.pages)
				}
			} else if err := goldenCheckBound(*page.Cursor, page.Bound, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckCollectionFilter(page.Collection, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckIDFilter("onlyModelIds", goldenReOnlyIDs, page.OnlyModelIDs, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckIDFilter("excludeModelIds", goldenReExcludeIDs, page.ExcludeModelIDs, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckIDFilter("ids", goldenReInputIDs, page.IDs, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckIDFilter("followedUserIds", goldenReModelFollowed, page.FollowedUserIDs, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			if err := goldenCheckIDFilter("newCreatorUserIds", goldenReNewCreators, page.NewCreatorUserIDs, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			// `1 = 0` is the followed-nobody clause and the empty board's: Node's count of them, in
			// every keyset branch of the query.
			branches := 1
			if strings.Contains(sql, "UNION ALL") {
				branches = 2
			}
			want := 0
			for _, none := range []bool{page.FollowedNone, page.NewCreatorsNone} {
				if none {
					want += branches
				}
			}
			if got := strings.Count(sql, "1 = 0"); got != want {
				return nil, fmt.Errorf("golden: page %d: node's `1 = 0` clauses (followed nobody %v, an empty board %v) appear %d time(s), feed-go's %d",
					g.pages, page.FollowedNone, page.NewCreatorsNone, want, got)
			}
			if err := goldenCheckPublished(page.Published, sql, args); err != nil {
				return nil, fmt.Errorf("golden: page %d: %w", g.pages, err)
			}
			rows := make([][]any, len(page.Rows))
			for i, r := range page.Rows {
				rows[i] = r.row()
			}
			return testkit.NewRows(goldenModelColumns, rows...), nil
		}},
		// dataForModelsCache's lookup (hydrate.MissCompute): the fixture's version rows and hashes of
		// the ids asked, in the order recorded.
		{Match: `"RecommendedResource"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, v := range db.ModelDataVersions {
				if goldenHas(goldenInts(args[0]), v.ModelID) {
					rows = append(rows, v.row())
				}
			}
			return testkit.NewRows(goldenModelVersionColumns, rows...), nil
		}},
		{Match: `FROM "ModelHash"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, h := range db.ModelHashes {
				if goldenHas(goldenInts(args[0]), h.ModelID) {
					rows = append(rows, []any{int64(h.ModelID), h.Hash})
				}
			}
			return testkit.NewRows([]string{"modelId", "hash"}, rows...), nil
		}},
		// getOfficialModelIds' fetchFn: only a copy whose official-models entry was emptied reads it
		// (probe_test.go), from the fixture's official rows.
		{Match: `"isOfficial" = true`, Rows: func(_ []any) (*testkit.Rows, error) {
			rows := make([][]any, 0, len(db.OfficialModels))
			for _, m := range db.OfficialModels {
				rows = append(rows, []any{int64(m.ID), m.Type})
			}
			return testkit.NewRows([]string{"id", "type"}, rows...), nil
		}},
		// modelTagCache's lookup.
		{Match: `SELECT "modelId", "tagId" FROM "TagsOnModels"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, r := range db.TagsOnModels {
				if goldenHas(goldenInts(args[0]), r.ModelID) {
					rows = append(rows, []any{int64(r.ModelID), int64(r.TagID)})
				}
			}
			return testkit.NewRows([]string{"modelId", "tagId"}, rows...), nil
		}},
		{Match: `GROUP BY mv."modelId"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, p := range db.PaidAccess {
				if goldenHas(goldenInts(args[0]), p.ModelID) {
					rows = append(rows, []any{p.ModelID, goldenTimeVal(p.Deadline), p.VersionIDs})
				}
			}
			return testkit.NewRows([]string{"modelId", "deadline", "versionIds"}, rows...), nil
		}},
		{Match: `FROM "Image" i`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, c := range db.CoverImages {
				if goldenHas(goldenInts(args[0]), c.ID) {
					rows = append(rows, []any{c.ID, c.UserID, c.ModelVersionID, c.ModelID})
				}
			}
			return testkit.NewRows([]string{"id", "userId", "modelVersionId", "modelId"}, rows...), nil
		}},
		// The community-cover guard's read (getShowcaseCommunityCovers' first query): no fixture's
		// world features a community image in a showcase, so it finds no row, and Node's
		// withCommunityCovers found none either.
		{Match: `FROM "ModelVersionShowcaseItem" s`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"modelId", "imageId"}), nil
		}},
		// userCosmeticCache's lookup (a cold-user-cosmetics fixture): the owners' equipped cosmetics not
		// equipped to an entity, then the creator-made check of withheldCosmeticIDs (the fixtures'
		// cosmetics have no creator, so its rows are none).
		{Match: `FROM "UserCosmetic" WHERE "userId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, r := range db.UserCosmetics {
				if goldenHas(goldenInts(args[0]), r.UserID) && r.Equipped && r.EquippedToID == nil {
					rows = append(rows, []any{r.UserID, r.CosmeticID, goldenPtr(r.Data)})
				}
			}
			return testkit.NewRows([]string{"userId", "cosmeticId", "data"}, rows...), nil
		}},
		{Match: `FROM "CosmeticShopItem" si`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"cosmeticId", "addedById", "status", "meta", "rejectionReason", "createdById"}), nil
		}},
		{Match: `SELECT id, flags FROM "Cosmetic"`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"id", "flags"}), nil
		}},
		// `followed`'s read of the viewer's Follow rows (hydrate.Sources.FollowedUserIDs).
		{Match: `FROM "UserEngagement"`, Rows: func(args []any) (*testkit.Rows, error) {
			g.mu.Lock()
			g.followReads++
			g.mu.Unlock()
			var rows [][]any
			for _, f := range db.UserFollows {
				if goldenHas(goldenInts(args[0]), f.UserID) {
					rows = append(rows, []any{int64(f.UserID), int64(f.TargetUserID)})
				}
			}
			return testkit.NewRows([]string{"userId", "targetUserId"}, rows...), nil
		}},
		// getValidCreatorMembershipMap's origin (a cold membership key): the fixture's subscription rows
		// of the ids asked.
		{Match: `FROM "CustomerSubscription" cs`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, r := range db.Subscriptions {
				if goldenHas(goldenInts(args[0]), r.UserID) {
					rows = append(rows, []any{int64(r.UserID), r.Metadata, r.ProductMetadata})
				}
			}
			return testkit.NewRows([]string{"userId", "metadata", "productMetadata"}, rows...), nil
		}},
		// The collection permission read: the fixture's Collection row and the viewer's contributor
		// row (none: no permissions); a collection the fixture does not hold is no row.
		{Match: `FROM "Collection" c`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			g.mu.Lock()
			g.collectionReads++
			g.mu.Unlock()
			cols := []string{"read", "userId", "permissions"}
			viewer := 0
			if len(args) > 1 {
				viewer = args[1].(int)
			}
			if (viewer != 0) != strings.Contains(sql, `"CollectionContributor"`) {
				return nil, fmt.Errorf("golden: the collection read joins the contributor row exactly for a viewer (viewer %d)", viewer)
			}
			for _, c := range db.Collections {
				if c.ID != args[0].(int) {
					continue
				}
				perms := []string{}
				for _, cc := range c.Contributors {
					if cc.UserID == viewer {
						perms = cc.Permissions
					}
				}
				return testkit.NewRows(cols, []any{c.Read, c.UserID, perms}), nil
			}
			return testkit.NewRows(cols), nil
		}},
		// Tag.name and User.username are citext.
		{Match: `SELECT id FROM "Tag" WHERE name = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, tag := range db.Tags {
				if strings.EqualFold(tag.Name, fmt.Sprint(args[0])) {
					return testkit.NewRows([]string{"id"}, []any{tag.ID}), nil
				}
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
		{Match: `SELECT id FROM "User" WHERE username = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, c := range db.Creators {
				if strings.EqualFold(c.Username, fmt.Sprint(args[0])) {
					return testkit.NewRows([]string{"id"}, []any{c.ID}), nil
				}
			}
			return testkit.NewRows([]string{"id"}), nil
		}},
		// The metric-privacy defaults of an owner Node did not read (feed-go reads every row's owner,
		// Node only the shown models'): no row, nothing hidden.
		{Match: `settings->'hideModelBuzz'`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"id", "hideModelBuzz", "hideModelDownloads", "hideModelGenerations"}), nil
		}},
		// The model frame and decoration miss lookups (hydrate.MissCompute), over the fixture's placed
		// cosmetics.
		{Match: `jsonb_typeof(c.data->'event') IS DISTINCT FROM 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			return goldenEntityCosmetics(db, sql, args, false, goldenFrameColumns)
		}},
		{Match: `jsonb_typeof(c.data->'event') = 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			return goldenEntityCosmetics(db, sql, args, true, []string{"cosmeticId", "equippedToId", "userId"})
		}},
	}}
	g.Routes = append(g.Routes, goldenTagRoutes(db)...)
	t.Cleanup(func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if !t.Failed() && fx.Expect.Fallback == "" && g.pages != len(db.ModelPages) {
			t.Errorf("feed-go asked for %d page(s); Node asked for %d", g.pages, len(db.ModelPages))
		}
		// Node reads the collection permission on every getModelsRaw call: once per page it queries,
		// and once for an unreadable collection, which queries no page.
		if !t.Failed() && fx.Expect.Fallback == "" && db.Collections != nil {
			if want := max(len(db.ModelPages), 1); g.collectionReads != want {
				t.Errorf("feed-go read the collection permission %d time(s); Node read it %d", g.collectionReads, want)
			}
		}
		// Node reads a signed-in viewer's follows on every getModelsRaw call, and never otherwise.
		if !t.Failed() && fx.Expect.Fallback == "" && g.followReads != db.FollowsRead {
			t.Errorf("feed-go read the viewer's follows %d time(s); Node read them %d", g.followReads, db.FollowsRead)
		}
	})
	return g
}

// goldenCheckBound checks that every value Node's parseCursor bound for a cursor — the instant a
// timestamp token reads as, or the integer — is among the page query's arguments. It compares
// values, not cursor text: a token both sides receive but read as different instants (".25" as
// 250 ms or as 25 ms) is a mismatch here.
func goldenCheckBound(cursor string, bound []json.RawMessage, args []any) error {
	if n := len(strings.Split(cursor, "|")); len(bound) != n {
		return fmt.Errorf("the fixture records %d bound value(s) for cursor %q, which has %d token(s)", len(bound), cursor, n)
	}
	have := map[string]bool{}
	for _, a := range args {
		if tm, ok := a.(time.Time); ok {
			have["date:"+tm.UTC().Format("2006-01-02T15:04:05.000Z")] = true
		} else {
			have[fmt.Sprint(a)] = true
		}
	}
	for i, raw := range bound {
		var date struct {
			Date *string `json:"$date"`
		}
		var key string
		if json.Unmarshal(raw, &date) == nil && date.Date != nil {
			key = "date:" + *date.Date
		} else {
			var n int64
			if err := json.Unmarshal(raw, &n); err != nil {
				return fmt.Errorf("bound value %d of cursor %q: %s is neither an instant nor an integer", i, cursor, raw)
			}
			key = strconv.FormatInt(n, 10)
		}
		if !have[key] {
			return fmt.Errorf("node binds %s for token %d of cursor %q; feed-go's arguments are %v", key, i, cursor, args)
		}
	}
	return nil
}

// goldenCollectionFilter is a model-getall page's CollectionItem semi-join as Node bound it.
type goldenCollectionFilter struct {
	CollectionID int  `json:"collectionId"`
	AddedByID    *int `json:"addedById"`
	TagID        *int `json:"tagId"`
}

// goldenCollectionClauses are the CollectionItem semi-join's bound comparisons, each capturing the
// placeholder it binds.
var goldenCollectionClauses = []struct {
	name string
	re   *regexp.Regexp
	want func(*goldenCollectionFilter) *int
}{
	{`ci."collectionId"`, regexp.MustCompile(`ci\."collectionId" = \$(\d+)`), func(f *goldenCollectionFilter) *int { return &f.CollectionID }},
	{`ci."addedById"`, regexp.MustCompile(`ci\."addedById" = \$(\d+)`), func(f *goldenCollectionFilter) *int { return f.AddedByID }},
	{`ci."tagId"`, regexp.MustCompile(`ci\."tagId" = \$(\d+)`), func(f *goldenCollectionFilter) *int { return f.TagID }},
}

// goldenCheckCollectionFilter checks a page query against the CollectionItem semi-join Node built for
// the page: no collection clause where Node had none, and otherwise each value Node bound (the
// collection, the viewer's in-review carve-out, the collection tag) at the placeholder of the
// clause that binds it in feed-go's query, with no carve-out or tag clause where Node had none.
func goldenCheckCollectionFilter(want *goldenCollectionFilter, sql string, args []any) error {
	for _, c := range goldenCollectionClauses {
		m := c.re.FindAllStringSubmatch(sql, -1)
		var v *int
		if want != nil {
			v = c.want(want)
		}
		switch {
		case want == nil && len(m) > 0:
			return fmt.Errorf("node filters by no collection; feed-go's page query has %s", m[0][0])
		case v == nil && len(m) > 0:
			return fmt.Errorf("node's collection filter has no %s; feed-go's has %s", c.name, m[0][0])
		case v == nil:
			continue
		case len(m) == 0:
			return fmt.Errorf("node's collection filter binds %s = %d; feed-go's page query has no such clause", c.name, *v)
		}
		// A cursor page repeats the WHERE in each keyset branch: every copy must bind Node's value.
		for _, mm := range m {
			n, err := strconv.Atoi(mm[1])
			if err != nil || n < 1 || n > len(args) {
				return fmt.Errorf("feed-go's %s has placeholder $%s; its query has %d argument(s)", c.name, mm[1], len(args))
			}
			if got, ok := args[n-1].(int); !ok || got != *v {
				return fmt.Errorf("node binds %s = %d; feed-go binds $%d = %v", c.name, *v, n, args[n-1])
			}
		}
	}
	return nil
}

// goldenReOnlyIDs / goldenReExcludeIDs find the official pin's id filters in a page query.
var (
	goldenReOnlyIDs    = regexp.MustCompile(`mm\."modelId" = ANY\(\$(\d+)::int\[\]\)`)
	goldenReExcludeIDs = regexp.MustCompile(`mm\."modelId" != ALL\(\$(\d+)::int\[\]\)`)
	// goldenReInputIDs finds the `ids` filter, goldenReModelFollowed a signed-in `followed`'s follow list.
	goldenReInputIDs      = regexp.MustCompile(`mm\."modelId" = ANY\(\$(\d+)::integer\[\]\)`)
	goldenReModelFollowed = regexp.MustCompile(`mm\."userId" = ANY\(\$(\d+)::int\[\]\)`)
	// goldenReNewCreators finds the `newCreators` board filter (its `integer[]` cast keeps it apart
	// from `followed`'s).
	goldenReNewCreators = regexp.MustCompile(`mm\."userId" = ANY\(\$(\d+)::integer\[\]\)`)
)

// goldenPublishedClauses are a published range's bound comparisons, each capturing the placeholder it
// binds and whether it is the range's start (gte) or its end (lt): the WHERE's two, and the `ranged`
// CTE's pair.
var goldenPublishedClauses = []struct {
	name  string
	re    *regexp.Regexp
	start bool
}{
	{`m."publishedAt" >=`, regexp.MustCompile(`m\."publishedAt" >= \$(\d+)`), true},
	{`m."publishedAt" <`, regexp.MustCompile(`m\."publishedAt" < \$(\d+)`), false},
	{`ranged "publishedAt" >=`, regexp.MustCompile(`ranged AS MATERIALIZED \(\s*SELECT "id" FROM "Model"\s+WHERE [^)]*?"publishedAt" >= \$(\d+)`), true},
	{`ranged "publishedAt" <`, regexp.MustCompile(`ranged AS MATERIALIZED \(\s*SELECT "id" FROM "Model"\s+WHERE [^)]*?"publishedAt" < \$(\d+)`), false},
}

// goldenCheckPublished checks a page query against the published range Node bound: no bound clause,
// CTE or join where Node had no range; otherwise every copy of each bound clause binds Node's instant,
// the CTE leads the statement and the page joins it.
func goldenCheckPublished(want *struct {
	Gte goldenTime `json:"gte"`
	Lt  goldenTime `json:"lt"`
}, sql string, args []any) error {
	const join = `JOIN ranged ON ranged."id" = m."id"`
	if want == nil {
		for _, c := range goldenPublishedClauses {
			if m := c.re.FindString(sql); m != "" {
				return fmt.Errorf("node binds no published range; feed-go's page query has %s", m)
			}
		}
		if strings.Contains(sql, "ranged") {
			return errors.New("node builds no ranged CTE; feed-go's page query has one")
		}
		return nil
	}
	if want.Gte.T == nil || want.Lt.T == nil {
		return errors.New("the fixture records a published range without both bounds")
	}
	if !strings.HasPrefix(strings.TrimSpace(sql), "WITH ranged AS MATERIALIZED (") {
		return fmt.Errorf("node's statement starts with the ranged CTE; feed-go's starts %.40q", strings.TrimSpace(sql))
	}
	branches := 1
	if strings.Contains(sql, "UNION ALL") {
		branches = 2
	}
	if n := strings.Count(sql, join); n != branches {
		return fmt.Errorf("node joins the ranged CTE in each of %d branch(es); feed-go's page query does %d time(s)", branches, n)
	}
	for _, c := range goldenPublishedClauses {
		m := c.re.FindAllStringSubmatch(sql, -1)
		if len(m) == 0 {
			return fmt.Errorf("node binds %s; feed-go's page query has no such clause", c.name)
		}
		wantT := *want.Lt.T
		if c.start {
			wantT = *want.Gte.T
		}
		for _, mm := range m {
			n, err := strconv.Atoi(mm[1])
			if err != nil || n < 1 || n > len(args) {
				return fmt.Errorf("feed-go's %s has placeholder $%s; its query has %d argument(s)", c.name, mm[1], len(args))
			}
			if got, ok := args[n-1].(time.Time); !ok || !got.Equal(wantT) {
				return fmt.Errorf("node binds %s %s; feed-go binds $%d = %v", c.name, wantT.Format(time.RFC3339Nano), n, args[n-1])
			}
		}
	}
	return nil
}

// goldenCheckIDFilter checks a page's id filter against what Node bound: none in Node, none in
// feed-go's query; else every copy of the clause (each keyset branch repeats the WHERE) binds exactly
// Node's ids, in Node's order.
func goldenCheckIDFilter(name string, re *regexp.Regexp, want []int, sql string, args []any) error {
	m := re.FindAllStringSubmatch(sql, -1)
	if len(want) == 0 {
		if len(m) > 0 {
			return fmt.Errorf("node binds no %s; feed-go's page query has one", name)
		}
		return nil
	}
	if len(m) == 0 {
		return fmt.Errorf("node binds %s %v; feed-go's page query has no such clause", name, want)
	}
	for _, mm := range m {
		n, err := strconv.Atoi(mm[1])
		if err != nil || n < 1 || n > len(args) {
			return fmt.Errorf("feed-go's %s has placeholder $%s; its query has %d argument(s)", name, mm[1], len(args))
		}
		if got := goldenInts(args[n-1]); !reflect.DeepEqual(got, want) {
			return fmt.Errorf("node binds %s %v; feed-go binds $%d = %v", name, want, n, args[n-1])
		}
	}
	return nil
}

// goldenComputeModels answers a model-getall fixture's request through computeModelGetAll over the
// fixture's caches and Postgres, with write-back off.
func goldenComputeModels(t *testing.T, fx *goldenFixture) (*computed, error) {
	t.Helper()
	c, _, err := goldenComputeModelsMode(t, fx, false)
	return c, err
}

// goldenComputeModelsMode is goldenComputeModels with write-back on or off; it also returns the cache
// before and after the request.
func goldenComputeModelsMode(t *testing.T, fx *goldenFixture, writeBack bool) (*computed, [2]map[string]string, error) {
	t.Helper()
	env := goldenSetupModelsMode(t, fx, writeBack)
	before := goldenCacheState(env.cache)
	ctx := context.Background()
	r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	c, err := env.server.computeModelGetAll(ctx, r)
	return c, [2]map[string]string{before, goldenCacheState(env.cache)}, err
}

// goldenSetupModels is goldenSetup with the model.getAll deps over the fixture's model tables
// (write-back off).
func goldenSetupModels(t testing.TB, fx *goldenFixture) *goldenEnv {
	t.Helper()
	return goldenSetupModelsMode(t, fx, false)
}

// goldenSetupModelsMode is goldenSetupModels with write-back on or off: on, the miss computation
// writes what it computes, and the one fixture database stands in for the primary.
func goldenSetupModelsMode(t testing.TB, fx *goldenFixture, writeBack bool) *goldenEnv {
	t.Helper()
	env := goldenSetup(t, fx)
	db := newGoldenModelPG(t, fx)
	events := map[string]bool{}
	for _, e := range fx.Config.DecorationEvents {
		events[e] = true
	}
	packed := &hydrate.PackedReader{Redis: env.cache, Now: env.now}
	addons := (&feed.AddonSource{Sys: env.sys}).Addons
	blocked := &feed.BlockedTags{Cache: env.cache}
	// As main: the model feed shares the miss computation.
	compute := &hydrate.MissCompute{FrameNegative: fx.Config.FrameCacheNegative, Now: env.now, TagGate: feed.ImageTagGate(blocked, addons),
		WriteBack: goldenWrites(writeBack), TierMetadataKey: "tier"}
	if writeBack {
		compute.Primary = db
	}
	if fx.Config.ComputeMissesOff {
		compute = nil
		env.server.Deps.Hydrator.(*hydrate.Sources).Compute = nil
	}
	env.server.Models = &modelfeed.Deps{
		DB:      db,
		Sources: &hydrate.Sources{Packed: packed, Cache: env.cache, Replica: db, Compute: compute},
		Gallery: &feed.GalleryStore{Cache: env.cache, DB: db},
		Addons:  addons,
		Blocked: blocked,
		Config: modelfeed.Config{
			BaseModelMetrics: fx.Config.BaseModelMetrics, ImagesSlim: fx.Config.ModelImagesSlim,
			CoverageNext: fx.Config.CoverageNext, LoadingOpenToAll: fx.Config.LoadingOpenToAll,
			VisibleDecorationEvents: events,
			Ports: modelfeed.Ports{IDs: fx.Config.ServeInputIDs, Followed: fx.Config.ServeInputFollowed, HidePaid: fx.Config.ServeHidePaid,
				VerifiedBot: fx.Config.ServeVerifiedBot, NewCreators: fx.Config.ServeInputNewCreators, PublishedRange: fx.Config.ServePublishedRange},
			ServeUserCosmeticsMiss: fx.Config.ServeUserCosmeticsMiss,
			ServeMembershipMiss:    fx.Config.ServeMembershipMiss,
		},
		// The "new & upcoming" boards' cached entries, read-only (as main wires them).
		NewCreators: &feed.NewCreatorBoards{Cache: env.cache, Now: env.now},
		Now:         env.now,
	}
	// gen-models.mjs models getModelsFeed with the personal-hot-lead flag off for every viewer.
	env.server.PersonalHotLead = &stubUserFlag{}
	return env
}

// goldenRunModels runs a fixture with write-back off and on, as goldenRunAsPosts: off, the cache must
// be untouched; on, it must change by exactly Node's writes (expect.writes).
func goldenRunModels(t *testing.T, fx *goldenFixture) {
	for _, writeBack := range []bool{false, true} {
		t.Run(map[bool]string{false: "writeback-off", true: "writeback-on"}[writeBack], func(t *testing.T) {
			goldenRunModelsMode(t, fx, writeBack)
		})
	}
}

func goldenRunModelsMode(t *testing.T, fx *goldenFixture, writeBack bool) {
	c, state, err := goldenComputeModelsMode(t, fx, writeBack)
	if want := fx.Expect.Fallback; want != "" {
		if err == nil {
			t.Fatalf("served; want fallback %q", want)
		}
		if got := fallback.Reason(err); got != want {
			t.Fatalf("fallback reason %q (%v), want %q", got, err, want)
		}
		return
	}
	if err != nil {
		t.Fatalf("computeModelGetAll: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	rep, err := shadow.Compare(c.payload, fx.Expect.Envelope)
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	goldenReport(t, rep, c.payload)
	if _, problems := goldenUndefinedWritten(c.payload, fx.Expect.Envelope); len(problems) > 0 {
		t.Errorf("undefined members not written as Node writes them:\n  %s", strings.Join(problems, "\n  "))
	}
	for _, p := range goldenWriteProblems(fx, state[0], state[1], writeBack) {
		t.Error(p)
	}
	// The cache policy computeModelGetAll documents (createContext's): the public TTL exactly when
	// there is no session and no verified crawler, none otherwise. A fixture sending headers records
	// Node's own answer (expect.cacheable); every other one is cacheable exactly when signed out.
	cacheable := fx.Request.Session == nil
	if fx.Expect.Cacheable != nil {
		cacheable = *fx.Expect.Cacheable
	}
	if cacheable && (c.ttl == nil || *c.ttl != trpc.SignedOutTTL) {
		t.Errorf("signed out: want the public cache TTL %+v, got %v", trpc.SignedOutTTL, c.ttl)
	}
	if !cacheable && c.ttl != nil {
		t.Errorf("a session or a verified crawler: want no cache TTL, got %+v", *c.ttl)
	}
	// The per-class shadow series count a signed-out answer as `anon` (a verified crawler's as
	// `crawler`, expect.viewerClass), a session's never.
	if want := fx.Expect.ViewerClass; want != "" {
		if c.viewerClass != want {
			t.Errorf("viewer class %q, want %q", c.viewerClass, want)
		}
	} else if fx.Request.Session == nil && c.viewerClass != FeedViewerAnon {
		t.Errorf("signed out: viewer class %q, want %q", c.viewerClass, FeedViewerAnon)
	}
	if fx.Request.Session != nil && (c.viewerClass == FeedViewerAnon || c.viewerClass == FeedViewerCrawler || c.viewerClass == "") {
		t.Errorf("a session: viewer class %q, want a session class", c.viewerClass)
	}
}

func TestGoldenModelGetAll(t *testing.T) {
	for _, path := range goldenFiles(t, "model-getall", goldenMinModels) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunModels(t, fx) })
	}
}

func TestGoldenAsPosts(t *testing.T) {
	for _, path := range goldenFiles(t, "as-posts", goldenMinAsPosts) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunAsPosts(t, fx) })
	}
}

func TestGoldenInfinite(t *testing.T) {
	for _, path := range goldenFiles(t, "infinite", goldenMinInfinite) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunInfinite(t, fx) })
	}
}

func TestGoldenV1Images(t *testing.T) {
	for _, path := range goldenFiles(t, "v1-images", goldenMinV1) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunV1(t, fx) })
	}
}

// goldenMutantID is the id the harness-can-fail subtests write into an expected answer; no
// fixture holds it, so the compare has to see the difference.
const goldenMutantID = 999999

// goldenSetPath replaces the value at a dotted path (array indices as numbers) in a JSON document
// with goldenMutantID.
func goldenSetPath(t *testing.T, doc json.RawMessage, path string) json.RawMessage {
	t.Helper()
	val := goldenMutantID
	var root any
	if err := json.Unmarshal(doc, &root); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(path, ".")
	cur := root
	for i, p := range parts {
		last := i == len(parts)-1
		switch node := cur.(type) {
		case map[string]any:
			if last {
				node[p] = val
			} else {
				cur = node[p]
			}
		case []any:
			n, err := strconv.Atoi(p)
			if err != nil || n >= len(node) {
				t.Fatalf("path %s: no element %s", path, p)
			}
			if last {
				node[n] = val
			} else {
				cur = node[n]
			}
		default:
			t.Fatalf("path %s: %s is not a container", path, p)
		}
	}
	out, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// TestGoldenHarnessCanFail is the harness's positive control: an expected answer with one image id
// changed must not match feed-go's answer (nor the fixture's own), so a golden pass is not a
// comparator that matches everything.
func TestGoldenHarnessCanFail(t *testing.T) {
	t.Run("as-posts", func(t *testing.T) {
		fx := goldenLoad(t, filepath.Join(goldenDir, "as-posts", "version-signed-out-most-reactions.json"))
		env := goldenSetup(t, fx)
		ctx := context.Background()
		r, err := SyntheticRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
		if err != nil {
			t.Fatal(err)
		}
		c, err := env.server.compute(ctx, r)
		if err != nil {
			t.Fatalf("compute: %v", err)
		}
		mutated := goldenSetPath(t, fx.Expect.Envelope, "json.items.0.images.0.id")
		for name, payload := range map[string][]byte{"feed-go": c.payload, "fixture": fx.Expect.Envelope} {
			rep, err := shadow.Compare(payload, mutated)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Match {
				t.Errorf("%s: a changed image id still matches", name)
			}
		}
	})
	t.Run("v1-images", func(t *testing.T) {
		fx := goldenLoad(t, filepath.Join(goldenDir, "v1-images", "signed-out-defaults.json"))
		env := goldenSetup(t, fx)
		ctx := context.Background()
		r, err := SyntheticV1Request(ctx, ShadowRequest{Input: fx.Request.Query, Path: fx.Request.Path, Headers: env.headers})
		if err != nil {
			t.Fatal(err)
		}
		c, err := env.server.computeV1(ctx, r)
		if err != nil {
			t.Fatalf("computeV1: %v", err)
		}
		mutated := goldenSetPath(t, fx.Expect.Body, "items.0.id")
		for name, payload := range map[string][]byte{"feed-go": c.payload, "fixture": fx.Expect.Body} {
			rep, err := shadow.CompareJSON(payload, mutated)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Match {
				t.Errorf("%s: a changed image id still matches", name)
			}
		}
	})
	t.Run("cache-writes", func(t *testing.T) {
		// The write check must see a write Node makes that feed-go does not, one it makes with another
		// expiry, and one Node does not make: each a problem, while the fixture's own run has none.
		fx := goldenLoad(t, filepath.Join(goldenDir, "as-posts", "cold-event-decoration.json"))
		if len(fx.Expect.Writes) != 2 {
			t.Fatalf("cold-event-decoration expects %d writes, want 2 (the control needs both)", len(fx.Expect.Writes))
		}
		env := goldenSetupMode(t, fx, true)
		before := goldenCacheState(env.cache)
		ctx := context.Background()
		r, err := SyntheticRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.server.compute(ctx, r); err != nil {
			t.Fatalf("compute: %v", err)
		}
		after := goldenCacheState(env.cache)
		if p := goldenWriteProblems(fx, before, after, true); len(p) != 0 {
			t.Fatalf("the fixture's own run: %v", p)
		}
		if p := goldenWriteProblems(fx, before, after, false); len(p) != 2 {
			t.Fatalf("write-back off over a run that wrote: %d problems %v, want 2", len(p), p)
		}
		changed := *fx
		changed.Expect.Writes = map[string]goldenWrite{}
		for k, w := range fx.Expect.Writes {
			w.EX++
			changed.Expect.Writes[k] = w
		}
		changed.Expect.Writes["packed:caches:never-written:1"] = goldenWrite{Packed: "AA==", EX: 1}
		if p := goldenWriteProblems(&changed, before, after, true); len(p) != 3 {
			t.Fatalf("changed expiries and an unwritten key: %d problems %v, want 3", len(p), p)
		}
	})
	t.Run("infinite", func(t *testing.T) {
		fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", "global-signed-out-most-reactions.json"))
		env := goldenSetup(t, fx)
		ctx := context.Background()
		r, err := SyntheticInfiniteRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
		if err != nil {
			t.Fatal(err)
		}
		c, err := env.server.computeInfinite(ctx, r)
		if err != nil {
			t.Fatalf("computeInfinite: %v", err)
		}
		mutated := goldenSetPath(t, fx.Expect.Envelope, "json.items.0.id")
		for name, payload := range map[string][]byte{"feed-go": c.payload, "fixture": fx.Expect.Envelope} {
			rep, err := shadow.Compare(payload, mutated)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Match {
				t.Errorf("%s: a changed image id still matches", name)
			}
			if got := shadow.ClassifyFlat(rep, payload, mutated); got != "membership" {
				t.Errorf("%s: a changed image id classifies %q, want membership", name, got)
			}
		}
	})
	t.Run("model-getall", func(t *testing.T) {
		fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "highest-rated-signed-out.json"))
		mutated := goldenSetPath(t, fx.Expect.Envelope, "json.items.0.images.0.id")
		fx.Expect.Envelope = mutated
		// The harness must report the mismatch: run the comparison as goldenRunModels does.
		c, err := goldenComputeModels(t, fx)
		if err != nil {
			t.Fatalf("computeModelGetAll: %v", err)
		}
		rep, err := shadow.Compare(c.payload, mutated)
		if err != nil {
			t.Fatal(err)
		}
		if rep.Match {
			t.Error("feed-go: a changed image id still matches")
		}
	})
	t.Run("model-getall-bound-cursor", func(t *testing.T) {
		// The page query must be checked by the VALUE bound, not the cursor text: record the instant
		// Node would bind for a misread fraction and the fake Postgres has to refuse feed-go's.
		fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "newest-timestamp-cursor.json"))
		if len(fx.DB.ModelPages) == 0 || len(fx.DB.ModelPages[0].Bound) != 2 {
			t.Fatalf("fixture pages %+v: want one page with a 2-token bound cursor", fx.DB.ModelPages)
		}
		fx.DB.ModelPages[0].Bound[0] = json.RawMessage(`{"$date":"2026-06-11T10:00:00.012Z"}`)
		_, err := goldenComputeModels(t, fx)
		if err == nil || !strings.Contains(err.Error(), "node binds date:2026-06-11T10:00:00.012Z for token 0") {
			t.Fatalf("a changed bound instant: %v, want the bound-value mismatch", err)
		}
	})
	t.Run("unexpected-feed-query", func(t *testing.T) {
		// The feed fake must flag a query no fixture names (the check that pins Node's query string).
		f := &goldenFeed{replies: map[string]goldenFeedReply{"a=1": {Query: "a=1"}}, hits: map[string]int{}}
		srv := httptest.NewServer(f)
		t.Cleanup(srv.Close)
		res, err := getURL(srv.Client(), srv.URL+"/v1/feed?a=2")
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		f.mu.Lock()
		n := len(f.unexpected)
		f.mu.Unlock()
		if n != 1 {
			t.Fatalf("unexpected queries recorded: %d, want 1", n)
		}
	})
}
