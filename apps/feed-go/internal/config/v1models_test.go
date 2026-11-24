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
		err := V1Models{Serve: c.serve, FallbackURL: c.url}.Validate()
		if (err == nil) != c.ok {
			t.Errorf("serve=%v url=%q: %v, want ok %v", c.serve, c.url, err, c.ok)
		}
	}
}

// FEED_GO_SERVE_V1_IMAGES is off unless set to a true value, and is its own switch: the models one
// does not turn it on, nor it the models one.
func TestLoadV1ImagesServeDefaultsOff(t *testing.T) {
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "")
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "0": false, "true": true, "1": true, "yes": true} {
		t.Setenv("FEED_GO_SERVE_V1_IMAGES", in)
		if got := LoadV1Models().ServeImages; got != want {
			t.Errorf("FEED_GO_SERVE_V1_IMAGES=%q -> %v, want %v", in, got, want)
		}
	}
	t.Setenv("FEED_GO_SERVE_V1_IMAGES", "")
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "true")
	t.Setenv("FEED_GO_SERVE_MODEL_GETALL", "true")
	t.Setenv("FEED_GO_SERVE_INFINITE", "true")
	if c := LoadV1Models(); c.ServeImages || !c.Serve {
		t.Fatalf("FEED_GO_SERVE_V1_MODELS=true alone: ServeImages=%v Serve=%v, want false, true", c.ServeImages, c.Serve)
	}
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "")
	t.Setenv("FEED_GO_SERVE_V1_IMAGES", "true")
	if c := LoadV1Models(); !c.ServeImages || c.Serve {
		t.Fatalf("FEED_GO_SERVE_V1_IMAGES=true alone: ServeImages=%v Serve=%v, want true, false", c.ServeImages, c.Serve)
	}
}

// Serving the images route without the /api/v1 upstream is refused at startup too.
func TestV1ImagesValidate(t *testing.T) {
	for _, c := range []struct {
		serve bool
		url   string
		ok    bool
	}{
		{false, "", true},
		{true, "http://u.example", true},
		{true, "", false},
	} {
		err := V1Models{ServeImages: c.serve, FallbackURL: c.url}.Validate()
		if (err == nil) != c.ok {
			t.Errorf("serve images=%v url=%q: %v, want ok %v", c.serve, c.url, err, c.ok)
		}
	}
}
