package policy

import (
	_ "embed"
	"encoding/json"
	"slices"
)

// policydata.json is generated from the Node modules by scripts/content-policy-go-data.ts, and
// scripts/__tests__/content-policy-go-data.schema-drift.test.ts fails when the two differ, so none of
// these constants is a transcription.
//
//go:embed policydata.json
var dataJSON []byte

// RuleSpec is one RegionBlockConfig entry (src/server/utils/region-blocking.ts).
type RuleSpec struct {
	Region        string `json:"region"`
	EffectiveDate string `json:"effectiveDate"`
}

type levelData struct {
	PG      int32 `json:"pg"`
	PG13    int32 `json:"pg13"`
	R       int32 `json:"r"`
	X       int32 `json:"x"`
	XXX     int32 `json:"xxx"`
	Blocked int32 `json:"blocked"`
	Public  int32 `json:"public"`
	SFW     int32 `json:"sfw"`
	All     int32 `json:"all"`
}

type policyData struct {
	Levels                   levelData  `json:"levels"`
	RatingLadder             []string   `json:"ratingLadder"`
	RegistryKnownRatings     []string   `json:"registryKnownRatings"`
	MatureRatings            []string   `json:"matureRatings"`
	NoCountryCodes           []string   `json:"noCountryCodes"`
	RegionBlockDefault       []RuleSpec `json:"regionBlockDefault"`
	RegionRestrictionDefault []RuleSpec `json:"regionRestrictionDefault"`
}

var data policyData

// Ratings is every rating a decision answers for, in its order: the rating ladder
// (OFFSITE_CONTENT_RATING_LADDER), then `xxx`, the rating above it (an app sub-listing or App Store
// item can carry it; the registry knows it, registryKnownRatings).
var Ratings []string

func init() {
	if err := parseData(dataJSON, &data); err != nil {
		panic("policy: policydata.json: " + err.Error())
	}
	Ratings = append(slices.Clone(data.RatingLadder), "xxx")
}

type dataError string

func (e dataError) Error() string { return string(e) }

func parseData(raw []byte, out *policyData) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return err
	}
	l := out.Levels
	if l.PG == 0 || l.PG13 == 0 || l.R == 0 || l.X == 0 || l.XXX == 0 || l.Blocked == 0 || l.Public == 0 || l.SFW == 0 || l.All == 0 {
		return dataError("a level is missing")
	}
	if len(out.RatingLadder) == 0 || len(out.RegistryKnownRatings) == 0 || len(out.MatureRatings) == 0 || len(out.NoCountryCodes) == 0 {
		return dataError("a list is empty")
	}
	if slices.Contains(out.RatingLadder, "xxx") {
		return dataError("the rating ladder carries xxx, which Ratings appends")
	}
	return nil
}

// RegionBlockDefault is DEFAULT_REGION_BLOCK_CONFIG: the block list when REGION_BLOCK_CONFIG is unset.
func RegionBlockDefault() []RuleSpec { return slices.Clone(data.RegionBlockDefault) }

// RegionRestrictionDefault is DEFAULT_REGION_RESTRICTION_CONFIG: the restriction list when
// REGION_RESTRICTION_CONFIG is unset.
func RegionRestrictionDefault() []RuleSpec { return slices.Clone(data.RegionRestrictionDefault) }
