package feed

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// This file ports the sponsored gallery post: getSponsoredGalleryPost (promotion.service.ts) and the
// helpers it and the handler use from src/shared/utils/promotion.ts.

// PromotionAudience is who the `creator-promotions` flag is on for, as FEED_GO_CREATOR_PROMOTIONS
// mirrors it. This service does not evaluate Flipt, so the mirror names the flag's rule instead.
type PromotionAudience int

const (
	// PromotionsUnknown (`true`, and the default): on for an audience this service cannot evaluate.
	// A first page that would carry a sponsored post falls back; one that would not is served, since
	// the flag cannot change it.
	PromotionsUnknown PromotionAudience = iota
	// PromotionsOff (`false`): off for every viewer.
	PromotionsOff
	// PromotionsModsTesters (`mods-testers`): the flag's rule as of 2026-11-14 in flipt-state (base
	// off, rollout true for the `testers` OR `moderators` segment). Both segments match
	// `isModerator = "true"` or a listed user id. A signed-out viewer has no isModerator/userId in its
	// Flipt context, so it matches neither: off. A moderator: on. Any other signed-in viewer may be on
	// a user-id list this service does not hold: unknown. So is a banned session: Node evaluates the
	// flag with its user (moderator or listed) although the procedures see no user.
	PromotionsModsTesters
	// PromotionsEveryone (`everyone`): on for every viewer.
	PromotionsEveryone
)

// ParsePromotionAudience reads FEED_GO_CREATOR_PROMOTIONS. Anything unrecognised is the fail-safe
// PromotionsUnknown.
func ParsePromotionAudience(v string) PromotionAudience {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "false", "0", "no", "off":
		return PromotionsOff
	case "mods-testers":
		return PromotionsModsTesters
	case "everyone":
		return PromotionsEveryone
	}
	return PromotionsUnknown
}

// For reports the flag's value for a viewer (signed out = nil), and whether it is known. banned is a
// banned user's session, for which v is nil.
func (a PromotionAudience) For(v *Viewer, banned bool) (on, known bool) {
	switch a {
	case PromotionsOff:
		return false, true
	case PromotionsEveryone:
		return true, true
	case PromotionsModsTesters:
		if banned {
			return false, false
		}
		if v == nil || v.ID == 0 {
			return false, true
		}
		if v.IsModerator {
			return true, true
		}
	}
	return false, false
}

// promotionRunDays is PROMOTION_RUN_DAYS.
var promotionRunDays = []int{1, 3, 7}

// maxRun is MAX_RUN_MS: the longest run, the window liveApprovedPromotions reads.
const maxRun = 7 * 24 * time.Hour

// GalleryPromotion is GalleryPromotionData, a `galleryPromotion` placement's payload.
type GalleryPromotion struct {
	PostID          int
	Days            int
	ModelVersionIDs []int
	ImageIDs        []int
	// AcceptedLevel is 0 when the payload carries no acceptance.
	AcceptedLevel int
	// EndsAt is nil when the payload carries no acceptance.
	EndsAt *time.Time
}

// jsPositiveInt is positiveInt: a JSON number that is a safe integer above zero (a string, a
// boolean or null is not).
func jsPositiveInt(raw json.RawMessage) (int, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) {
		return 0, false
	}
	var f float64
	if json.Unmarshal(raw, &f) != nil {
		return 0, false
	}
	if f <= 0 || f != math.Trunc(f) || f > 9007199254740991 {
		return 0, false
	}
	return int(f), true
}

