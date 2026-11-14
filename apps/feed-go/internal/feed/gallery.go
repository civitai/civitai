package feed

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// GallerySettings is the cached `model:gallery-settings:<modelId>` value (getGallerySettingsByModelId),
// the fields this procedure reads.
type GallerySettings struct {
	Level       *int             `json:"level"`
	SfwHeld     *bool            `json:"sfwHeld"`
	PinnedPosts map[string][]int `json:"pinnedPosts"`
}

// GalleryStore reads what the model-gallery gates need.
type GalleryStore struct {
	Cache  redis.UniversalClient // cache cluster: the gallery-settings keys
	Prefix string
	DB     Querier // read replica
}

// Settings returns a model's gallery settings, nil for "none". A key that Node would rebuild (absent,
// or built before the SFW hold) falls back: the rebuild reads the model and the creator's hidden users.
func (g *GalleryStore) Settings(ctx context.Context, modelID int) (*GallerySettings, error) {
	raw, err := g.Cache.Get(ctx, g.Prefix+"model:gallery-settings:"+strconv.Itoa(modelID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, fallback.New("gallery-settings-miss")
	}
	if err != nil {
		return nil, fallback.Newf("gallery-settings-read-failed", "%v", err)
	}
	return ParseGallerySettings(raw)
}

// ParseGallerySettings applies getGallerySettingsByModelId's reading of a cached value.
func ParseGallerySettings(raw []byte) (*GallerySettings, error) {
	if string(raw) == "null" {
		return nil, fallback.New("gallery-settings-stale")
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, fallback.New("gallery-settings-stale")
	}
	if _, ok := probe["none"]; ok {
		return nil, nil
	}
	var s GallerySettings
	if err := json.Unmarshal(raw, &s); err != nil || s.SfwHeld == nil {
		return nil, fallback.New("gallery-settings-stale")
	}
	return &s, nil
}

// HeldLevel is the settings' contribution to getHeldGalleryLevel: their level when the model is held.
func (s *GallerySettings) HeldLevel() (int, bool) {
	if s == nil || s.SfwHeld == nil || !*s.SfwHeld {
		return 0, false
	}
	level := browsing.AllLevels
	if s.Level != nil {
		level = *s.Level
	}
	return level, true
}

// PinnedFor returns the pinned post ids of a version.
func (s *GallerySettings) PinnedFor(versionID int) []int {
	if s == nil || versionID == 0 {
		return nil
	}
	return s.PinnedPosts[strconv.Itoa(versionID)]
}

// VersionModel returns a version's model id, or 0 when the version does not exist.
func (g *GalleryStore) VersionModel(ctx context.Context, versionID int) (int, error) {
	rows, err := g.DB.Query(ctx, `SELECT "modelId" FROM "ModelVersion" WHERE id = $1`, versionID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	modelID := 0
	if rows.Next() {
		if err := rows.Scan(&modelID); err != nil {
			return 0, err
		}
	}
	return modelID, rows.Err()
}

// Withheld is isModelGalleryWithheld for resolved model ids: a taken-down model the viewer does not own.
func (g *GalleryStore) Withheld(ctx context.Context, modelIDs []int, viewerID int) (bool, error) {
	if len(modelIDs) == 0 {
		return false, nil
	}
	rows, err := g.DB.Query(ctx, `SELECT "userId", mode::text FROM "Model" WHERE id = ANY($1::int[])`, modelIDs)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID int
		var mode *string
		if err := rows.Scan(&userID, &mode); err != nil {
			return false, err
		}
		if mode != nil && *mode == "TakenDown" && userID != viewerID {
			return true, nil
		}
	}
	return false, rows.Err()
}

// Reviews is the handler's resourceReview.findMany: the post creators' visible reviews of this model
// (or version), best rating first. Returned per user id: the FIRST row in that order, as `find` picks.
func (g *GalleryStore) Reviews(ctx context.Context, userIDs []int, modelID, versionID, viewerID int) (map[int]Review, error) {
	out := map[int]Review{}
	if len(userIDs) == 0 {
		return out, nil
	}
	args := []any{userIDs}
	where := `rr."userId" = ANY($1::int[])`
	if modelID != 0 {
		args = append(args, modelID)
		where += ` AND rr."modelId" = $` + strconv.Itoa(len(args))
	}
	if versionID != 0 {
		args = append(args, versionID)
		where += ` AND rr."modelVersionId" = $` + strconv.Itoa(len(args))
	}
	// visibleReviewWhere: no post, or a published post, or the viewer's own.
	vis := `rr."postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id = rr."postId" AND p."publishedAt" <= now())`
	if viewerID != 0 {
		args = append(args, viewerID)
		vis += ` OR rr."userId" = $` + strconv.Itoa(len(args))
	}
	rows, err := g.DB.Query(ctx, `SELECT rr."userId", rr.rating, rr.details, rr.id, rr.recommended
		FROM "ResourceReview" rr WHERE `+where+` AND (`+vis+`) ORDER BY rr.rating DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r Review
		var userID int
		if err := rows.Scan(&userID, &r.Rating, &r.Details, &r.ID, &r.Recommended); err != nil {
			return nil, err
		}
		if _, seen := out[userID]; !seen {
			out[userID] = r
		}
	}
	return out, rows.Err()
}

// Review is the wire review `{rating, details, recommended, id}`.
type Review struct {
	Rating      int
	Details     *string
	Recommended bool
	ID          int
}
