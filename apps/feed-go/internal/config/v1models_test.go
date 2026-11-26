package config

import (
	"strings"
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

// FEED_GO_V1_MODELS_SERVE_QUERY is off unless set to a true value, and is its own switch; the search
// backend is the Node app's own SEARCH_HOST / SEARCH_API_KEY, bounded by MEILI_CALL_TIMEOUT_MS
// (default 2500 ms, Node's default). On without SEARCH_HOST, startup is refused.
func TestLoadV1ModelsServeQuery(t *testing.T) {
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "true")
	t.Setenv("FEED_GO_V1_BEARER_AUTH", "true")
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "true": true, "1": true} {
		t.Setenv("FEED_GO_V1_MODELS_SERVE_QUERY", in)
		if got := LoadV1Models().ServeQuery; got != want {
			t.Errorf("FEED_GO_V1_MODELS_SERVE_QUERY=%q -> %v, want %v", in, got, want)
		}
	}
	t.Setenv("SEARCH_HOST", " http://search.example.test:7700 ")
	t.Setenv("SEARCH_API_KEY", "k")
	t.Setenv("MEILI_CALL_TIMEOUT_MS", "")
	c := LoadV1Models()
	if c.SearchHost != "http://search.example.test:7700" || c.SearchAPIKey != "k" || c.SearchTimeout != 2500*time.Millisecond {
		t.Errorf("search settings %q %q %v", c.SearchHost, c.SearchAPIKey, c.SearchTimeout)
	}
	for in, want := range map[string]time.Duration{"800": 800 * time.Millisecond, "0": 2500 * time.Millisecond, "x": 2500 * time.Millisecond} {
		t.Setenv("MEILI_CALL_TIMEOUT_MS", in)
		if got := LoadV1Models().SearchTimeout; got != want {
			t.Errorf("MEILI_CALL_TIMEOUT_MS=%q -> %v, want %v", in, got, want)
		}
	}
	// The Node app's circuit settings: unset or not a positive integer is 0 (the client's default).
	t.Setenv("MEILI_CIRCUIT_TRIP_THRESHOLD", "")
	t.Setenv("MEILI_CIRCUIT_WINDOW_SECONDS", "x")
	t.Setenv("MEILI_CIRCUIT_COOLDOWN_SECONDS", "-3")
	if c := LoadV1Models(); c.CircuitTripThreshold != 0 || c.CircuitWindow != 0 || c.CircuitCooldown != 0 {
		t.Errorf("circuit defaults %d %v %v, want zeros", c.CircuitTripThreshold, c.CircuitWindow, c.CircuitCooldown)
	}
	t.Setenv("MEILI_CIRCUIT_TRIP_THRESHOLD", "7")
	t.Setenv("MEILI_CIRCUIT_WINDOW_SECONDS", "45")
	t.Setenv("MEILI_CIRCUIT_COOLDOWN_SECONDS", "12")
	if c := LoadV1Models(); c.CircuitTripThreshold != 7 || c.CircuitWindow != 45*time.Second || c.CircuitCooldown != 12*time.Second {
		t.Errorf("circuit settings %d %v %v, want 7 45s 12s", c.CircuitTripThreshold, c.CircuitWindow, c.CircuitCooldown)
	}
	for _, c := range []struct {
		serve bool
		host  string
		ok    bool
	}{{false, "", true}, {true, "h", true}, {true, "", false}} {
		err := V1Models{ServeQuery: c.serve, SearchHost: c.host}.Validate(false)
		if (err == nil) != c.ok {
			t.Errorf("serveQuery=%v host=%q: %v, want ok %v", c.serve, c.host, err, c.ok)
		}
	}
}

// FEED_GO_V1_MODELS_SERVE_DATA_MISS is off unless set to a true value; on without the miss
// computation (FEED_GO_COMPUTE_MISSES) startup is refused.
func TestLoadV1ModelsServeDataMiss(t *testing.T) {
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "true")
	t.Setenv("FEED_GO_COMPUTE_MISSES", "true")
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "true": true, "1": true} {
		t.Setenv("FEED_GO_V1_MODELS_SERVE_DATA_MISS", in)
		if got := LoadV1Models().ServeDataMiss; got != want {
			t.Errorf("FEED_GO_V1_MODELS_SERVE_DATA_MISS=%q -> %v, want %v", in, got, want)
		}
	}
	for _, c := range []struct{ on, compute, ok bool }{
		{false, false, true}, {false, true, true}, {true, true, true}, {true, false, false},
	} {
		err := V1Models{ServeDataMiss: c.on}.ValidateMisses(c.compute)
		if (err == nil) != c.ok {
			t.Errorf("serveDataMiss=%v computeMisses=%v: %v, want ok %v", c.on, c.compute, err, c.ok)
		}
	}
}

// FEED_GO_V1_MODELS_ANSWER_NOT_FOUND is off unless set to a true value, and is its own switch: the
// serve switch does not turn it on.
func TestLoadV1ModelsAnswerNotFound(t *testing.T) {
	t.Setenv("FEED_GO_SERVE_V1_MODELS", "true")
	for in, want := range map[string]bool{"": false, "false": false, "junk": false, "true": true, "1": true} {
		t.Setenv("FEED_GO_V1_MODELS_ANSWER_NOT_FOUND", in)
		if got := LoadV1Models().AnswerNotFound; got != want {
			t.Errorf("FEED_GO_V1_MODELS_ANSWER_NOT_FOUND=%q -> %v, want %v", in, got, want)
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

// Serving the images route without ITS upstream is refused at startup, the /api/v1 one notwithstanding
// (never used for it); its own alone starts. The models switch still needs the /api/v1 one.
func TestV1ImagesValidate(t *testing.T) {
	err := V1Models{ServeImages: true, FallbackURL: "http://u.example"}.Validate(false)
	if err == nil || !strings.Contains(err.Error(), "FEED_GO_V1_IMAGES_FALLBACK_URL") {
		t.Errorf("serve images with only the /api/v1 upstream: %v, want an error naming FEED_GO_V1_IMAGES_FALLBACK_URL", err)
	}
	for _, c := range []struct {
		serve, serveModels bool
		url, imagesURL     string
		ok                 bool
	}{
		{false, false, "", "", true},
		{true, false, "http://u.example", "", false},
		{true, false, "", "http://heavy.example", true},
		{true, false, "http://u.example", "http://heavy.example", true},
		{true, false, "", "", false},
		{true, true, "", "http://heavy.example", false},
	} {
		err := V1Models{ServeImages: c.serve, Serve: c.serveModels, FallbackURL: c.url, ImagesFallbackURL: c.imagesURL}.Validate(false)
		if (err == nil) != c.ok {
			t.Errorf("serve images=%v models=%v url=%q images url=%q: %v, want ok %v", c.serve, c.serveModels, c.url, c.imagesURL, err, c.ok)
		}
	}
	t.Setenv("FEED_GO_V1_IMAGES_FALLBACK_URL", " http://heavy.example.test:3000 ")
	if got := LoadV1Models().ImagesFallbackURL; got != "http://heavy.example.test:3000" {
		t.Errorf("ImagesFallbackURL = %q", got)
	}
	t.Setenv("FEED_GO_V1_IMAGES_FALLBACK_URL", "")
	if got := LoadV1Models().ImagesFallbackURL; got != "" {
		t.Errorf("ImagesFallbackURL unset = %q, want empty", got)
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
