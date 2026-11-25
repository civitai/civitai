package shared

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// THE SEAM: the Reader over two real session managers built by NewReader, the constructor main
// calls (Accept, SubscribeMeta, the service token and its re-mint), against a fake adapter that routes as the real one does: a subscription naming a
// level in its meta, by the service token only, is that level stream; the per-viewer URN under a
// viewer's exchanged token is that viewer's stream. A level subscription that arrives without its
// meta, or a per-viewer one under the service token, is refused, so a manager wired wrong is red here
// while each component's own tests stay green.

type seamStream struct {
	events chan registry.Event
	once   sync.Once
	done   chan struct{}
}

func (s *seamStream) Next() (registry.Event, error) {
	select {
	case ev := <-s.events:
		return ev, nil
	case <-s.done:
		return registry.Event{}, &registry.Error{Code: registry.Unavailable}
	}
}

func (s *seamStream) Close() error { s.once.Do(func() { close(s.done) }); return nil }

type seamAdapter struct {
	mu sync.Mutex
	// levelsOff: content levels are off for the app (bits end levels_off, none serves).
	levelsOff bool
	refused   int
	// The service token: minted is its generation (svc-token-<n>), revoked the ones the registry
	// refuses, invalidated how often the consumer asked for a new one.
	minted, invalidated int
	revoked             map[string]bool
	// subs counts the level subscriptions per schema.
	subs map[string]int
}

func (a *seamAdapter) serviceToken(context.Context) (string, time.Time, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return fmt.Sprintf("svc-token-%d", a.minted), time.Now().Add(time.Hour), nil
}

func (a *seamAdapter) remint() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.minted++
	a.invalidated++
}

func (a *seamAdapter) levelSubs(sch string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.subs[sch]
}

func (a *seamAdapter) Subscribe(ctx context.Context, schema, token string) (session.Stream, error) {
	return a.SubscribeMeta(ctx, schema, token, nil)
}

func (a *seamAdapter) SubscribeMeta(_ context.Context, sch, token string, meta json.RawMessage) (session.Stream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := &seamStream{events: make(chan registry.Event, 16), done: make(chan struct{})}
	cur := func(inner string) string {
		return "b1.0a1b2c3d4e5f60718293a4b5." + inner + ".0123456789abcdef0123456789abcdef"
	}
	service := strings.HasPrefix(token, "svc-token-")
	if service && meta != nil {
		if a.subs == nil {
			a.subs = map[string]int{}
		}
		a.subs[sch]++
	}
	switch {
	case service && a.revoked[token]:
		return nil, &registry.Error{Code: registry.InvalidToken}
	case service && meta != nil && sch != schema:
		// A collection that does not resolve (level-feed.ts advance): ended before any Live.
		st.events <- registry.Event{Type: registry.End, Meta: json.RawMessage(`{"reason":"not_resolved"}`)}
	case sch == schema && service && meta != nil:
		var m struct {
			Level any `json:"level"`
		}
		_ = json.Unmarshal(meta, &m)
		switch lv := m.Level.(type) {
		case string: // none
			if !a.levelsOff {
				st.events <- registry.Event{Type: registry.End, Meta: json.RawMessage(`{"reason":"levels_on"}`)}
				return st, nil
			}
			st.events <- registry.Event{Type: registry.Upsert, Entity: doc("k-every", 51, "EVERY")}
		case float64:
			if a.levelsOff {
				st.events <- registry.Event{Type: registry.End, Meta: json.RawMessage(`{"reason":"levels_off"}`)}
				return st, nil
			}
			switch lv {
			case 1:
				st.events <- registry.Event{Type: registry.Upsert, Entity: doc("k-pg", 52, "PG")}
			case 4:
				st.events <- registry.Event{Type: registry.Upsert, Entity: doc("k-r", 53, "R")}
			}
		}
		st.events <- registry.Event{Type: registry.Live, Cursor: cur("l1"), Meta: json.RawMessage(`{"head":{"seq":60},"block":"apb_bench"}`)}
	case sch == vschema && strings.HasPrefix(token, "x.") && meta == nil:
		st.events <- registry.Event{Type: registry.Upsert, Entity: doc("k-own", 54, "OWN")}
		st.events <- registry.Event{Type: registry.Live, Cursor: cur("v1"), Meta: json.RawMessage(`{"head":{"seq":61},"mask":5}`)}
	default:
		a.refused++
		return nil, &registry.Error{Code: registry.InvalidToken}
	}
	return st, nil
}

func seamManagers(t *testing.T, a *seamAdapter) *Reader {
	t.Helper()
	bounds := Bounds{MaxStreams: 10, MaxRecords: 100, MaxBytes: 1 << 20}
	r, levels, viewers := NewReader(Build{
		Sub: a, Budget: session.NewBudget(20, 64<<20), Level: bounds, Viewer: bounds,
		ServiceToken: a.serviceToken, ServiceRefused: a.remint,
		ViewerExchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
		LevelMaxAge: time.Hour, IdleTTL: time.Hour, MaxAge: time.Hour, Cooldown: time.Millisecond,
		NotPrivateCooldown: time.Second, ExpiryMargin: time.Second, OverlayTTL: 90 * time.Second,
		ReopenEvery: time.Minute, MaxStreamsPerToken: 4, MaxOverlays: 10, MaxOverlayBytes: 1 << 20, ProbesPerApp: 2,
	})
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	return r
}

