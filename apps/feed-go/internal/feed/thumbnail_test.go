package feed

import (
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestBuildImageThumbnailURL(t *testing.T) {
	r := RawImage{ID: 1, UserID: 5, NsfwLevel: 1, Type: "video"}
	for _, c := range []struct {
		servable bool
		viewer   Viewer
		want     any
	}{
		{true, Viewer{}, "u"},
		{false, Viewer{}, nil},
		{false, Viewer{ID: 9}, nil},
		{false, Viewer{ID: 5}, "u"},
		{false, Viewer{ID: 9, IsModerator: true}, "u"},
	} {
		hy := &Hydrated{Thumbs: map[int]hydrate.Thumbnail{1: {URL: "u", NsfwLevel: 8, HasNsfwKey: true, Servable: c.servable}}}
		img := buildImage(r, hy, c.viewer)
		got, _ := img.Wire.Get("thumbnailUrl")
		if _, undef := got.(superjson.Undefined); undef {
			got = nil
		}
		if got != c.want {
			t.Errorf("servable %v viewer %+v: thumbnailUrl %v, want %v", c.servable, c.viewer, got, c.want)
		}
		if lvl, _ := img.Wire.Get("nsfwLevel"); lvl != int64(8) {
			t.Errorf("servable %v viewer %+v: nsfwLevel %v, want 8", c.servable, c.viewer, lvl)
		}
	}
}

func TestBuildImagesThumbnailURLForTheCreator(t *testing.T) {
	hy := &Hydrated{Thumbs: map[int]hydrate.Thumbnail{1: {URL: "u", NsfwLevel: 1, HasNsfwKey: true}}}
	imgs := BuildImages([]RawImage{{ID: 1, UserID: 5, NsfwLevel: 1, Type: "video"}}, hy, Viewer{ID: 5}, time.Now())
	if len(imgs) != 1 {
		t.Fatalf("images %d, want 1", len(imgs))
	}
	if got, _ := imgs[0].Wire.Get("thumbnailUrl"); got != "u" {
		t.Fatalf("thumbnailUrl %v, want u", got)
	}
}
