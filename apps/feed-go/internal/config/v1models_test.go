package config

import (
	"testing"
	"time"
)

func TestLoadV1Models(t *testing.T) {
	t.Setenv("NEXTAUTH_URL", "https://site.example.test")
	t.Setenv("FEED_GO_MODEL_RESPONSE_CACHE", "")
	c := LoadV1Models()
	if c.BaseURL != "https://site.example.test" {
		t.Errorf("BaseURL = %q", c.BaseURL)
	}
	// Default on: the origin cache is read with CacheTTL.sm.
	if c.ResponseCacheTTL != 180*time.Second {
		t.Errorf("ResponseCacheTTL (default) = %v, want 180s", c.ResponseCacheTTL)
	}
	t.Setenv("FEED_GO_MODEL_RESPONSE_CACHE", "false")
	if got := LoadV1Models().ResponseCacheTTL; got != 0 {
		t.Errorf("ResponseCacheTTL (off) = %v, want 0", got)
	}
}
