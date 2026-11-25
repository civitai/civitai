package config

import (
	"errors"
	"os"
	"strings"
)

// SiteSearch is the `POST /api/search/[...path]` port's settings (DESIGN.md §18.3), read apart from
// Config so the endpoint's knobs live in one place.
type SiteSearch struct {
	// Serve is FEED_GO_SERVE_SEARCH (default off): compute `/api/search/*` on the public listener. Off,
	// every request there is the `search-off` fallback, proxied to FallbackURL as it came.
	Serve bool
	// FallbackURL is FEED_GO_SEARCH_FALLBACK_URL: the Node app that answers `/api/search` today. Every
	// fallback of the public route is proxied to it; unset, the route is not mounted. Never defaulted to
	// another route's upstream.
	FallbackURL string
	// Host is NEXT_PUBLIC_SEARCH_HOST and APIKey SEARCH_TOKEN_API_KEY, else SEARCH_API_KEY (`??`: an
	// unset SEARCH_TOKEN_API_KEY, not an empty one, reads the second): the backend and key postToSearch
	// uses. Only the public route calls the backend (the shadow reshapes the response Node recorded).
	Host   string
	APIKey string
}

// LoadSiteSearch reads the SiteSearch settings from the environment.
func LoadSiteSearch() SiteSearch {
	key, ok := os.LookupEnv("SEARCH_TOKEN_API_KEY")
	if !ok {
		key = os.Getenv("SEARCH_API_KEY")
	}
	return SiteSearch{
		Serve:       boolEnv("FEED_GO_SERVE_SEARCH", false),
		FallbackURL: strings.TrimSpace(os.Getenv("FEED_GO_SEARCH_FALLBACK_URL")),
		Host:        strings.TrimSpace(os.Getenv("NEXT_PUBLIC_SEARCH_HOST")),
		APIKey:      key,
	}
}

// Validate refuses FEED_GO_SERVE_SEARCH without the route's upstream (FEED_GO_SEARCH_FALLBACK_URL) or
// without the search backend (NEXT_PUBLIC_SEARCH_HOST): the route could then answer nothing it falls
// back on, or nothing at all.
func (c SiteSearch) Validate() error {
	if c.Serve && c.FallbackURL == "" {
		return errors.New("FEED_GO_SERVE_SEARCH is on without FEED_GO_SEARCH_FALLBACK_URL: the public /api/search route needs the Node app that serves it for its fallbacks")
	}
	if c.Serve && c.Host == "" {
		return errors.New("FEED_GO_SERVE_SEARCH is on without NEXT_PUBLIC_SEARCH_HOST: the public /api/search route reads the search backend the Node app reads")
	}
	return nil
}
