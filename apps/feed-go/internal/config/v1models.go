package config

import (
	"os"
	"strings"
	"time"
)

// V1Models are the REST model shadows' settings (DESIGN.md §14.3), read apart from Config so the
// endpoint's knobs live in one place.
type V1Models struct {
	// BaseURL is NEXTAUTH_URL, the Node app's getBaseUrl(): the `[id]` body's download URL prefix.
	BaseURL string
	// CoverageNext mirrors `generation-coverage-next` (FEED_GO_GENERATION_COVERAGE_NEXT); nil when
	// unset or unreadable, and then every model answer falls back.
	CoverageNext *bool
	// BaseModelFeedMetrics mirrors `base-model-feed-metrics` (FEED_GO_BASE_MODEL_FEED_METRICS); nil
	// when unset, and then a `baseModels` list request falls back.
	BaseModelFeedMetrics *bool
	// ResponseCacheTTL is the `[id]` origin cache's logical TTL Node reads it with: CacheTTL.sm (180 s)
	// where the Node pods run with IS_DATAPACKET, which FEED_GO_MODEL_RESPONSE_CACHE mirrors (default
	// on); 0 = not read.
	ResponseCacheTTL time.Duration
}

// LoadV1Models reads the V1Models settings from the environment.
func LoadV1Models() V1Models {
	c := V1Models{
		BaseURL:              os.Getenv("NEXTAUTH_URL"),
		CoverageNext:         triBoolEnv("FEED_GO_GENERATION_COVERAGE_NEXT"),
		BaseModelFeedMetrics: triBoolEnv("FEED_GO_BASE_MODEL_FEED_METRICS"),
	}
	if boolEnv("FEED_GO_MODEL_RESPONSE_CACHE", true) {
		c.ResponseCacheTTL = 180 * time.Second
	}
	return c
}

// triBoolEnv reads a flag mirror: true, false, or nil when unset or not a boolean (the fail-safe:
// the answers the flag decides fall back).
func triBoolEnv(k string) *bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "true", "1":
		v := true
		return &v
	case "false", "0":
		v := false
		return &v
	}
	return nil
}