func jsPositiveInts(raw json.RawMessage) ([]int, bool) {
	var items []json.RawMessage
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '[' || json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return nil, false
	}
	out := make([]int, len(items))
	for i, item := range items {
		n, ok := jsPositiveInt(item)
		if !ok {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// ParseGalleryPromotion is parseGalleryPromotionData: nil for a payload Node refuses. An `endsAt`
// string that is not an ISO timestamp (Node writes it with toISOString) falls back: Date.parse
// accepts other formats this service does not reproduce.
func ParseGalleryPromotion(raw json.RawMessage) (*GalleryPromotion, error) {
	var rec map[string]json.RawMessage
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' || json.Unmarshal(trimmed, &rec) != nil {
		return nil, nil
	}
	p := &GalleryPromotion{}
	var ok bool
	if p.PostID, ok = jsPositiveInt(rec["postId"]); !ok {
		return nil, nil
	}
	days, ok := jsPositiveInt(rec["days"])
	if !ok || !containsInt(promotionRunDays, days) {
		return nil, nil
	}
	p.Days = days
	if p.ModelVersionIDs, ok = jsPositiveInts(rec["modelVersionIds"]); !ok {
		return nil, nil
	}
	if p.ImageIDs, ok = jsPositiveInts(rec["imageIds"]); !ok {
		return nil, nil
	}
	// parseAcceptance: both or neither. A key present as null is not undefined.
	levelRaw, hasLevel := rec["acceptedLevel"]
	endsRaw, hasEnds := rec["endsAt"]
	if !hasLevel && !hasEnds {
		return p, nil
	}
	if p.AcceptedLevel, ok = jsPositiveInt(levelRaw); !ok {
		return nil, nil
	}
	var endsAt string
	if t := bytes.TrimSpace(endsRaw); len(t) == 0 || t[0] != '"' || json.Unmarshal(t, &endsAt) != nil {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339Nano, endsAt)
	if err != nil {
		return nil, fallback.Newf("sponsored-data", "endsAt %q", endsAt)
	}
	p.EndsAt = &at
	return p, nil
}

// IsPromotionLive is isPromotionLive: accepted, and before its frozen end (or accept + days).
func IsPromotionLive(acceptedAt time.Time, days int, endsAt *time.Time, now time.Time) bool {
	end := acceptedAt.Add(time.Duration(days) * 24 * time.Hour)
	if endsAt != nil {
		end = *endsAt
	}
	return !acceptedAt.After(now) && now.Before(end)
}

// PromotionModel is what promotionServingLevel reads of the host model.
type PromotionModel struct {
	Minor   bool
	SfwOnly bool
	// GalleryLevel is `gallerySettings->'level'` as JSON; nil when absent or SQL NULL.
	GalleryLevel json.RawMessage
}

// platformPromotionLevel is modelBrowsingLevelLimit: a minor model is held to the minor-content
// levels (PG|PG-13), an SFW-only one to SFW, any other to every level.
func platformPromotionLevel(m *PromotionModel) int {
	if m.Minor {
		return browsing.SFWLevels // minorContentBrowsingLevelsFlag: the levels below R
	}
	if m.SfwOnly {
		return browsing.SFWLevels
	}
	return browsing.AllLevels
}

// PromotionServingLevel is promotionServingLevel for a found model: the frozen accept level held to
// today's platform lock, or (no acceptance) hostPromotionLevel.
func PromotionServingLevel(m *PromotionModel, acceptedLevel int) (int, error) {
	platform := platformPromotionLevel(m)
	if acceptedLevel != 0 {
		return acceptedLevel & platform, nil
	}
	if platform != browsing.AllLevels {
		return platform, nil
	}
	// `level ? Flags.intersection(level, all) : all`.
	raw := bytes.TrimSpace(m.GalleryLevel)
	switch {
	case len(raw) == 0, string(raw) == "null", string(raw) == "false":
		return browsing.AllLevels, nil
	case raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9'):
		var f float64
		if json.Unmarshal(raw, &f) != nil || f != math.Trunc(f) || math.Abs(f) > math.MaxInt32 {
			return 0, fallback.Newf("sponsored-data", "gallery level %s", raw)
		}
		if f == 0 {
			return browsing.AllLevels, nil
		}
		return int(f) & browsing.AllLevels, nil
	}
	// A string, an object, `true`: JS coerces these in `&`, which is not reproduced.
	return 0, fallback.Newf("sponsored-data", "gallery level %s", raw)
}

// SponsoredBrowsingLevel is sponsoredBrowsingLevel: the viewer's level before the gallery's cap
// (else the capped level), held to what the run may be served at.
func SponsoredBrowsingLevel(browsingLevel int, preCap *int, servingLevel int) int {
	level := browsingLevel
	if preCap != nil {
		level = *preCap
	}
	return level & servingLevel
}

// SponsoredSlotIndex is sponsoredSlotIndex: after the pinned items, or second when there are none.
func SponsoredSlotIndex(pinnedCount, length int) int {
	if pinnedCount != 0 {
		return pinnedCount
	}
	return min(1, length)
}

// PromotionRow is one row liveApprovedPromotions reads.
type PromotionRow struct {
	ID         int
	ResolvedAt *time.Time
	Data       json.RawMessage
}

// SponsoredPick is getSponsoredGalleryPost's answer.
type SponsoredPick struct {
	PlacementID  int
	PostID       int
	ImageIDs     []int
	ServingLevel int
}

// PromotionStore reads what getSponsoredGalleryPost reads (implemented by *GalleryStore).
type PromotionStore interface {
	LiveGalleryPromotions(ctx context.Context, modelID int, since time.Time) ([]PromotionRow, error)
	// PromotionModel returns nil when the model does not exist.
	PromotionModel(ctx context.Context, modelID int) (*PromotionModel, error)
}

// SponsoredGalleryPost is getSponsoredGalleryPost with the flag on: the one live run for this
// version, or nil. Node picks one of several overlapping runs AT RANDOM per request, which a
// comparison cannot reproduce, so more than one live run falls back (`sponsored-rotation`).
func SponsoredGalleryPost(ctx context.Context, s PromotionStore, modelID, versionID int, now time.Time) (*SponsoredPick, error) {
	rows, err := s.LiveGalleryPromotions(ctx, modelID, now.Add(-maxRun))
	if err != nil {
		return nil, err
	}
	var live []SponsoredPick
	var accepted []int
	for _, row := range rows {
		data, err := ParseGalleryPromotion(row.Data)
		if err != nil {
			return nil, err
		}
		if data == nil || row.ResolvedAt == nil {
			continue
		}
		if !IsPromotionLive(*row.ResolvedAt, data.Days, data.EndsAt, now) {
			continue
		}
		if !containsInt(data.ModelVersionIDs, versionID) {
			continue
		}
		live = append(live, SponsoredPick{PlacementID: row.ID, PostID: data.PostID, ImageIDs: data.ImageIDs})
		accepted = append(accepted, data.AcceptedLevel)
	}
	if len(live) == 0 {
		return nil, nil
	}
	if len(live) > 1 {
		return nil, fallback.Newf("sponsored-rotation", "%d live runs", len(live))
	}
	m, err := s.PromotionModel(ctx, modelID)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, nil
	}
	level, err := PromotionServingLevel(m, accepted[0])
	if err != nil {
		return nil, err
	}
	if level == 0 {
		return nil, nil
	}
	picked := live[0]
	picked.ServingLevel = level
	return &picked, nil
}

