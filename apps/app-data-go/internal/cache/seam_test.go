package cache

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// THE SEAM: the cache's implementations plugged into a real session manager, as main wires them,
// against a fake adapter that resumes as the private feed does. Each half is tested on its own
// elsewhere; this is the combined state.

const (
	seamSchema = "urn:schema:apps.civitai.com:todo-app/notes@v1"
	seamLive   = "b1.0a1b2c3d4e5f60718293a4b5.p1.00000000000000000000000000000000"
	seamURN    = "urn:apps.civitai.com:todo-app/notes/r1"
)

type seamStream struct {
	events chan registry.Event
	closed chan struct{}
	once   sync.Once
}

func (s *seamStream) Next() (registry.Event, error) {
	select {
	case ev := <-s.events:
		return ev, nil
	case <-s.closed:
		return registry.Event{}, io.ErrUnexpectedEOF
	}
}

func (s *seamStream) Close() error { s.once.Do(func() { close(s.closed) }); return nil }

// seamAdapter serves one record and Live; a resume of seamLive is answered Live (sync pending), then
// the sync.
type seamAdapter struct {
	mu      sync.Mutex
	fresh   int
	resumes int
}

func (a *seamAdapter) Subscribe(ctx context.Context, schema, token string) (session.Stream, error) {
	return a.SubscribeFrom(ctx, schema, token, nil, "")
}

func (a *seamAdapter) SubscribeFrom(_ context.Context, _, token string, meta json.RawMessage, cursor string) (session.Stream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := &seamStream{events: make(chan registry.Event, 8), closed: make(chan struct{})}
	if token != "x.civitai_seam" { //nolint:gosec // G101: a synthetic test fixture
		return nil, &registry.Error{Code: registry.InvalidToken}
	}
	if cursor == "" {
		a.fresh++
		s.events <- registry.Event{Type: registry.Upsert, Entity: registry.Entity{URN: seamURN, Key: "k1", Rev: "r", Body: json.RawMessage(`{"t":1}`)}}
		s.events <- registry.Event{Type: registry.Live, Cursor: seamLive}
		return s, nil
	}
	a.resumes++
	if cursor != seamLive || string(meta) != `{"sync":1}` {
		return nil, &registry.Error{Code: registry.CursorExpired}
	}
	s.events <- registry.Event{Type: registry.Live, Cursor: seamLive, Meta: json.RawMessage(`{"sync":"pending"}`)}
	s.events <- registry.Event{Type: registry.Progress, Cursor: seamLive, Meta: json.RawMessage(`{"sync":"done"}`)}
	return s, nil
}

func (a *seamAdapter) counts() (int, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.fresh, a.resumes
}

// manager is one process: the cache c in front of the hub and the adapter, as main wires it.
func seamManager(c *Cache, a *seamAdapter, hubCalls *int, mu *sync.Mutex) *session.Manager {
	hub := func(context.Context, string) (exchange.Token, error) {
		mu.Lock()
		defer mu.Unlock()
		*hubCalls++
		return exchange.Token{Access: "x.civitai_seam", Expires: time.Now().Add(15 * time.Minute)}, nil
	}
	tokens := &Tokens{C: c, Exchange: hub, Recheck: 2 * time.Minute, Margin: 30 * time.Second}
	return session.New(a, session.Options{
		MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Minute, MaxAge: 14 * time.Minute, MaxRecords: 100, MaxBytes: 1 << 20,
		Cooldown: 30 * time.Second, NotPrivateCooldown: time.Minute, ExpiryMargin: 30 * time.Second, Recheck: 2 * time.Minute,
		Exchange: tokens.Open, ExchangeFresh: tokens.Fresh, Forget: tokens.Forget, Snapshots: Snapshots{C: c},
	})
}

func seamRead(m *session.Manager) ([]registry.Entity, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return m.ReadAt(ctx, "civitai_seam", seamSchema, 0)
}

// 🔴 FAIL OPEN, end to end: valkey refusing every connection, or hung, the read is answered as it is
// without a cache, and a hung valkey adds at most a bounded delay.
func TestAReadWithValkeyDownIsAnsweredAsWithoutACache(t *testing.T) {
	for _, fault := range []string{"refused", "hung"} {
		t.Run(fault, func(t *testing.T) {
			st := newMemStore()
			st.fail, st.hang = fault == "refused", fault == "hung"
			c, _ := New(st, secretA, Options{Timeout: 50 * time.Millisecond})
			var hub int
			var mu sync.Mutex
			m := seamManager(c, &seamAdapter{}, &hub, &mu)
			defer m.Close()
			start := time.Now()
			got, err := seamRead(m)
			if err != nil || len(got) != 1 || got[0].URN != seamURN {
				t.Fatalf("🔴 %v %v", got, err)
			}
			// At most the token Get, the snapshot Load and the token Put: three timeouts.
			if d := time.Since(start); d > 500*time.Millisecond {
				t.Fatalf("the read took %s", d)
			}
		})
	}
}

// The warm restart, end to end through the real cache: the second process resumes the first one's
// stream (no fresh snapshot) and opens it without asking the hub (its check is seconds old).
func TestASecondProcessResumesTheFirstOnesStreamThroughTheCache(t *testing.T) {
	st := newMemStore()
	c, _ := New(st, secretA, Options{Timeout: time.Second})
	a := &seamAdapter{}
	var hub int
	var mu sync.Mutex
	first := seamManager(c, a, &hub, &mu)
	if _, err := seamRead(first); err != nil {
		t.Fatal(err)
	}
	first.Close() // the shutdown saves the snapshot
	second := seamManager(c, a, &hub, &mu)
	defer second.Close()
	got, err := seamRead(second)
	if err != nil || len(got) != 1 || got[0].URN != seamURN {
		t.Fatalf("%v %v", got, err)
	}
	if fresh, resumes := a.counts(); fresh != 1 || resumes != 1 {
		t.Fatalf("fresh %d, resumes %d", fresh, resumes)
	}
	mu.Lock()
	defer mu.Unlock()
	if hub != 1 {
		t.Fatalf("the hub was asked %d times", hub)
	}
	// Another key (wrong secret: a rotation) resumes nothing.
	other, _ := New(st, secretB, Options{Timeout: time.Second})
	third := seamManager(other, a, &hub, &mu)
	defer third.Close()
	mu.Unlock()
	_, err = seamRead(third)
	mu.Lock()
	if fresh, resumes := a.counts(); err != nil || fresh != 2 || resumes != 1 {
		t.Fatalf("after a rotation: %v fresh %d resumes %d", err, fresh, resumes)
	}
	if errors.Is(err, session.ErrRefused) {
		t.Fatal("refused")
	}
}
