package config

import (
	"strings"
	"testing"
)

// The images route's API-key switches and its serve-parity switch default off, read as the other
// switches do, and are each refused at startup without what they rest on: the key resolver
// (FEED_GO_BEARER_AUTH) for both key switches, the public route (FEED_GO_SERVE_V1_IMAGES) for the serve
// one, and the route's own upstream (FEED_GO_V1_IMAGES_FALLBACK_URL) for parity. Literal table.
func TestV1ImagesBearerAndParitySwitches(t *testing.T) {
	for _, name := range []string{"FEED_GO_V1_IMAGES_BEARER_AUTH", "FEED_GO_V1_IMAGES_SERVE_BEARER", "FEED_GO_SERVE_PARITY_V1_IMAGES", "FEED_GO_V1_BEARER_AUTH"} {
		t.Setenv(name, "")
	}
	if c := LoadV1Models(); c.ImagesBearerAuth || c.ImagesServeBearer || c.ParityImages {
		t.Fatalf("unset: %+v, want all three off", c)
	}
	t.Setenv("FEED_GO_V1_IMAGES_BEARER_AUTH", "true")
	if c := LoadV1Models(); !c.ImagesBearerAuth || c.ImagesServeBearer || c.ParityImages || c.BearerAuth {
		t.Fatalf("the shadow switch alone: %+v", c)
	}
	t.Setenv("FEED_GO_V1_IMAGES_BEARER_AUTH", "")
	t.Setenv("FEED_GO_V1_IMAGES_SERVE_BEARER", "1")
	if c := LoadV1Models(); c.ImagesBearerAuth || !c.ImagesServeBearer || c.ParityImages {
		t.Fatalf("the serve switch alone: %+v", c)
	}
	t.Setenv("FEED_GO_V1_IMAGES_SERVE_BEARER", "")
	t.Setenv("FEED_GO_SERVE_PARITY_V1_IMAGES", "yes")
	if c := LoadV1Models(); c.ImagesBearerAuth || c.ImagesServeBearer || !c.ParityImages {
		t.Fatalf("the parity switch alone: %+v", c)
	}
	const up = "http://trpc.example"
	for _, c := range []struct {
		name string
		v    V1Models
		keys bool
		want string // "" = starts; else a name the error must carry
	}{
		{"shadow switch with keys", V1Models{ImagesBearerAuth: true}, true, ""},
		{"shadow switch without keys", V1Models{ImagesBearerAuth: true}, false, "FEED_GO_V1_IMAGES_BEARER_AUTH"},
		{"serve switch, keys, route on", V1Models{ImagesServeBearer: true, ServeImages: true, ImagesFallbackURL: up}, true, ""},
		{"serve switch without keys", V1Models{ImagesServeBearer: true, ServeImages: true, ImagesFallbackURL: up}, false, "FEED_GO_V1_IMAGES_SERVE_BEARER"},
		{"serve switch, route off", V1Models{ImagesServeBearer: true}, true, "FEED_GO_SERVE_V1_IMAGES"},
		{"parity with the route's upstream", V1Models{ParityImages: true, ImagesFallbackURL: up}, false, ""},
		{"parity without it", V1Models{ParityImages: true}, false, "FEED_GO_V1_IMAGES_FALLBACK_URL"},
	} {
		err := c.v.Validate(c.keys)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s: %v, want it to start", c.name, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%s: %v, want an error naming %s", c.name, err, c.want)
		}
	}
}
