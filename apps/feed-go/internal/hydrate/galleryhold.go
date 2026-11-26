package hydrate

import (
	"context"
	"fmt"
	"math"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// MissGalleryHold is the gallery-hold computation of a `model:gallery-settings:<modelId>` miss
// (GalleryHolds): only the hold getHeldGalleryLevel reads is computed, never the settings entry, so
// nothing is written back and nothing is kept in process.
const MissGalleryHold = "gallery-hold"

// GalleryHold is what getGallerySettingsByModelId's rebuild says about a model's hold: Held is its
// `sfwHeld` (the model is minor or SFW-only), Level its `level` then (heldGalleryLevel).
type GalleryHold struct {
	Held  bool
	Level int
}

// sqlGalleryHold reads the Model columns getGallerySettingsByModelId's rebuild decides the hold on
// (`getModel({ id, select: { id, userId, gallerySettings, minor, sfwOnly } })`): the two flags and the
// stored `gallerySettings.level`, with its JSON type so a value JS would coerce is not guessed at.
const sqlGalleryHold = `SELECT id, minor, "sfwOnly", jsonb_typeof("gallerySettings"->'level') AS "levelType", "gallerySettings"->>'level' AS level FROM "Model" WHERE id = ANY($1::int[])`

// GalleryHolds answers the gallery-settings misses of modelIDs (keys absent from the cache) the way
// getGallerySettingsByModelId's rebuild decides the hold, for the readers that need only the hold
// (getShowcaseHeldLevels under getHeldGalleryLevel and getHeldLevelsByPost): a model that does not
// exist has none (Node's rebuild answers null), and an existing one is held exactly when it is minor
// or SFW-only, at heldGalleryLevel(stored level, model). The map holds every model found.
//
// The rebuild reads the model through getDbWithoutLag('model', id): the primary for a model a recent
// write flagged. This service reads only the replica, so when any of the models carries that flag, or
// the flag read fails, nothing is computed and the request falls back (`gallery-settings-miss`): Node
// then reads the primary. Without s.Compute (FEED_GO_COMPUTE_MISSES off) or a replica it falls back
// too, and so does a Go-first probe (WithPresence), which reports the miss as before. A failed query
// is `gallery-settings-miss-failed`.
//
// Concurrent calls for the same models share one query (singleflight), but no answer is kept in
// process (MissCompute.memoized): the hold is a safety rule, and a kept answer could outlive the bust
// a minor or SFW-only flag change sends. Nothing is written back: the settings entry Node writes also
// carries the creator's hidden users, which Node reads from the primary (getCreatorGalleryHiddenUserIds
// with fresh), so this service cannot build it. Each computed miss counts its models in
// s.Compute.Observe (MissGalleryHold, "computed"; a failed query "error").
func (s *Sources) GalleryHolds(ctx context.Context, modelIDs []int) (map[int]GalleryHold, error) {
	out := map[int]GalleryHold{}
	ids := Unique(modelIDs)
	if len(ids) == 0 {
		return out, nil
	}
	if s == nil || s.Compute == nil || s.Replica == nil || presenceOf(ctx) != nil {
		return nil, fallback.New("gallery-settings-miss")
	}
	if flagged, err := s.lagFlagged(ctx, "model", ids); flagged || err != nil {
		return nil, fallback.New("gallery-settings-miss")
	}
	c := s.Compute
	records, err := c.lookupShared(ctx, MissGalleryHold, ids, s.lookupGalleryHolds)
	if err != nil {
		c.observe(MissGalleryHold, "error", len(ids))
	} else {
		c.observe(MissGalleryHold, "computed", len(ids))
	}
	if err != nil {
		return nil, fallback.Wrap("gallery-settings-miss-failed", err)
	}
	for _, id := range ids {
		rec, ok := records[id]
		if !ok {
			continue
		}
		held, _ := rec.Get("held")
		level, _ := rec.Get("level")
		h, _ := held.(bool)
		l, _ := level.(int)
		out[id] = GalleryHold{Held: h, Level: l}
	}
	return out, nil
}

// lookupGalleryHolds runs sqlGalleryHold over ids on the replica: a record (`held`, `level`) per model
// found.
func (s *Sources) lookupGalleryHolds(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlGalleryHold, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := make(map[int]jspack.Obj, len(maps))
	for _, m := range maps {
		id, ok := Int(m["id"])
		if !ok {
			return nil, fmt.Errorf("gallery hold: row id %v", m["id"])
		}
		minor, ok1 := m["minor"].(bool)
		sfwOnly, ok2 := m["sfwOnly"].(bool)
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("gallery hold: model %d flags %v, %v", id, m["minor"], m["sfwOnly"])
		}
		hold := GalleryHold{Held: minor || sfwOnly}
		if hold.Held {
			stored, err := storedGalleryLevel(m["levelType"], m["level"])
			if err != nil {
				return nil, fmt.Errorf("gallery hold: model %d: %w", id, err)
			}
			hold.Level = HeldGalleryLevel(stored, minor, sfwOnly)
		}
		out[id] = jspack.Obj{{K: "held", V: hold.Held}, {K: "level", V: hold.Level}}
	}
	return out, nil
}

// storedGalleryLevel is `stored.level ?? 0` for the stored settings' `level`: absent or null is 0, a
// JSON number is its value. A number JS would truncate (a fraction, or past the int32 range `&`
// works in) and any other JSON type (which JS would coerce) are errors: the request falls back.
func storedGalleryLevel(typ, text any) (int, error) {
	t, _ := typ.(string)
	switch t {
	case "", "null":
		return 0, nil
	case "number":
		s, _ := text.(string)
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
			return 0, fmt.Errorf("stored level %q", s)
		}
		return int(f), nil
	}
	return 0, fmt.Errorf("stored level of JSON type %s", t)
}

// HeldGalleryLevel is heldGalleryLevel (src/shared/constants/browsingLevel.constants.ts) for a minor
// or SFW-only model: the stored level within modelBrowsingLevelLimit, or the whole limit when that
// leaves nothing. minorContentBrowsingLevelsFlag is the levels below R, the SFW levels.
func HeldGalleryLevel(stored int, minor, sfwOnly bool) int {
	limit := browsing.AllLevels
	if minor || sfwOnly {
		limit = browsing.SFWLevels
	}
	if l := stored & limit; l != 0 {
		return l
	}
	return limit
}
