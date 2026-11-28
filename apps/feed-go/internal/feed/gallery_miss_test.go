package feed

import (
	"context"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// What getGallerySettingsByModelId writes for a held model, for a model with no settings (the `none`
// marker) and for an unheld one with settings: Node's own output for the rows of
// hydrate.TestGallerySettingsWrittenAsNodeWritesThem, which asserts feed-go writes these same bytes.
const (
	writtenHeld   = `{"hiddenTags":[{"id":9001,"name":"anime"},{"id":9002,"name":"nsfw \"x\""}],"hiddenUsers":[{"id":1201,"username":"hidden_one"}],"hiddenImages":{"6001":[8099]},"level":3,"pinnedPosts":{"9":[2],"10":[3]},"creatorHiddenUserIds":[1301,1302],"sfwHeld":true}`
	writtenNone   = `{"none":true,"hiddenTags":[],"hiddenUsers":[],"hiddenImages":{},"pinnedPosts":{}}`
	writtenUnheld = `{"hiddenTags":[],"hiddenUsers":[{"id":1202,"username":null}],"hiddenImages":null,"level":1,"pinnedPosts":{},"creatorHiddenUserIds":[],"sfwHeld":false}`
)

// A written-back entry is a hit this service's reader serves (not a `gallery-settings-stale` rebuild):
// the held one at level 3 with its pinned posts, the `none` marker as no settings, the unheld one not
// held. So once feed-go writes a miss back, the next read of that model, Node's or feed-go's, is a hit.
func TestWrittenGallerySettingsAreHits(t *testing.T) {
	held, err := ParseGallerySettings([]byte(writtenHeld))
	if err != nil {
		t.Fatal(err)
	}
	if lvl, ok := held.HeldLevel(); !ok || lvl != 3 {
		t.Errorf("held entry: level %d held %v, want 3 true", lvl, ok)
	}
	if p9, p10 := held.PinnedFor(9), held.PinnedFor(10); !reflect.DeepEqual(p9, []int{2}) || !reflect.DeepEqual(p10, []int{3}) {
		t.Errorf("held entry pins %v %v, want [2] [3]", p9, p10)
	}
	if s, err := ParseGallerySettings([]byte(writtenNone)); err != nil || s != nil {
		t.Errorf("none marker: %v (%v), want no settings", s, err)
	}
	unheld, err := ParseGallerySettings([]byte(writtenUnheld))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := unheld.HeldLevel(); ok || unheld.Level == nil || *unheld.Level != 1 {
		t.Errorf("unheld entry: %+v", unheld)
	}

	// Read through the store, under the key the write-back writes.
	r := testkit.NewRedis()
	r.SetString("ns:model:gallery-settings:7101", []byte(writtenHeld))
	r.SetString("ns:model:gallery-settings:7102", []byte(writtenNone))
	got, err := (&GalleryStore{Cache: r, Prefix: "ns:"}).SettingsMany(context.Background(), []int{7101, 7102})
	if err != nil {
		t.Fatal(err)
	}
	if got[7101] == nil || *got[7101].Level != 3 || !*got[7101].SfwHeld || got[7102] != nil {
		t.Errorf("store read %v", got)
	}
}

type fakeHolds struct {
	holds map[int]hydrate.GalleryHold
	asked [][]int
}

func (f *fakeHolds) GalleryHolds(_ context.Context, ids []int) (map[int]hydrate.GalleryHold, error) {
	f.asked = append(f.asked, ids)
	return f.holds, nil
}

// HoldComputingGallery (GET /api/v1/images with FEED_GO_V1_IMAGES_SERVE_GALLERY_SETTINGS_MISS on)
// answers only the absent keys from the hold source, keeps cached ones, and leaves a model with no row
// as no settings; without a source it is the store, whose miss falls back.
func TestHoldComputingGalleryAnswersMisses(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("model:gallery-settings:7401", []byte(`{"level":1,"sfwHeld":true,"pinnedPosts":{}}`))
	store := &GalleryStore{Cache: r}
	src := &fakeHolds{holds: map[int]hydrate.GalleryHold{7402: {Held: true, Level: 2}, 7403: {}}}
	got, err := heldLevels(context.Background(), HoldComputingGallery(store, src), []int{7401, 7402, 7403, 7404}, "v1-held-level-unset")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[int]int{7401: 1, 7402: 2}; !reflect.DeepEqual(got, want) {
		t.Errorf("held levels %v, want %v", got, want)
	}
	if !reflect.DeepEqual(src.asked, [][]int{{7402, 7403, 7404}}) {
		t.Errorf("asked %v, want only the misses", src.asked)
	}
	if _, err := heldLevels(context.Background(), HoldComputingGallery(store, nil), []int{7402}, "v1-held-level-unset"); fallback.Reason(err) != "gallery-settings-miss" {
		t.Errorf("no source: %v, want gallery-settings-miss", err)
	}
}
