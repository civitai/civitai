package v1models

import (
	"context"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// A public request (Serving) reads every origin cache entry within the TTL, as Node's handler does;
// only a shadow sample skips one younger than NodeBuiltWindow (the one Node built for the sample).
func TestServeDetailServingReadsEveryFreshEntry(t *testing.T) {
	key := KeyPublicModelResponse + ":v2:5001:31"
	for _, c := range []struct {
		age             time.Duration
		serving, cached bool
	}{
		{0, true, true},
		{time.Second, true, true},
		{NodeBuiltWindow - time.Millisecond, true, true},
		{time.Minute, true, true},
		// The control: the same young entries are built for a sample.
		{0, false, false},
		{time.Second, false, false},
		{time.Minute, false, true},
	} {
		w := newTestWorld()
		w.entries[key] = meta("data", meta("id", int64(5001), "name", "cached"), "cachedAt", float64(testNow.Add(-c.age).UnixMilli()))
		ans, err := ServeDetail(context.Background(), w.deps(t), DetailRequest{ID: "5001", Serving: c.serving})
		if err != nil || ans.Cached != c.cached {
			t.Errorf("entry %v old, serving %v: cached %v, want %v (%v)", c.age, c.serving, ans != nil && ans.Cached, c.cached, err)
		}
	}
	// Past the logical TTL an entry is built when serving too.
	w := newTestWorld()
	w.entries[key] = meta("data", meta("id", int64(5001)), "cachedAt", float64(testNow.Add(-4*time.Minute).UnixMilli()))
	if ans, err := ServeDetail(context.Background(), w.deps(t), DetailRequest{ID: "5001", Serving: true}); err != nil || ans.Cached {
		t.Errorf("expired entry, serving: %+v %v", ans, err)
	}
}

// The not-found answer is marked, so the public route can hand it to Node (a 404 there); a found
// model is not.
func TestServeDetailMarksNotFound(t *testing.T) {
	w := newTestWorld()
	ans, err := detailOf(t, w)
	if err != nil || ans.NotFound {
		t.Fatalf("found model: NotFound %v (%v)", ans != nil && ans.NotFound, err)
	}
	w = newTestWorld()
	w.modelRow = nil
	ans, err = detailOf(t, w)
	if err != nil || !ans.NotFound {
		t.Fatalf("missing model: NotFound %v (%v)", ans != nil && ans.NotFound, err)
	}
	if body, _ := superjson.Plain(ans.Body); string(body) != `{"error":"No model with id 5001"}` {
		t.Errorf("not-found body %s", body)
	}
}
