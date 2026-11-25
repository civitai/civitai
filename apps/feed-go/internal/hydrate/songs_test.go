package hydrate

import (
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func songsImage(id int64, typ string, userID int64) superjson.Object {
	return superjson.Object{{Key: "id", Val: id}, {Key: "type", Val: typ}, {Key: "userId", Val: userID}}
}

func songsIDs(list []superjson.Object) []int {
	ids := make([]int, 0, len(list))
	for _, img := range list {
		n, _ := Int(ObjectField(img, "id"))
		ids = append(ids, n)
	}
	return ids
}

// withoutHiddenSongs: the shared showcase cache holds songs; a viewer who cannot see them keeps only
// their own, a signed-out viewer none, and a viewer who can see them keeps every image.
func TestWithoutHiddenSongs(t *testing.T) {
	byVersion := map[int][]superjson.Object{9: {songsImage(1, "image", 10), songsImage(2, "video", 10), songsImage(3, "audio", 10)}}
	for _, c := range []struct {
		name        string
		viewerID    int
		canSeeSongs bool
		want        []int
	}{
		{"signed out", 0, false, []int{1, 2}},
		{"stranger", 20, false, []int{1, 2}},
		{"owner", 10, false, []int{1, 2, 3}},
		{"music flag", 20, true, []int{1, 2, 3}},
	} {
		if got := songsIDs(WithoutHiddenSongs(byVersion, c.viewerID, c.canSeeSongs)[9]); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// The showcase cache is read by every viewer, so its lookup (getImagesForModelVersion with no user)
// fills it with no song, as Node's does: both write the same key.
func TestVersionImagesHoldNoSongs(t *testing.T) {
	if !strings.Contains(sqlVersionImages, `AND i."type" != 'audio'`) {
		t.Fatalf("the showcase lookup does not leave songs out:\n%s", sqlVersionImages)
	}
}
