package v1models

import "strings"

// matureRestrictedModels is matureRestrictedBaseModels('models') (packages/civitai-shared/src/
// basemodel.constants.ts): the base models whose mature versions the model surfaces leave out. Kept
// in step with the Node list by src/server/__tests__/feed-go-v1-models.golden.test.ts, which reads
// this block.
var matureRestrictedModels = map[string]bool{
	"fibo 2.0":           true,
	"fibo 2.0 turbo":     true,
	"ideogram 4.0":       true,
	"ideogram 4.5":       true,
	"stable cascade":     true,
	"sd 3":               true,
	"sd 3.5":             true,
	"sd 3.5 large":       true,
	"sd 3.5 large turbo": true,
	"sd 3.5 medium":      true,
	"sdxl turbo":         true,
	"svd":                true,
	"svd xt":             true,
}

// isMatureRestrictedForModels is isMatureRestricted(baseModel, 'models'): matched case-insensitively.
func isMatureRestrictedForModels(baseModel string) bool {
	return baseModel != "" && matureRestrictedModels[strings.ToLower(baseModel)]
}

// Version flags stripped from the public API (toPublicApiVersionFlags): PartnerService, PartnerTrains.
const partnerFlags = 1<<5 | 1<<6

// modelTypes are the ModelType enum values (packages/civitai-db-schema/src/enums.ts).
var modelTypes = map[string]bool{
	"AestheticGradient": true, "Checkpoint": true, "CLIP": true, "CLIPVision": true, "ComfyWorkflows": true,
	"Controlnet": true, "Detection": true, "DoRA": true, "Hypernetwork": true, "LLM": true, "LoCon": true,
	"LORA": true, "MotionModule": true, "Other": true, "Poses": true, "TextEncoder": true,
	"TextualInversion": true, "UNet": true, "Upscaler": true, "VAE": true, "VisionLanguage": true,
	"Wildcards": true, "Workflows": true,
}

// modelStatuses are the ModelStatus enum values.
var modelStatuses = map[string]bool{
	"Deleted": true, "Draft": true, "GatherInterest": true, "Published": true, "Scheduled": true,
	"Training": true, "Unpublished": true, "UnpublishedViolation": true,
}

// modelSorts are the ModelSort values; sortsPorted the ones this port answers (Recently Added needs a
// collection).
var sortsPorted = map[string]bool{
	SortHot: true, SortHighestRated: true, SortMostDownloaded: true, SortMostLiked: true, SortMostDiscussed: true,
	SortMostCollected: true, SortImageCount: true, SortNewest: true, SortOldest: true,
}

var periods = map[string]bool{"Day": true, "Week": true, "Month": true, "Year": true, "AllTime": true}

// primaryModelFileTypes (src/utils/file-display-helpers.ts).
var primaryModelFileTypes = map[string]bool{"Model": true, "Pruned Model": true, "Diffusion Model": true, "UNet": true}

// modelFileTypes is constants.modelFileTypes (src/server/common/constants.ts).
var modelFileTypes = map[string]bool{
	"Model": true, "Text Encoder": true, "Vision Encoder": true, "Pruned Model": true, "Negative": true,
	"Training Data": true, "VAE": true, "Config": true, "Archive": true, "UNet": true, "Diffusion Model": true,
	"CLIPVision": true, "ControlNet": true, "Workflow": true, "Upscaler": true, "Enhancement LoRA": true,
	"Other": true,
}
