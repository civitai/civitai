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

// FEED_GO_SERVE_V1_MODELS is off unless set to a true value; its fallback URL is read as given.
func TestLoadV1ModelsServeDefaultsOff(t *testing.T) {
	t.Setenv("FEED_GO_V1_FALLBACK_URL", "")
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "0": false, "true": true, "1": true, "yes": true} {
		t.Setenv("FEED_GO_SERVE_V1_MODELS", in)
		if got := LoadV1Models().Serve; got != want {
			t.Errorf("FEED_GO_SERVE_V1_MODELS=%q -> %v, want %v", in, got, want)
		}
	}
	// Its own switch: the other serve switches do not turn it on.
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "")
	t.Setenv("FEED_GO_SERVE_MODEL_GETALL", "true")
	t.Setenv("FEED_GO_SERVE_INFINITE", "true")
	if LoadV1Models().Serve {
		t.Fatal("the model.getAll / image.getInfinite switches turned the v1 models one on")
	}
	t.Setenv("FEED_GO_V1_FALLBACK_URL", " http://upstream.example.test:3000 ")
	if got := LoadV1Models().FallbackURL; got != "http://upstream.example.test:3000" {
		t.Errorf("FallbackURL = %q", got)
	}
}

// Serving without the /api/v1 upstream is refused at startup; every other combination starts.
func TestV1ModelsValidate(t *testing.T) {
	for _, c := range []struct {
		serve bool
		url   string
		ok    bool
	}{
		{false, "", true},
		{false, "http://u.example", true},
		{true, "http://u.example", true},
		{true, "", false},
	} {
		err := V1Models{Serve: c.serve, FallbackURL: c.url}.Validate(false)
		if (err == nil) != c.ok {
			t.Errorf("serve=%v url=%q: %v, want ok %v", c.serve, c.url, err, c.ok)
		}
	}
}

// FEED_GO_V1_BEARER_AUTH defaults off, reads as the other switches do, and is refused at startup
// without FEED_GO_BEARER_AUTH (the key resolver it uses); with it, it starts.
func TestV1ModelsBearerAuthSwitch(t *testing.T) {
	t.Setenv("FEED_GO_V1_BEARER_AUTH", "")
	if LoadV1Models().BearerAuth {
		t.Fatal("FEED_GO_V1_BEARER_AUTH unset reads as on")
	}
	t.Setenv("FEED_GO_V1_BEARER_AUTH", "true")
	if !LoadV1Models().BearerAuth {
		t.Fatal("FEED_GO_V1_BEARER_AUTH=true reads as off")
	}
	for _, c := range []struct {
		v1, keys, ok bool
	}{
		{false, false, true},
		{false, true, true},
		{true, true, true},
		{true, false, false},
	} {
		err := V1Models{BearerAuth: c.v1}.Validate(c.keys)
		if (err == nil) != c.ok {
			t.Errorf("v1=%v keys=%v: %v, want ok %v", c.v1, c.keys, err, c.ok)
		}
	}
}
