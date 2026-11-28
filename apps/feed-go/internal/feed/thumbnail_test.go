package feed

import (
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// feedThumbnailFields (src/server/services/image.service.ts): the url for a thumbnail with no block
// marker, for a moderator, and for the creator only where `ownerMediaAllowed` (#10505) leaves them
// the media. The creator is user 5.
func TestBuildImageThumbnailURL(t *testing.T) {
	r := RawImage{ID: 1, UserID: 5, NsfwLevel: 1, Type: "video"}
	for _, c := range []struct {
		servable, ownerAllowed bool
		viewer                 Viewer
		want                   any
	}{
		{true, false, Viewer{}, "u"},
		{true, false, Viewer{ID: 9}, "u"},
		{false, false, Viewer{}, nil},
		{false, true, Viewer{}, nil},
		// A viewer who is not the creator: refused, whatever the owner's rule says.
		{false, false, Viewer{ID: 9}, nil},
		{false, true, Viewer{ID: 9}, nil},
		// The creator: refused under a block that refuses the owner the media, served under one
		// that leaves it to them.
		{false, false, Viewer{ID: 5}, nil},
		{false, true, Viewer{ID: 5}, "u"},
		{false, false, Viewer{ID: 9, IsModerator: true}, "u"},
		{false, false, Viewer{ID: 5, IsModerator: true}, "u"},
	} {
		hy := &Hydrated{Thumbs: map[int]hydrate.Thumbnail{1: {URL: "u", NsfwLevel: 8, HasNsfwKey: true, Servable: c.servable, OwnerMediaAllowed: c.ownerAllowed}}}
		img := buildImage(r, hy, c.viewer)
		got, _ := img.Wire.Get("thumbnailUrl")
		if c.want == nil {
			// Denied: the key is omitted (undefined), never null.
			if _, undef := got.(superjson.Undefined); !undef {
				t.Errorf("servable %v ownerAllowed %v viewer %+v: thumbnailUrl %#v, want undefined", c.servable, c.ownerAllowed, c.viewer, got)
			}
		} else if got != c.want {
			t.Errorf("servable %v ownerAllowed %v viewer %+v: thumbnailUrl %#v, want %v", c.servable, c.ownerAllowed, c.viewer, got, c.want)
		}
		if lvl, _ := img.Wire.Get("nsfwLevel"); lvl != int64(8) {
			t.Errorf("servable %v ownerAllowed %v viewer %+v: nsfwLevel %v, want 8", c.servable, c.ownerAllowed, c.viewer, lvl)
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

// Through BuildImages (as-posts) and BuildInfiniteImages (image.getInfinite): the creator of two
// block-marked videos gets the thumbnail only where ownerMediaAllowed is true.
func TestBuildImagesThumbnailURLForTheCreator(t *testing.T) {
	hy := &Hydrated{Thumbs: map[int]hydrate.Thumbnail{
		1: {URL: "allowed", NsfwLevel: 1, HasNsfwKey: true, OwnerMediaAllowed: true},
		2: {URL: "refused", NsfwLevel: 1, HasNsfwKey: true},
	}}
	rows := []RawImage{{ID: 1, UserID: 5, NsfwLevel: 1, Type: "video"}, {ID: 2, UserID: 5, NsfwLevel: 1, Type: "video"}}
	for name, imgs := range map[string][]Image{
		"as-posts": BuildImages(rows, hy, Viewer{ID: 5}, time.Now()),
		"infinite": BuildInfiniteImages(rows, hy, Viewer{ID: 5}, time.Now()),
	} {
		if len(imgs) != 2 {
			t.Fatalf("%s: images %d, want 2", name, len(imgs))
		}
		if got, _ := imgs[0].Wire.Get("thumbnailUrl"); got != "allowed" {
			t.Errorf("%s: allowed thumbnailUrl %#v, want allowed", name, got)
		}
		if got, _ := imgs[1].Wire.Get("thumbnailUrl"); got != (superjson.Undefined{}) {
			t.Errorf("%s: refused thumbnailUrl %#v, want undefined", name, got)
		}
	}
}
