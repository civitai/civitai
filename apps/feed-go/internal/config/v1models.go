package config

import (
	"errors"
	"os"
	"strconv"
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
	// BearerAuth is FEED_GO_V1_BEARER_AUTH (default off): `GET /api/v1/models/{id}` decides an API
	// credential as the Node route does (DESIGN.md §16.10) instead of falling back on every one
	// (`bearer-token`); the list is unaffected. It reads keys with the tRPC routes' key resolver, so it
	// needs FEED_GO_BEARER_AUTH (Validate).
	BearerAuth bool
	// ServeQuery is FEED_GO_V1_MODELS_SERVE_QUERY (default off): a public `GET /api/v1/models` request
	// with a text `query` is answered here, from the search index the Node app reads (DESIGN.md
	// §16.11), instead of falling back (`v1-models-query`). Needs SearchHost (Validate).
	ServeQuery bool
	// SearchHost and SearchAPIKey are SEARCH_HOST and SEARCH_API_KEY, the Node app's own search
	// settings (its `searchClient`); SearchTimeout is MEILI_CALL_TIMEOUT_MS (default 2500 ms), the
	// bound the Node app puts on each search call (the client here caps it at
	// v1models.MaxSearchTimeout). With no SearchHost a text query always falls back.
	SearchHost    string
	SearchAPIKey  string
	SearchTimeout time.Duration
	// CircuitTripThreshold, CircuitWindow and CircuitCooldown are the Node app's search circuit
	// settings (MEILI_CIRCUIT_TRIP_THRESHOLD, MEILI_CIRCUIT_WINDOW_SECONDS,
	// MEILI_CIRCUIT_COOLDOWN_SECONDS); 0 (unset, or not a positive integer) = the Node app's default.
	CircuitTripThreshold int
	CircuitWindow        time.Duration
	CircuitCooldown      time.Duration
	// ServeDataMiss is FEED_GO_V1_MODELS_SERVE_DATA_MISS (default off): on the public
	// `GET /api/v1/models` route, a model-data cache miss is computed with the cache's own lookup
	// instead of falling back (`v1-models-data-miss`; DESIGN.md §16.7). A shadow sample computes it
	// whenever FEED_GO_COMPUTE_MISSES is on, this switch or not. Needs FEED_GO_COMPUTE_MISSES
	// (ValidateMisses).
	ServeDataMiss bool
	// AnswerNotFound is FEED_GO_V1_MODELS_ANSWER_NOT_FOUND (default off): a public
	// `GET /api/v1/models/{id}` request for a model the model statement returns no row for, with the
	// model's lag flag read clean, is answered here with Node's 404 (outcome `not_found`) instead of
	// falling back (`v1-models-not-found`; DESIGN.md §16.8). A not-found answer Go cannot decide that
	// way still falls back. It changes nothing while Serve is off.
	AnswerNotFound bool
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
		BearerAuth:        boolEnv("FEED_GO_V1_BEARER_AUTH", false),
		ServeQuery:        boolEnv("FEED_GO_V1_MODELS_SERVE_QUERY", false),
		SearchHost:        strings.TrimSpace(os.Getenv("SEARCH_HOST")),
		SearchAPIKey:      os.Getenv("SEARCH_API_KEY"),
		SearchTimeout:     2500 * time.Millisecond,
		ServeDataMiss:     boolEnv("FEED_GO_V1_MODELS_SERVE_DATA_MISS", false),
		AnswerNotFound:    boolEnv("FEED_GO_V1_MODELS_ANSWER_NOT_FOUND", false),
	}
	if ms, err := strconv.Atoi(strings.TrimSpace(os.Getenv("MEILI_CALL_TIMEOUT_MS"))); err == nil && ms > 0 {
		c.SearchTimeout = time.Duration(ms) * time.Millisecond
	}
	c.CircuitTripThreshold = positiveIntEnv("MEILI_CIRCUIT_TRIP_THRESHOLD", 0)
	c.CircuitWindow = time.Duration(positiveIntEnv("MEILI_CIRCUIT_WINDOW_SECONDS", 0)) * time.Second
	c.CircuitCooldown = time.Duration(positiveIntEnv("MEILI_CIRCUIT_COOLDOWN_SECONDS", 0)) * time.Second
	if boolEnv("FEED_GO_MODEL_RESPONSE_CACHE", true) {
		c.ResponseCacheTTL = 180 * time.Second
	}
	return c
}

// Validate refuses a serve switch with nowhere to send its fallbacks: FEED_GO_SERVE_V1_MODELS on
// without FEED_GO_V1_FALLBACK_URL, or FEED_GO_SERVE_V1_IMAGES on without FEED_GO_V1_IMAGES_FALLBACK_URL
// (its one upstream), would leave every request the port does not answer unanswerable. It also refuses
// FEED_GO_V1_BEARER_AUTH without bearerAuth (FEED_GO_BEARER_AUTH, Config.BearerAuth): with no key
// resolver every key would fall back anyway, so the setting would claim what it cannot do.
func (c V1Models) Validate(bearerAuth bool) error {
	if c.Serve && c.FallbackURL == "" {
		return errors.New("FEED_GO_SERVE_V1_MODELS is on without FEED_GO_V1_FALLBACK_URL: the public model routes need the Node app that serves /api/v1 for their fallbacks")
	}
	if c.ServeImages && c.ImagesFallbackURL == "" {
		return errors.New("FEED_GO_SERVE_V1_IMAGES is on without FEED_GO_V1_IMAGES_FALLBACK_URL: the public images route needs the Node app that serves /api/v1/images for its fallbacks (FEED_GO_V1_FALLBACK_URL is never used for it)")
	}
	if c.ServeQuery && c.SearchHost == "" {
		return errors.New("FEED_GO_V1_MODELS_SERVE_QUERY is on without SEARCH_HOST: a text query on GET /api/v1/models reads the search index the Node app reads")
	}
	if c.BearerAuth && !bearerAuth {
		return errors.New("FEED_GO_V1_BEARER_AUTH is on without FEED_GO_BEARER_AUTH: GET /api/v1/models/{id} reads API keys with the key resolver that switch turns on")
	}
	return nil
}

// ValidateMisses refuses FEED_GO_V1_MODELS_SERVE_DATA_MISS without computeMisses
// (FEED_GO_COMPUTE_MISSES, Config.ComputeMisses): with no miss computation every model-data miss
// would fall back anyway, so the setting would claim what it cannot do.
func (c V1Models) ValidateMisses(computeMisses bool) error {
	if c.ServeDataMiss && !computeMisses {
		return errors.New("FEED_GO_V1_MODELS_SERVE_DATA_MISS is on without FEED_GO_COMPUTE_MISSES: a model-data miss on GET /api/v1/models is computed by the miss computation that switch turns on")
	}
	return nil
}