func TestTheReaderOverRealManagersReadsTheAdaptersFeeds(t *testing.T) {
	a := &seamAdapter{}
	r := seamManagers(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b, err := r.Read(ctx, Viewer{Token: hubTok}, "bench-app", "records", 1, 0)
	if err != nil || shown(b) != "k-own=OWN*,k-pg=PG,k-r=R" {
		t.Fatalf("signed in: %s %v", shown(b), err)
	}
	b, err = r.Read(ctx, Viewer{Anonymous: &Anonymous{Mask: 1, AppBlockID: "apb_bench"}}, "bench-app", "records", 1, 0)
	if err != nil || shown(b) != "k-pg=PG" {
		t.Fatalf("signed out: %s %v", shown(b), err)
	}
	// Content levels turn off: the bit streams' end switches the read to `none` (a fresh Reader, so
	// the switch is learned from the end the real manager reports).
	a.mu.Lock()
	a.levelsOff = true
	a.mu.Unlock()
	r = seamManagers(t, a)
	b, err = r.Read(ctx, Viewer{Anonymous: &Anonymous{Mask: 1, AppBlockID: "apb_bench"}}, "bench-app", "records", 1, 0)
	if err != nil || shown(b) != "k-every=EVERY" {
		t.Fatalf("levels off: %s %v", shown(b), err)
	}
	if a.refused != 0 {
		t.Fatalf("🔴 %d subscriptions were not routed (a level one without its meta, or a viewer one under the service token)", a.refused)
	}
	// And a viewer whose block-token one exchange is spent is that error, from the real manager.
	r.Viewers = &fakeViews{errs: map[string]error{blockTok + "#" + vschema: session.ErrBlockSpent}, calls: map[string]int{}}
	if _, err := r.Read(ctx, Viewer{Token: blockTok}, "bench-app", "records", 1, 0); !errors.Is(err, session.ErrBlockSpent) {
		t.Fatalf("spent: %v", err)
	}
}

// 🔴 THE SERVICE TOKEN, through the real managers: the registry refusing the level streams' token is
// ErrServiceToken (never the viewer's ErrInvalidToken), the token is re-minted, and once the key's
// cooldown passed the next read opens its stream with the new token.
func TestARefusedServiceTokenIsReMintedAndNeverTheViewers(t *testing.T) {
	a := &seamAdapter{revoked: map[string]bool{"svc-token-0": true}}
	r := seamManagers(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := r.Read(ctx, Viewer{Token: hubTok}, "bench-app", "records", 1, 0)
	if !errors.Is(err, ErrServiceToken) || errors.Is(err, session.ErrInvalidToken) {
		t.Fatalf("a refused service token: %v, want ErrServiceToken", err)
	}
	a.mu.Lock()
	invalidated := a.invalidated
	a.mu.Unlock()
	if invalidated < 1 {
		t.Fatal("🔴 the refused service token was not invalidated")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		b, err := r.Read(ctx, Viewer{Token: hubTok}, "bench-app", "records", 1, 0)
		if err == nil {
			if shown(b) != "k-own=OWN*,k-pg=PG,k-r=R" {
				t.Fatalf("after the re-mint: %s", shown(b))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never served after the re-mint: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 🔴 SIGNED-OUT, through the real managers: a made-up collection opens ONE level stream (the probe),
// which the adapter ends not_resolved, never one per bit of the mask; a real one is then read in
// full.
func TestASignedOutReadOfAnUnknownCollectionOpensOneStream(t *testing.T) {
	a := &seamAdapter{}
	r := seamManagers(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	anon := Viewer{Anonymous: &Anonymous{Mask: 1 | 4 | 16, AppBlockID: "apb_bench"}}
	made := "urn:schema:apps.civitai.com:bench-app/made-up@v1"
	_, err := r.Read(ctx, anon, "bench-app", "made-up", 1, 0)
	var ended *session.EndedError
	if !errors.As(err, &ended) || ended.Reason != "not_resolved" {
		t.Fatalf("a made-up collection: %v, want not_resolved", err)
	}
	if n := a.levelSubs(made); n != 1 {
		t.Fatalf("🔴 a made-up collection opened %d level streams, want the one probe", n)
	}
	b, err := r.Read(ctx, anon, "bench-app", "records", 1, 0)
	if err != nil || shown(b) != "k-pg=PG,k-r=R" {
		t.Fatalf("a real collection: %s %v", shown(b), err)
	}
	if !r.Known(schema) || r.Known(made) {
		t.Fatalf("known: records %v, made-up %v", r.Known(schema), r.Known(made))
	}
}