// LiveGalleryPromotions is liveApprovedPromotions for the gallery surface: approved runs on this
// model resolved within the longest run length. `since` is bound as a UTC wall-clock literal, as
// Prisma stores and compares its timestamp(3) columns.
func (g *GalleryStore) LiveGalleryPromotions(ctx context.Context, modelID int, since time.Time) ([]PromotionRow, error) {
	rows, err := g.DB.Query(ctx, `SELECT id, "resolvedAt", data FROM "Placement"
		WHERE surface = 'galleryPromotion' AND "targetType" = 'model' AND "targetId" = $1
		  AND status = 'approved' AND "resolvedAt" > $2::timestamp`, modelID, since.UTC().Format("2006-01-02T15:04:05.000"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PromotionRow
	for rows.Next() {
		var r PromotionRow
		var data []byte
		if err := rows.Scan(&r.ID, &r.ResolvedAt, &data); err != nil {
			return nil, err
		}
		r.Data = json.RawMessage(data)
		out = append(out, r)
	}
	return out, rows.Err()
}

// PromotionModel is promotionServingLevel's model read.
func (g *GalleryStore) PromotionModel(ctx context.Context, modelID int) (*PromotionModel, error) {
	rows, err := g.DB.Query(ctx, `SELECT minor, "sfwOnly", "gallerySettings"->'level' FROM "Model" WHERE id = $1`, modelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	m := &PromotionModel{}
	var level []byte
	if err := rows.Scan(&m.Minor, &m.SfwOnly, &level); err != nil {
		return nil, err
	}
	if level != nil {
		m.GalleryLevel = json.RawMessage(level)
	}
	return m, rows.Err()
}

// ImageResources is getResourceIdsForImages: each image's resource model version ids.
func (g *GalleryStore) ImageResources(ctx context.Context, imageIDs []int) (map[int][]int, error) {
	out := map[int][]int{}
	if len(imageIDs) == 0 {
		return out, nil
	}
	rows, err := g.DB.Query(ctx, `SELECT "imageId", "modelVersionId" FROM "ImageResourceNew" WHERE "imageId" = ANY($1::int[])`, imageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var imageID, versionID int
		if err := rows.Scan(&imageID, &versionID); err != nil {
			return nil, err
		}
		out[imageID] = append(out[imageID], versionID)
	}
	return out, rows.Err()
}

func containsInt(list []int, n int) bool {
	for _, x := range list {
		if x == n {
			return true
		}
	}
	return false
}
