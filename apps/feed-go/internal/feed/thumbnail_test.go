package feed

import (
	"reflect"
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
		if c.want == nil {
			// Denied: the key is omitted (undefined), never null.
			if _, undef := got.(superjson.Undefined); !undef {
				t.Errorf("servable %v viewer %+v: thumbnailUrl %#v, want undefined", c.servable, c.viewer, got)
			}
		} else if got != c.want {
			t.Errorf("servable %v viewer %+v: thumbnailUrl %#v, want %v", c.servable, c.viewer, got, c.want)
		}
		if lvl, _ := img.Wire.Get("nsfwLevel"); lvl != int64(8) {
			t.Errorf("servable %v viewer %+v: nsfwLevel %v, want 8", c.servable, c.viewer, lvl)
		}
	}
}

// The image item's key order is Node's (getAllImagesUncaptured: `...i`, then `model3dId` and
// `meta`, then `...feedThumbnailFields(...)`, whose `nsfwLevel` overrides in place and whose
// `thumbnailUrl` is added right after `meta`). The bytes carry the order, and the shadow compare
// reports any difference as key_order at the first item. The as-posts wire drops `meta`, so there
// `thumbnailUrl` follows `restricted`; image.getInfinite keeps `meta` and, on a collection page, the
// SELECT's two collection columns before it.
func TestImageItemKeyOrderFollowsNode(t *testing.T) {
	hy := &Hydrated{Thumbs: map[int]hydrate.Thumbnail{1: {URL: "u", NsfwLevel: 1, HasNsfwKey: true, Servable: true}}}
	r := RawImage{ID: 1, UserID: 5, PostID: 2, NsfwLevel: 1, Type: "video", PublishedAt: &published, Availability: "Public"}
	now := published.Add(time.Hour)

	asPosts := []string{"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hasMeta", "hasPositivePrompt",
		"onSite", "remixOfId", "createdAt", "sortAt", "type", "metadata", "ingestion", "blockedFor", "needsReview",
		"postId", "index", "publishedAt", "modelVersionId", "model3dId", "minor", "poi", "restricted",
		"thumbnailUrl", "modelVersionIds", "modelVersionIdsManual", "user", "stats", "reactions", "tags", "tagIds",
		"cosmetic", "eventDecoration"}
	if got := wireKeys(BuildImages([]RawImage{r}, hy, Viewer{}, now)[0].Wire); !reflect.DeepEqual(got, asPosts) {
		t.Errorf("as-posts keys = %v\nwant           %v", got, asPosts)
	}

	inCollection := r
	inCollection.Collection = &CollectionItem{Status: "ACCEPTED"}
	collection := []string{"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hasMeta", "hasPositivePrompt",
		"onSite", "remixOfId", "createdAt", "sortAt", "type", "metadata", "ingestion", "blockedFor", "needsReview",
		"postId", "index", "publishedAt", "modelVersionId", "model3dId", "availability", "minor", "poi", "restricted",
		"collectionItemStatus", "collectionItemAddedById", "meta", "thumbnailUrl", "modelVersionIds",
		"modelVersionIdsManual", "baseModel", "user", "stats", "reactions", "tags", "tagIds", "cosmetic",
		"eventDecoration", "judgeScore"}
	if got := wireKeys(BuildInfiniteImages([]RawImage{inCollection}, hy, Viewer{}, now)[0].Wire); !reflect.DeepEqual(got, collection) {
		t.Errorf("collection keys = %v\nwant             %v", got, collection)
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
