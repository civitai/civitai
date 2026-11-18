package modelfeed

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// basemodels.json is generated from the Node constants by scripts/feed-go-basemodels.ts, and
// scripts/__tests__/feed-go-basemodels.schema-drift.test.ts fails when the two differ: the base-model
// and ecosystem tables are thousands of lines of TypeScript, so this service reads what Node's own
// functions answer for every base model, ecosystem key and model type instead of a transcription.
//
//go:embed basemodels.json
var baseModelsJSON []byte

// baseModelTable is basemodels.json.
type baseModelTable struct {
	// ModelTypes is the ModelType enum (packages/civitai-db-schema/src/enums.ts).
	ModelTypes []string `json:"modelTypes"`
	// Generation is, per base model name and ecosystem key, the model types
	// isBaseModelGenerationSupported answers true for.
	Generation map[string][]string `json:"generation"`
	// ModelLocked is the names isModelLockedBaseModel answers true for.
	ModelLocked []string `json:"modelLocked"`
	// MatureRestrictedModels is the lowercased names isMatureRestricted(name, 'models') is true for.
	MatureRestrictedModels []string `json:"matureRestrictedModels"`
	Levels                 struct {
		MinorContent int `json:"minorContent"` // minorContentBrowsingLevelsFlag
		SFW          int `json:"sfw"`          // sfwBrowsingLevelsFlag
		NSFW         int `json:"nsfw"`         // nsfwBrowsingLevelsFlag (src/shared/constants)
		Public       int `json:"public"`       // publicBrowsingLevelsFlag
		All          int `json:"all"`          // allBrowsingLevelsFlag
	} `json:"levels"`
	VersionFlags struct {
		GenerationDisabled int `json:"generationDisabled"`
		PartnerService     int `json:"partnerService"`
		PartnerTrains      int `json:"partnerTrains"`
	} `json:"versionFlags"`
}

var (
	table            baseModelTable
	modelTypes       = map[string]bool{}
	generationTypes  = map[string]map[string]bool{}
	modelLocked      = map[string]bool{}
	matureRestricted = map[string]bool{}
)

func init() {
	if err := json.Unmarshal(baseModelsJSON, &table); err != nil {
		panic("modelfeed: basemodels.json: " + err.Error())
	}
	if len(table.ModelTypes) == 0 || len(table.Generation) == 0 || table.Levels.All == 0 {
		panic("modelfeed: basemodels.json is incomplete")
	}
	for _, t := range table.ModelTypes {
		modelTypes[t] = true
	}
	for name, types := range table.Generation {
		set := make(map[string]bool, len(types))
		for _, t := range types {
			set[t] = true
		}
		generationTypes[name] = set
	}
	for _, n := range table.ModelLocked {
		modelLocked[n] = true
	}
	for _, n := range table.MatureRestrictedModels {
		matureRestricted[n] = true
	}
}

// isMatureRestrictedModels is isMatureRestricted(baseModel, 'models'): case-insensitive on the name.
// Lowercasing is ASCII-equivalent for every base model name the table holds.
func isMatureRestrictedModels(baseModel string) bool {
	return baseModel != "" && matureRestricted[strings.ToLower(baseModel)]
}

// isGenerationEligible is isGenerationEligible (packages/civitai-shared/src/generation-eligibility.ts):
// covered (a checkpoint on a model-locked base model is held to the live column), not
// generation-disabled, and the base model supports generation for this model type.
func isGenerationEligible(covered, coveredLive bool, baseModel, modelType string, flags int) bool {
	effective := covered
	if modelType == "Checkpoint" && modelLocked[baseModel] {
		effective = coveredLive
	}
	return effective && flags&table.VersionFlags.GenerationDisabled == 0 && generationTypes[baseModel][modelType]
}

// toPublicAPIVersionFlags is toPublicApiVersionFlags: the partner bits stripped.
func toPublicAPIVersionFlags(flags int) int {
	return flags &^ (table.VersionFlags.PartnerService | table.VersionFlags.PartnerTrains)
}
