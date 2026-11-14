// Package feed is the port of `image.getImagesAsPostsInfinite` (handler getImagesAsPostsInfiniteHandler
// in src/server/controllers/image.controller.ts, read path getAllImages in
// src/server/services/image.service.ts) for the request shapes it supports. Every other shape is a
// fallback (see package fallback): the supported set is defined in Parse and grows as parity is proven.
package feed

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Sort values (ImageSort in src/server/common/enums.ts).
const (
	SortMostReactions = "Most Reactions"
	SortMostComments  = "Most Comments"
	SortMostCollected = "Most Collected"
	SortNewest        = "Newest"
	SortOldest        = "Oldest"
)

// Input is the parsed getInfiniteImagesSchema for the supported subset.
type Input struct {
	Limit               int
	Cursor              int // 0 = none
	Sort                string
	Period              string // AllTime, Day, Week, Month, Year
	PeriodMode          string // published, stats
	BrowsingLevel       *int   // raw, before the domain cap; nil = absent
	PreCapBrowsingLevel *int
	ModelID             int
	ModelVersionID      int
	Model3DID           int
	Types               []string
	Generation          []string
	WithMeta            bool
	FromPlatform        bool
	DisablePoi          bool
	DisableMinor        bool
	HideChallenges      bool
	ExcludedTagIDs      []int
	ExcludedUserIDs     []int
}

// unsupportedKeys are input keys that change the query in ways not ported yet. Present with a
// non-empty value, they make the request fall back. Keys outside the schema are ignored (zod strips
// them), and so are schema keys the DB path never reads (hat*, includePG13, remix*, requiringMeta,
// hideAutoResources, hideManualResources).
var unsupportedKeys = []string{
	"collectionId", "collectionTagId", "postId", "postIds", "userId", "username", "hubId",
	"hubExcludedSources", "imageId", "reviewId", "skip", "ids", "tags", "techniques", "tools",
	"prioritizedUserIds", "reactions", "followed", "hidden", "newCreators", "includeBaseModel",
	"pending", "pendingReviewOnly", "poiOnly", "minorOnly", "withTags", "jumpTo", "baseModels",
	"notPublished", "scheduled", "publishedOnly",
}

var knownSorts = map[string]bool{SortMostReactions: true, SortMostComments: true, SortMostCollected: true, SortNewest: true, SortOldest: true}
var knownPeriods = map[string]bool{"AllTime": true, "Day": true, "Week": true, "Month": true, "Year": true}

