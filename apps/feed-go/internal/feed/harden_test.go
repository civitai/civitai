package feed

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
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
	m[1] = 1 //nolint:govet,staticcheck // nilness, SA5000: the nil-map write is deliberate, the test needs a runtime panic
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

// panickingReplica panics on every query.
type panickingReplica struct{}

func (panickingReplica) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("replica exploded")
}

// A panic inside a hydration worker (hydrate.Sources.Page runs each lookup's finish on its own
// goroutine) must come back from Hydrate as an error rather than kill the process. Every lookup but
// basic users answers from the cache (notFound markers, a notFound metric hash), so the one replica
// read, the basic-users miss, is the worker that panics.
func TestHydrateWorkerPanicIsAnError(t *testing.T) {
	r := testkit.NewRedis()
	notFound, err := msgpack.Marshal(map[string]any{"notFound": true})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{hydrate.KeyUserCosmetics + ":2", hydrate.KeyProfilePictures + ":2", hydrate.KeyImageFrames + ":1", hydrate.KeyTagIDs + ":1"} {
		r.SetString(k, notFound)
	}
	r.SetHash("metrics:Image:1", map[string]string{"notFound": "1"})
	src := &hydrate.Sources{Packed: &hydrate.PackedReader{Redis: r}, Cache: r, Replica: panickingReplica{}}
	_, err = Hydrate(context.Background(), src, []RawImage{{ID: 1, UserID: 2}}, Viewer{}, nil)
	var pe *safe.PanicError
	if !errors.As(err, &pe) || pe.Value != "replica exploded" {
		t.Fatalf("err = %v, want the lookup's *safe.PanicError", err)
	}
}
