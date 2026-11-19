package config

import (
	"os"
	"time"
)

// V1Models are the REST model shadows' own settings (DESIGN.md §16.3), read apart from Config so the
// endpoint's knobs live in one place. The flags they share with model.getAll
// (`generation-coverage-next`, `base-model-feed-metrics`) are read once, by Load: Config.CoverageNext
// and Config.BaseModelFeedMetrics.
type V1Models struct {
	// BaseURL is NEXTAUTH_URL, the Node app's getBaseUrl(): the `[id]` body's download URL prefix.
	BaseURL string
	// ResponseCacheTTL is the `[id]` origin cache's logical TTL Node reads it with: CacheTTL.sm (180 s)
	// where the Node pods run with IS_DATAPACKET, which FEED_GO_MODEL_RESPONSE_CACHE mirrors (default
	// on); 0 = not read.
	ResponseCacheTTL time.Duration
}

// LoadV1Models reads the V1Models settings from the environment.
func LoadV1Models() V1Models {
	c := V1Models{BaseURL: os.Getenv("NEXTAUTH_URL")}
	if boolEnv("FEED_GO_MODEL_RESPONSE_CACHE", true) {
		c.ResponseCacheTTL = 180 * time.Second
	}
	return c
}