// Parse validates the decoded input map. A shape outside the supported subset is a fallback; a value
// the schema itself rejects is also a fallback (the Node app answers it with its own BAD_REQUEST).
func Parse(m map[string]any) (*Input, error) {
	for _, k := range unsupportedKeys {
		if v, ok := m[k]; ok && !isEmpty(v) {
			return nil, fallback.Newf("input-"+k, "%v", v)
		}
	}
	in := &Input{Limit: 100, Sort: SortMostReactions, Period: "AllTime", PeriodMode: "published"}
	var err error
	if v, ok := m["limit"]; ok && v != nil {
		if in.Limit, err = intIn(v, 0, 200); err != nil {
			return nil, fallback.Newf("input-invalid", "limit: %v", err)
		}
	}
	if v, ok := m["cursor"]; ok && v != nil {
		if in.Cursor, err = cursor(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["sort"]; ok && v != nil {
		s, _ := v.(string)
		if !knownSorts[s] {
			return nil, fallback.Newf("input-sort", "%v", v)
		}
		in.Sort = s
	}
	if v, ok := m["period"]; ok && v != nil {
		s, _ := v.(string)
		if !knownPeriods[s] {
			return nil, fallback.Newf("input-invalid", "period %v", v)
		}
		in.Period = s
	}
	if v, ok := m["periodMode"]; ok && v != nil {
		s, _ := v.(string)
		if s != "published" && s != "stats" {
			return nil, fallback.Newf("input-invalid", "periodMode %v", v)
		}
		in.PeriodMode = s
	}
	for key, dst := range map[string]**int{"browsingLevel": &in.BrowsingLevel, "preCapBrowsingLevel": &in.PreCapBrowsingLevel} {
		if v, ok := m[key]; ok && v != nil {
			n, err := intIn(v, 0, math.MaxInt32)
			if err != nil {
				return nil, fallback.Newf("input-invalid", "%s: %v", key, err)
			}
			*dst = &n
		}
	}
	for key, dst := range map[string]*int{"modelId": &in.ModelID, "modelVersionId": &in.ModelVersionID, "model3dId": &in.Model3DID} {
		if v, ok := m[key]; ok && v != nil {
			n, err := intIn(v, math.MinInt32, math.MaxInt32)
			if err != nil {
				return nil, fallback.Newf("input-invalid", "%s: %v", key, err)
			}
			*dst = n
		}
	}
	if in.Types, err = stringList(m["types"], map[string]bool{"image": true, "video": true, "audio": true}); err != nil {
		return nil, err
	}
	if in.Generation, err = stringList(m["generation"], map[string]bool{"txt2img": true, "txt2imgHiRes": true, "img2img": true, "inpainting": true}); err != nil {
		return nil, err
	}
	in.WithMeta = boolOf(m["withMeta"])
	in.FromPlatform = boolOf(m["fromPlatform"])
	in.DisablePoi = boolOf(m["disablePoi"])
	in.DisableMinor = boolOf(m["disableMinor"])
	in.HideChallenges = boolOf(m["hideChallenges"])
	if in.ExcludedTagIDs, err = ints(m["excludedTagIds"]); err != nil {
		return nil, err
	}
	if in.ExcludedUserIDs, err = ints(m["excludedUserIds"]); err != nil {
		return nil, err
	}
	if v, ok := m["include"]; ok && v != nil {
		// The default is ['cosmetics']; 'meta' is what withMeta adds. Anything else hydrates more
		// (tags, report, count, metaSelect) and is not ported.
		list, ok := v.([]any)
		if !ok {
			return nil, fallback.New("input-invalid")
		}
		hasCosmetics := false
		for _, e := range list {
			switch e {
			case "cosmetics":
				hasCosmetics = true
			case "meta":
				in.WithMeta = true
			case "tagIds", "profilePictures":
				// The handler adds both anyway.
			default:
				return nil, fallback.Newf("input-include", "%v", e)
			}
		}
		if !hasCosmetics {
			return nil, fallback.New("input-include-no-cosmetics")
		}
	}
	return in, nil
}

// ApplyDomainCap is applyDomainFeature: the input's levels clamped in place to the domain cap BEFORE
// the schema default applies (an absent level under a cap becomes the cap; uncapped, it becomes 31).
func (in *Input) ApplyDomainCap(cap int) (browsingLevel int, preCap *int) {
	if cap != 0 {
		raw := 0
		if in.BrowsingLevel != nil {
			raw = *in.BrowsingLevel
		}
		browsingLevel = browsing.ClampToCap(raw, cap)
		if in.PreCapBrowsingLevel != nil {
			v := browsing.ClampToCap(*in.PreCapBrowsingLevel, cap)
			preCap = &v
		}
		return browsingLevel, preCap
	}
	browsingLevel = browsing.AllLevels
	if in.BrowsingLevel != nil {
		browsingLevel = *in.BrowsingLevel
	}
	return browsingLevel, in.PreCapBrowsingLevel
}

func isEmpty(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case string:
		return t == ""
	case []any:
		return len(t) == 0
	}
	return false
}

func boolOf(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string: // z.coerce.boolean: any non-empty string is true
		return t != ""
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	}
	return false
}

func number(v any) (float64, error) {
	switch t := v.(type) {
	case json.Number:
		return t.Float64()
	case float64:
		return t, nil
	case int:
		return float64(t), nil
	}
	return 0, fmt.Errorf("not a number: %v", v)
}

func intIn(v any, lo, hi int) (int, error) {
	f, err := number(v)
	if err != nil {
		return 0, err
	}
	if f != math.Trunc(f) || f < float64(lo) || f > float64(hi) {
		return 0, fmt.Errorf("out of range: %v", v)
	}
	return int(f), nil
}

// cursor accepts the keyset cursor this sort set emits: a non-negative int4 (number, or the string the
// image feed's own nextCursor round-trips as). A date or compound cursor falls back.
func cursor(v any) (int, error) {
	switch t := v.(type) {
	case json.Number, float64:
		n, err := intIn(t, 0, math.MaxInt32)
		if err != nil {
			return 0, fallback.Newf("input-invalid", "cursor: %v", err)
		}
		return n, nil
	case string:
		n, err := strconv.Atoi(t)
		if err != nil || n < 0 {
			return 0, fallback.Newf("input-cursor", "%q", t)
		}
		return n, nil
	}
	return 0, fallback.Newf("input-cursor", "%T", v)
}

func stringList(v any, allowed map[string]bool) ([]string, error) {
	if v == nil {
		return nil, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.New("input-invalid")
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok || !allowed[s] {
			return nil, fallback.Newf("input-invalid", "%v", e)
		}
		out = append(out, s)
	}
	return out, nil
}

func ints(v any) ([]int, error) {
	if v == nil {
		return nil, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.New("input-invalid")
	}
	out := make([]int, 0, len(list))
	for _, e := range list {
		n, err := intIn(e, math.MinInt32, math.MaxInt32)
		if err != nil {
			return nil, fallback.Newf("input-invalid", "%v", e)
		}
		out = append(out, n)
	}
	return out, nil
}
