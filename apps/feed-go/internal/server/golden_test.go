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
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

const (
	goldenDir = "../../testdata/golden"
	// The fixture counts gen.mjs writes: a glob that matches fewer fails, so a moved directory or a
	// renamed extension cannot pass as zero fixtures.
	goldenMinAsPosts = 21
	goldenMinV1      = 22
	goldenIssuer     = "https://auth.example.test"
	goldenCookieName = "__Secure-civ-token"
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
	} `json:"expect"`
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
	// Resources are the image's ImageResourceNew rows.
	Resources []struct {
		ModelVersionID int  `json:"modelVersionId"`
		Detected       bool `json:"detected"`
	} `json:"_resources"`
}

// goldenImageColumns is the getAllImages SELECT list, in the order scanRows scans it.
var goldenImageColumns = []string{
	"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hideMeta", "hasMeta", "hasPositivePrompt",
	"onSite", "remixOfId", "createdAt", "sortAt", "mimeType", "type", "metadata", "ingestion", "blockedFor",
	"scannedAt", "needsReview", "userId", "postId", "postTitle", "index", "publishedAt", "unpublishedAt",
	"modelVersionId", "model3dId", "availability", "minor", "poi", "acceptableMinor", "cursorId",
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

func (g goldenImage) row() []any {
	return []any{
		g.ID, goldenPtr(g.Name), goldenPtr(g.URL), g.NsfwLevel, goldenPtr(g.Width), goldenPtr(g.Height),
		goldenPtr(g.Hash), g.HideMeta, g.HasMeta, g.HasPositivePrompt, goldenPtr(g.OnSite),
		goldenJSONVal(g.RemixOfID), goldenTimeVal(g.CreatedAt), goldenTimeVal(g.SortAt), goldenPtr(g.MimeType),
		g.Type, goldenJSONVal(g.Metadata), g.Ingestion, goldenPtr(g.BlockedFor), goldenTimeVal(g.ScannedAt),
		goldenPtr(g.NeedsReview), g.UserID, g.PostID, goldenPtr(g.PostTitle), goldenPtr(g.Index),
		goldenTimeVal(g.PublishedAt), goldenPtr(g.UnpublishedAt), goldenPtr(g.ModelVersionID),
		goldenPtr(g.Model3DID), g.Availability, g.Minor, g.Poi, g.AcceptableMinor, g.ID,
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
	goldenReCursor    = regexp.MustCompile(`\(\((?:i\."id"|irr\."imageId") (<=|>=) \$(\d+)\)\)`)
	goldenReLimit     = regexp.MustCompile(`LIMIT \$(\d+)\s*$`)
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
// excluded creators, types, the minor exclusion, published-before-now, order, cursor, limit).
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
		if hasExcl && goldenHas(goldenInts(exclUsers), img.UserID) {
			continue
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
	sort.SliceStable(kept, func(a, b int) bool {
		if asc {
			return kept[a].ID < kept[b].ID
		}
		return kept[a].ID > kept[b].ID
	})
	if m := goldenReCursor.FindStringSubmatch(sql); m != nil {
		n, _ := strconv.Atoi(m[2])
		c := goldenInt(args[n-1])
		var paged []goldenImage
		for _, img := range kept {
			if (m[1] == "<=" && img.ID <= c) || (m[1] == ">=" && img.ID >= c) {
				paged = append(paged, img)
			}
		}
		kept = paged
	}
	if limit, ok := goldenArg(args, goldenReLimit, sql); ok && len(kept) > goldenInt(limit) {
		kept = kept[:goldenInt(limit)]
	}
	for _, img := range kept {
		out = append(out, img.row())
	}
	return testkit.NewRows(goldenImageColumns, out...), nil
}

// newGoldenPG is the fixture's Postgres: one route per query this service sends, each answered
// over the fixture's tables. A query no route matches fails (testkit.DB), so the test fails too.
func newGoldenPG(fx *goldenFixture) *testkit.DB {
	db := &fx.DB
	return &testkit.DB{Routes: []testkit.Route{
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
		{Match: `SELECT id FROM "User" WHERE username = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			for _, u := range db.Users {
				if u.Username != nil && *u.Username == fmt.Sprint(args[0]) {
					return testkit.NewRows([]string{"id"}, []any{u.ID}), nil
				}
			}
			return testkit.NewRows([]string{"id"}), nil
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
	}}
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
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: db}
	resolver := &auth.Resolver{
		Verifier:    &auth.Verifier{Issuer: goldenIssuer, JWKSURL: jwks.URL, HTTP: jwks.Client(), Now: nowFn},
		Revocation:  &auth.Revocation{Redis: sys},
		Sessions:    packed,
		CookieNames: []string{goldenCookieName},
	}
	events := map[string]bool{}
	for _, e := range fx.Config.DecorationEvents {
		events[e] = true
	}
	queryCache := &feed.QueryCache{Redis: cache}
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
	s := &Server{Resolver: resolver, Deps: deps, Hosts: goldenHosts, V1: v1}

	headers := map[string]string{}
	for k, v := range fx.Request.Headers {
		headers[k] = v
	}
	if fx.Request.Session != nil {
		headers["cookie"] = goldenCookieName + "=" + goldenToken(t, priv, fx.Request.Session.UserID, now)
	}
	return &goldenEnv{server: s, feed: fake, headers: headers}
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

func goldenRunAsPosts(t *testing.T, fx *goldenFixture) {
	env := goldenSetup(t, fx)
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

func TestGoldenAsPosts(t *testing.T) {
	for _, path := range goldenFiles(t, "as-posts", goldenMinAsPosts) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunAsPosts(t, fx) })
	}
}

func TestGoldenV1Images(t *testing.T) {
	for _, path := range goldenFiles(t, "v1-images", goldenMinV1) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) { goldenRunV1(t, fx) })
	}
}

// goldenSetPath replaces the value at a dotted path (array indices as numbers) in a JSON document.
func goldenSetPath(t *testing.T, doc json.RawMessage, path string, val any) json.RawMessage {
	t.Helper()
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
		mutated := goldenSetPath(t, fx.Expect.Envelope, "json.items.0.images.0.id", 999999)
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
		mutated := goldenSetPath(t, fx.Expect.Body, "items.0.id", 999999)
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
