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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
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
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const (
	goldenDir = "../../testdata/golden"
	// The fixture counts gen.mjs writes: a glob that matches fewer fails, so a moved directory or a
	// renamed extension cannot pass as zero fixtures.
	goldenMinAsPosts  = 26
	goldenMinV1       = 36
	goldenMinInfinite = 23
	goldenMinModels   = 31
	goldenIssuer      = "https://auth.example.test"
	goldenCookieName  = "__Secure-civ-token"
)

// goldenHosts are the fixtures' synthetic domains (SERVER_DOMAIN_GREEN/BLUE/RED).
var goldenHosts = browsing.HostColors{
	"green": {"green.example.test"},
	"blue":  {"blue.example.test"},
	"red":   {"red.example.test"},
}

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
		Body      json.RawMessage `json:"body"`
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
	// Tags are the image's TagsOnImageDetails tag ids (infinite/ fixtures only: the tag scope).
	Tags []int `json:"_tags"`
	// Tools are the image's ImageTool tool ids (only in a fixture whose query filters by `tools`).
	Tools []int `json:"_tools"`
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
	} `json:"modelVersions"`
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
	} `json:"modelPages"`
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
	// OfficialModels are the official, published models getOfficialModelIds' fetchFn reads (a fixture
	// whose request reads the official-models entry).
	OfficialModels []struct {
		ID   int    `json:"id"`
		Type string `json:"type"`
	} `json:"officialModels"`
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
		ModelID  int        `json:"modelId"`
		Deadline goldenTime `json:"deadline"`
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
	goldenReVersion   = regexp.MustCompile(`irr\."modelVersionId" = \$(\d+)`)
	goldenReModel     = regexp.MustCompile(`mv\."modelId" = \$(\d+)`)
	goldenReLevel     = regexp.MustCompile(`\(i\."nsfwLevel" & \$(\d+)\) != 0`)
	goldenReTarget    = regexp.MustCompile(` AND i\."userId" = \$(\d+)`)
	goldenReExclUsers = regexp.MustCompile(`i\."userId" != ALL\(\$(\d+)::int\[\]\)`)
	goldenReTypes     = regexp.MustCompile(`i\.type = ANY\(\$(\d+)::text`)
	goldenReCursor    = regexp.MustCompile(`\(\((i\."id"|irr\."imageId"|i\."index") (<=|>=) \$(\d+)\)\)`)
	goldenReTags      = regexp.MustCompile(`WHERE "tagId" = ANY\(\$(\d+)::int\[\]\) AND "disabled" = FALSE`)
	goldenReTools     = regexp.MustCompile(`HAVING array_agg\(it\."toolId" ORDER BY it\."toolId"\) @> \$(\d+)::integer\[\]`)
	goldenReLimit     = regexp.MustCompile(`LIMIT \$(\d+)\s*$`)
	goldenReOffset    = regexp.MustCompile(`OFFSET (\d+)\s+LIMIT`)
	goldenReMinorOwn  = regexp.MustCompile(`\(i\."minor" != TRUE OR i\."userId" = \$(\d+)\)`)
	goldenReRRModel   = regexp.MustCompile(`rr\."modelId" = \$(\d+)`)
	goldenReRRVersion = regexp.MustCompile(`rr\."modelVersionId" = \$(\d+)`)
)

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
// excluded creators, types, tools, the minor exclusion, published-before-now, order, cursor, offset,
// limit).
func goldenImageRows(fx *goldenFixture, sql string, args []any) (*testkit.Rows, error) {
	versionModel := map[int]int{}
	for _, v := range fx.DB.ModelVersions {
		versionModel[v.ID] = v.ModelID
	}
	ids, hasIDs := goldenArg(args, goldenReIDs, sql)
	postIDs, hasPostIDs := goldenArg(args, goldenRePostIDs, sql)
	postID, hasPostID := goldenArg(args, goldenRePostID, sql)
	version, hasVersion := goldenArg(args, goldenReVersion, sql)
	model, hasModel := goldenArg(args, goldenReModel, sql)
	level, hasLevel := goldenArg(args, goldenReLevel, sql)
	target, hasTarget := goldenArg(args, goldenReTarget, sql)
	exclUsers, hasExcl := goldenArg(args, goldenReExclUsers, sql)
	types, hasTypes := goldenArg(args, goldenReTypes, sql)
	minorOwner, hasMinorOwner := goldenArg(args, goldenReMinorOwn, sql)
	tags, hasTags := goldenArg(args, goldenReTags, sql)
	tools, hasTools := goldenArg(args, goldenReTools, sql)
	minorAll := strings.Contains(sql, `(i."minor" != TRUE)`)
	published := strings.Contains(sql, `(p."publishedAt" < now())`)
	if !hasLevel {
		return nil, errors.New("golden: image query without a level clause")
	}
	var out [][]any
	var kept []goldenImage
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
		if hasVersion || hasModel {
			ok := false
			for _, r := range img.Resources {
				if (hasVersion && r.ModelVersionID == goldenInt(version)) || (!hasVersion && versionModel[r.ModelVersionID] == goldenInt(model)) {
					ok = true
				}
			}
			if !ok {
				continue
			}
		}
		if lv := goldenInt(level); img.NsfwLevel&lv == 0 || img.NsfwLevel == 0 {
			continue
		}
		if hasTarget && img.UserID != goldenInt(target) {
			continue
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
		if published && (img.PublishedAt.T == nil || !img.PublishedAt.T.Before(fx.Now)) {
			continue
		}
		kept = append(kept, img)
	}
	asc := strings.Contains(sql, `ORDER BY i."id" ASC`)
	// A post's own media: ORDER BY i."index", i."id", and the index is the cursor column.
	byIndex := strings.Contains(sql, `ORDER BY i."index", i."id"`)
	indexOf := func(img goldenImage) int {
		if img.Index == nil {
			return 0
		}
		return *img.Index
	}
	sort.SliceStable(kept, func(a, b int) bool {
		switch {
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
		{Match: `SELECT "userId", mode::text FROM "Model"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, m := range db.Models {
				if goldenHas(goldenInts(args[0]), m.ID) {
					rows = append(rows, []any{m.UserID, goldenPtr(m.Mode)})
				}
			}
			return testkit.NewRows([]string{"userId", "mode"}, rows...), nil
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
	}, goldenTagRoutes(db)...)}
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

func goldenJWKS(t *testing.T) (*httptest.Server, *ecdsa.PrivateKey) {
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

func goldenToken(t *testing.T, priv *ecdsa.PrivateKey, userID int, now time.Time) string {
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

func goldenRedis(t *testing.T, entries map[string]goldenRedisEntry) *testkit.Redis {
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

func goldenSetup(t *testing.T, fx *goldenFixture) *goldenEnv {
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
func goldenSetupMode(t *testing.T, fx *goldenFixture, writeBack bool) *goldenEnv {
	t.Helper()
	now := fx.Now
	nowFn := func() time.Time { return now }

	cache := goldenRedis(t, fx.Redis)
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
	}
	infinite := &feed.InfiniteDeps{Deps: deps, Sources: sources, Blocked: blocked}
	s := &Server{Resolver: resolver, Deps: deps, Hosts: goldenHosts, V1: v1, Infinite: infinite}

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
func goldenFiles(t *testing.T, sub string, min int) []string {
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

func goldenLoad(t *testing.T, path string) *goldenFixture {
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
	for _, p := range goldenWriteProblems(fx, before, goldenCacheState(env.cache), writeBack) {
		t.Error(p)
	}
	// createContext's policy, as for the gallery procedure: the public TTL exactly when signed out.
	if fx.Expect.Cacheable == nil {
		t.Fatal("an image.getInfinite fixture without expect.cacheable")
	}
	if *fx.Expect.Cacheable && (c.ttl == nil || *c.ttl != trpc.SignedOutTTL) {
		t.Errorf("signed out: want the public cache TTL %+v, got %v", trpc.SignedOutTTL, c.ttl)
	}
	if !*fx.Expect.Cacheable && c.ttl != nil {
		t.Errorf("a session user: want no cache TTL, got %+v", *c.ttl)
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
	// collectionReads counts the collection permission reads.
	collectionReads int
}

func newGoldenModelPG(t *testing.T, fx *goldenFixture) *goldenModelPG {
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
					rows = append(rows, []any{p.ModelID, goldenTimeVal(p.Deadline)})
				}
			}
			return testkit.NewRows([]string{"modelId", "deadline"}, rows...), nil
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
)

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
func goldenSetupModels(t *testing.T, fx *goldenFixture) *goldenEnv {
	t.Helper()
	return goldenSetupModelsMode(t, fx, false)
}

// goldenSetupModelsMode is goldenSetupModels with write-back on or off: on, the miss computation
// writes what it computes, and the one fixture database stands in for the primary.
func goldenSetupModelsMode(t *testing.T, fx *goldenFixture, writeBack bool) *goldenEnv {
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
		WriteBack: goldenWrites(writeBack)}
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
		},
		Now: env.now,
	}
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
	for _, p := range goldenWriteProblems(fx, state[0], state[1], writeBack) {
		t.Error(p)
	}
	// The cache policy computeModelGetAll documents: the public TTL exactly when there is no session,
	// none for a session.
	if fx.Request.Session == nil && (c.ttl == nil || *c.ttl != trpc.SignedOutTTL) {
		t.Errorf("signed out: want the public cache TTL %+v, got %v", trpc.SignedOutTTL, c.ttl)
	}
	if fx.Request.Session != nil && c.ttl != nil {
		t.Errorf("a session: want no cache TTL, got %+v", *c.ttl)
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
