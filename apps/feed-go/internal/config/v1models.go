package config

import (
	"errors"
	"os"
	"strings"
	"time"
)

// V1Models are the REST model shadows' own settings (DESIGN.md §16.3), and the public `/api/v1`
// routes' switches and upstream (the images route's too, DESIGN.md §13.8), read apart from Config so
// the endpoints' knobs live in one place. The flags they share with model.getAll
// (`generation-coverage-next`, `base-model-feed-metrics`) are read once, by Load: Config.CoverageNext
// and Config.BaseModelFeedMetrics.
type V1Models struct {
	// BaseURL is NEXTAUTH_URL, the Node app's getBaseUrl(): the `[id]` body's download URL prefix.
	BaseURL string
	// ResponseCacheTTL is the `[id]` origin cache's logical TTL Node reads it with: CacheTTL.sm (180 s)
	// where the Node pods run with IS_DATAPACKET, which FEED_GO_MODEL_RESPONSE_CACHE mirrors (default
	// on); 0 = not read.
	ResponseCacheTTL time.Duration
	// Serve is FEED_GO_SERVE_V1_MODELS (default off): compute `GET /api/v1/models` and
	// `/api/v1/models/{id}` on the public listener. Off, every request there is proxied to FallbackURL.
	Serve bool
	// ServeImages is FEED_GO_SERVE_V1_IMAGES (default off): compute `GET /api/v1/images` on the public
	// listener. Off, every request there is proxied to FallbackURL (the same upstream: the Node app
	// that answers `/api/v1`).
	ServeImages bool
	// FallbackURL is FEED_GO_V1_FALLBACK_URL: the Node app that answers `/api/v1` today, a different
	// upstream from FEED_GO_FALLBACK_URL (which answers the tRPC routes). Every fallback of the two
	// public model routes is proxied to it; unset, the routes are not mounted.
	FallbackURL string
	// ImagesFallbackURL is FEED_GO_V1_IMAGES_FALLBACK_URL: the Node app that answers
	// `/api/v1/images`, every fallback of that route's is proxied to it. REQUIRED for the route: unset,
	// the route is not mounted (FallbackURL is never used for it: the pool answering /api/v1 need not
	// be the one answering this, the heaviest REST route), and serving it fails startup.
	ImagesFallbackURL string
}

// LoadV1Models reads the V1Models settings from the environment.
func LoadV1Models() V1Models {
	c := V1Models{
		BaseURL:     os.Getenv("NEXTAUTH_URL"),
		Serve:       boolEnv("FEED_GO_SERVE_V1_MODELS", false),
		ServeImages: boolEnv("FEED_GO_SERVE_V1_IMAGES", false),
		FallbackURL: strings.TrimSpace(os.Getenv("FEED_GO_V1_FALLBACK_URL")),
		// The images route's own upstream (never FallbackURL's).
		ImagesFallbackURL: strings.TrimSpace(os.Getenv("FEED_GO_V1_IMAGES_FALLBACK_URL")),
	}
	if boolEnv("FEED_GO_MODEL_RESPONSE_CACHE", true) {
		c.ResponseCacheTTL = 180 * time.Second
	}
	return c
}

// Validate refuses a serve switch with nowhere to send its fallbacks: FEED_GO_SERVE_V1_MODELS on
// without FEED_GO_V1_FALLBACK_URL, or FEED_GO_SERVE_V1_IMAGES on without FEED_GO_V1_IMAGES_FALLBACK_URL
// (its one upstream), would leave every request the port does not answer unanswerable.
func (c V1Models) Validate() error {
	if c.Serve && c.FallbackURL == "" {
		return errors.New("FEED_GO_SERVE_V1_MODELS is on without FEED_GO_V1_FALLBACK_URL: the public model routes need the Node app that serves /api/v1 for their fallbacks")
	}
	if c.ServeImages && c.ImagesFallbackURL == "" {
		return errors.New("FEED_GO_SERVE_V1_IMAGES is on without FEED_GO_V1_IMAGES_FALLBACK_URL: the public images route needs the Node app that serves /api/v1/images for its fallbacks (FEED_GO_V1_FALLBACK_URL is never used for it)")
	}
	return nil
}
