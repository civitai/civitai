package users

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// row is a pgx.Row that scans fixed values or returns an error.
type row struct {
	vals []any
	err  error
}

func (r row) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *bool:
			*p = r.vals[i].(bool)
		case *int32:
			*p = r.vals[i].(int32)
		}
	}
	return nil
}

type querier struct {
	r     row
	sql   string
	args  []any
	calls int
}

func (q *querier) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	q.calls++
	q.sql, q.args = sql, args
	return q.r
}

func TestPostgresFound(t *testing.T) {
	q := &querier{r: row{vals: []any{true, int32(28), true}}}
	u, found, err := Postgres{DB: q}.Lookup(context.Background(), 4711)
	if err != nil || !found || u != (policy.User{ShowNsfw: true, BrowsingLevel: 28, IsModerator: true}) {
		t.Fatalf("got %+v found=%v err=%v", u, found, err)
	}
	if q.sql != Query || len(q.args) != 1 || q.args[0] != int64(4711) {
		t.Fatalf("query %q args %v", q.sql, q.args)
	}
}

func TestPostgresNotFound(t *testing.T) {
	u, found, err := Postgres{DB: &querier{r: row{err: pgx.ErrNoRows}}}.Lookup(context.Background(), 1)
	if err != nil || found || u != (policy.User{}) {
		t.Fatalf("no row must be not found without an error, got %+v %v %v", u, found, err)
	}
}

func TestPostgresError(t *testing.T) {
	boom := errors.New("connection refused")
	_, found, err := Postgres{DB: &querier{r: row{err: boom}}}.Lookup(context.Background(), 1)
	if !errors.Is(err, boom) || found {
		t.Fatalf("got found=%v err=%v, want the error", found, err)
	}
}

// fakeSource counts lookups and answers from a map, or errs.
type fakeSource struct {
	mu    sync.Mutex
	users map[int64]policy.User
	err   error
	calls int
}

func (f *fakeSource) Lookup(_ context.Context, id int64) (policy.User, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return policy.User{}, false, f.err
	}
	u, ok := f.users[id]
	return u, ok, nil
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func TestCacheTTL(t *testing.T) {
	src := &fakeSource{users: map[int64]policy.User{7: {ShowNsfw: true, BrowsingLevel: 31}}}
	clk := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	c := &Cache{Source: src, TTL: 30 * time.Second, Now: clk.now}
	ctx := context.Background()

	u, found, hit, err := c.Lookup(ctx, 7)
	if err != nil || !found || hit || u.BrowsingLevel != 31 || src.calls != 1 {
		t.Fatalf("first lookup: %+v found=%v hit=%v err=%v calls=%d", u, found, hit, err, src.calls)
	}
	// The user changes their settings: the cache answers the old ones until the TTL ends.
	src.users[7] = policy.User{ShowNsfw: false, BrowsingLevel: 1}
	clk.t = clk.t.Add(29*time.Second + 999*time.Millisecond)
	u, _, hit, _ = c.Lookup(ctx, 7)
	if !hit || u.BrowsingLevel != 31 || src.calls != 1 {
		t.Fatalf("within the TTL: %+v hit=%v calls=%d, want the cached (stale) 31", u, hit, src.calls)
	}
	clk.t = clk.t.Add(time.Millisecond) // exactly TTL after the read: expired
	u, _, hit, _ = c.Lookup(ctx, 7)
	if hit || u.BrowsingLevel != 1 || src.calls != 2 {
		t.Fatalf("at the TTL: %+v hit=%v calls=%d, want a fresh read of 1", u, hit, src.calls)
	}
}

func TestCacheKeepsNotFound(t *testing.T) {
	src := &fakeSource{users: map[int64]policy.User{}}
	c := &Cache{Source: src, TTL: time.Minute}
	for range 3 {
		if _, found, _, err := c.Lookup(context.Background(), 9); found || err != nil {
			t.Fatalf("found=%v err=%v", found, err)
		}
	}
	if src.calls != 1 {
		t.Fatalf("a not-found answer must be kept too: %d reads", src.calls)
	}
}

func TestCacheNeverKeepsErrors(t *testing.T) {
	src := &fakeSource{err: errors.New("down")}
	c := &Cache{Source: src, TTL: time.Minute}
	for range 2 {
		if _, _, hit, err := c.Lookup(context.Background(), 1); err == nil || hit {
			t.Fatalf("err=%v hit=%v, want the error, uncached", err, hit)
		}
	}
	if src.calls != 2 || c.Len() != 0 {
		t.Fatalf("calls=%d len=%d: an error must reach the source every time and never be kept", src.calls, c.Len())
	}
}

func TestCacheDisabled(t *testing.T) {
	src := &fakeSource{users: map[int64]policy.User{1: {}}}
	c := &Cache{Source: src, TTL: 0}
	_, _, _, _ = c.Lookup(context.Background(), 1)
	_, _, _, _ = c.Lookup(context.Background(), 1)
	if src.calls != 2 || c.Len() != 0 {
		t.Fatalf("TTL 0 must keep nothing: calls=%d len=%d", src.calls, c.Len())
	}
}

func TestCacheBound(t *testing.T) {
	src := &fakeSource{users: map[int64]policy.User{}}
	clk := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	c := &Cache{Source: src, TTL: 10 * time.Second, MaxEntries: 2, Now: clk.now}
	ctx := context.Background()
	_, _, _, _ = c.Lookup(ctx, 1)
	_, _, _, _ = c.Lookup(ctx, 2)
	_, _, _, _ = c.Lookup(ctx, 3) // full, nothing expired: not kept
	if c.Len() != 2 {
		t.Fatalf("len %d, want 2 (the cap)", c.Len())
	}
	if _, _, hit, _ := c.Lookup(ctx, 3); hit {
		t.Fatal("an answer that did not fit must not be a hit")
	}
	if _, _, hit, _ := c.Lookup(ctx, 1); !hit {
		t.Fatal("an answer already held stays held")
	}
	clk.t = clk.t.Add(10 * time.Second) // 1 and 2 expire
	_, _, _, _ = c.Lookup(ctx, 4)
	if c.Len() != 1 {
		t.Fatalf("len %d, want 1: the expired entries are swept to make room", c.Len())
	}
	// Refreshing a key already held never counts against the cap.
	_, _, _, _ = c.Lookup(ctx, 4)
	if c.Len() != 1 {
		t.Fatalf("len %d after a refresh", c.Len())
	}
}

func TestCacheConcurrent(t *testing.T) {
	src := &fakeSource{users: map[int64]policy.User{1: {BrowsingLevel: 3}}}
	c := &Cache{Source: src, TTL: time.Minute, MaxEntries: 10}
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Go(func() {
			if u, _, _, err := c.Lookup(context.Background(), int64(i%5)); err != nil || (i%5 == 1 && u.BrowsingLevel != 3) {
				t.Errorf("lookup %d: %+v %v", i, u, err)
			}
		})
	}
	wg.Wait()
}
