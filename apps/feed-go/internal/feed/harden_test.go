package feed

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// gatedPosts holds every completion fetch until `want` are in flight at once (or a timeout), so the
// highest concurrency reached is deterministic rather than a race against a sleep.
type gatedPosts struct {
	want     int
	mu       sync.Mutex
	inFlight int
	maxSeen  int
	calls    int
	release  chan struct{}
	once     sync.Once
}

func (g *gatedPosts) Page(context.Context, Cursor, int) ([]Image, Cursor, error) {
	return nil, Cursor{}, nil
}

func (g *gatedPosts) Posts(ctx context.Context, _ []int, _ int) ([]Image, error) {
	g.mu.Lock()
	g.calls++
	g.inFlight++
	g.maxSeen = max(g.maxSeen, g.inFlight)
	if g.inFlight >= g.want {
		g.once.Do(func() { close(g.release) })
	}
	g.mu.Unlock()
	select {
	case <-g.release:
	case <-time.After(2 * time.Second):
	case <-ctx.Done():
	}
	g.mu.Lock()
	g.inFlight--
	g.mu.Unlock()
	return nil, nil
}

func twelveFullPosts() (map[int][]Image, []int, map[int]int) {
	posts := map[int][]Image{}
	counts := map[int]int{}
	var ids []int
	for id := 1; id <= 12; id++ {
		posts[id] = []Image{pimg(id*100, id)}
		counts[id] = completionRowsPerFetch // one completion fetch per post
		ids = append(ids, id)
	}
	return posts, ids, counts
}

// The cap is configurable: at 8, eight of the twelve completion fetches run at once, never more.
func TestCompletePostsConcurrencyIsConfigurable(t *testing.T) {
	posts, ids, counts := twelveFullPosts()
	src := &gatedPosts{want: 8, release: make(chan struct{})}
	if err := completePosts(context.Background(), src, posts, ids, counts, 8); err != nil {
		t.Fatal(err)
	}
	if src.calls != 12 || src.maxSeen != 8 {
		t.Fatalf("calls=%d maxSeen=%d, want 12 and 8", src.calls, src.maxSeen)
	}
}

// Unset (0) keeps the shadow-safe default of 4.
func TestCompletePostsDefaultConcurrencyIsFour(t *testing.T) {
	if DefaultCompletionConcurrency != 4 {
		t.Fatalf("DefaultCompletionConcurrency = %d, want 4", DefaultCompletionConcurrency)
	}
	posts, ids, counts := twelveFullPosts()
	src := &gatedPosts{want: 4, release: make(chan struct{})}
	if err := completePosts(context.Background(), src, posts, ids, counts, 0); err != nil {
		t.Fatal(err)
	}
	if src.calls != 12 || src.maxSeen != 4 {
		t.Fatalf("calls=%d maxSeen=%d, want 12 and 4", src.calls, src.maxSeen)
	}
}

type panickingPosts struct{}

func (panickingPosts) Page(context.Context, Cursor, int) ([]Image, Cursor, error) {
	return nil, Cursor{}, nil
}
func (panickingPosts) Posts(context.Context, []int, int) ([]Image, error) {
	var m map[int]int
	m[1] = 1 // assignment to a nil map
	return nil, nil
}

// A panic inside a completion worker (its own goroutine, out of reach of the request's recover) must
// come back as an error rather than kill the process.
func TestCompletePostsWorkerPanicIsAnError(t *testing.T) {
	posts := map[int][]Image{10: {pimg(1, 10)}}
	err := completePosts(context.Background(), panickingPosts{}, posts, []int{10}, map[int]int{10: 2}, 0)
	var pe *safe.PanicError
	if !errors.As(err, &pe) {
		t.Fatalf("err = %v, want a *safe.PanicError", err)
	}
}

// panickingHydrator panics in one hydration lookup; every other lookup answers empty.
type panickingHydrator struct{}

func (panickingHydrator) BasicUsers(context.Context, []int) (map[int]hydrate.BasicUser, error) {
	return nil, nil
}
func (panickingHydrator) UserCosmetics(context.Context, []int) (map[int][]any, error) {
	return nil, nil
}
func (panickingHydrator) ProfilePictures(context.Context, []int) (map[int]superjson.Object, error) {
	return nil, nil
}
func (panickingHydrator) ImageFrames(context.Context, []int) (map[int]superjson.Object, error) {
	return nil, nil
}
func (panickingHydrator) Thumbnails(context.Context, []int) (map[int]hydrate.Thumbnail, error) {
	return nil, nil
}
func (panickingHydrator) ImageMetrics(context.Context, []int) (map[int]hydrate.Metrics, error) {
	panic("metrics lookup exploded")
}
func (panickingHydrator) TagIDs(context.Context, []int) (map[int]any, error) { return nil, nil }
func (panickingHydrator) EventDecorations(context.Context, []int, map[string]bool) (map[int]superjson.Object, error) {
	return nil, nil
}
func (panickingHydrator) Reactions(context.Context, []int, int) (map[int][]any, error) {
	return nil, nil
}
func (panickingHydrator) VisibleModel3DIDs(context.Context, []int, int, bool) (map[int]bool, error) {
	return nil, nil
}

func TestHydrateWorkerPanicIsAnError(t *testing.T) {
	_, err := Hydrate(context.Background(), panickingHydrator{}, []RawImage{{ID: 1, UserID: 2}}, Viewer{}, nil)
	var pe *safe.PanicError
	if !errors.As(err, &pe) || pe.Value != "metrics lookup exploded" {
		t.Fatalf("err = %v, want the lookup's *safe.PanicError", err)
	}
}
