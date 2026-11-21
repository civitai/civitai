package feed

import (
	"testing"
	"time"
	"unsafe"

	"github.com/civitai/civitai/apps/feed-go/internal/devalue"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func wireField(t *testing.T, o superjson.Object, key string) any {
	t.Helper()
	v, ok := o.Get(key)
	if !ok {
		t.Fatalf("no %q in %v", key, o)
	}
	return v
}

// The Node answer holds ONE Date per image for `sortAt` and `publishedAt`
// (`publishedAt: i.publishedAt ? i.sortAt : undefined`), copied onto the post with the post's `user`,
// and one `deletedAt` Date per creator; devalue writes each such instance once. These identities are
// what the devalue writer reads (a shared pointer / backing array), so they are pinned here.
func TestWireSharesTheInstancesNodeShares(t *testing.T) {
	at := time.Date(2026, 6, 12, 10, 0, 0, 0, time.UTC)
	pub := at.Add(-time.Hour)
	deleted := new(time.Time)
	*deleted = at.Add(-48 * time.Hour)
	hy := &Hydrated{Basic: map[int]hydrate.BasicUser{5: {ID: 5, Username: "gone", DeletedAt: deleted}}}
	rows := []RawImage{
		{ID: 1, UserID: 5, PostID: 9, SortAt: at, PublishedAt: &pub},
		{ID: 2, UserID: 5, PostID: 9, SortAt: at, PublishedAt: &pub},
		{ID: 3, UserID: 5, PostID: 9, SortAt: at}, // unpublished: publishedAt undefined
	}
	imgs := BuildImages(rows, hy, Viewer{IsModerator: true}, at)
	if len(imgs) != 3 {
		t.Fatalf("%d images", len(imgs))
	}
	var dates []*time.Time
	for i, img := range imgs {
		sortAt, ok := wireField(t, img.Wire, "sortAt").(*time.Time)
		if !ok || !sortAt.Equal(at) {
			t.Fatalf("image %d: sortAt %#v, want a *time.Time of %v", i, wireField(t, img.Wire, "sortAt"), at)
		}
		dates = append(dates, sortAt)
		published := wireField(t, img.Wire, "publishedAt")
		if i < 2 && published != any(sortAt) {
			t.Fatalf("image %d: publishedAt %#v is not its sortAt Date", i, published)
		}
		if _, undef := published.(superjson.Undefined); i == 2 && !undef {
			t.Fatalf("unpublished image: publishedAt %#v, want undefined", published)
		}
		user, _ := wireField(t, img.Wire, "user").(superjson.Object)
		if d := wireField(t, user, "deletedAt"); d != any(deleted) {
			t.Fatalf("image %d: user.deletedAt %#v is not the creator's one Date", i, d)
		}
	}
	if dates[0] == dates[1] {
		t.Fatal("two images share one sortAt Date; Node has one per image")
	}
	p := buildPost(9, imgs, SortMostReactions, nil, false, false)
	if wireField(t, p.wire, "sortAt") != any(dates[0]) || wireField(t, p.wire, "publishedAt") != any(dates[0]) {
		t.Fatalf("post sortAt %#v / publishedAt %#v are not its first image's Date", wireField(t, p.wire, "sortAt"), wireField(t, p.wire, "publishedAt"))
	}
	postUser, _ := wireField(t, p.wire, "user").(superjson.Object)
	imgUser, _ := wireField(t, imgs[0].Wire, "user").(superjson.Object)
	if unsafe.SliceData(postUser) != unsafe.SliceData(imgUser) || len(postUser) != len(imgUser) {
		t.Fatal("the post's user is not its first image's user object")
	}
	// So the devalue body writes the first image's sortAt once for the post and the image: one Date per
	// image's sortAt (3) and createdAt (3, a column of each row), the post's createdAt
	// (`new Date(i.sortAt)`, a Date of its own) and the creator's one deletedAt: 8.
	text, err := devalue.Stringify(p.wire)
	if err != nil {
		t.Fatal(err)
	}
	if n := countDates(text); n != 8 {
		t.Fatalf("%d Date entries, want 8: %s", n, text)
	}
}

func countDates(s string) int {
	n := 0
	for i := 0; i+8 <= len(s); i++ {
		if s[i:i+8] == `["Date",` {
			n++
		}
	}
	return n
}
