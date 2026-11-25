package shared

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// THE SEAM: the Reader over two real session managers built as main builds them (Accept,
// SubscribeMeta), against a fake adapter that routes as the real one does: a subscription naming a
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
}

const serviceToken = "svc-token"

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
	switch {
	case sch == schema && token == serviceToken && meta != nil:
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
	base := session.Options{MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Hour, MaxAge: time.Hour, MaxRecords: 100,
		MaxBytes: 1 << 20, Cooldown: time.Second, NotPrivateCooldown: time.Second, ExpiryMargin: time.Second,
		OverlayTTL: 90 * time.Second, ReopenEvery: time.Minute}
	lo := base
	lo.MaxPerToken = 1
	lo.Exchange = func(context.Context, string) (exchange.Token, error) {
		return exchange.Token{Access: serviceToken, Expires: time.Now().Add(time.Hour)}, nil
	}
	lo.Accept, lo.SubscribeMeta = AcceptLevel, LevelMeta
	vo := base
	vo.Exchange = func(_ context.Context, subject string) (exchange.Token, error) {
		return exchange.Token{Access: "x." + subject, Expires: time.Now().Add(time.Hour)}, nil
	}
	vo.Accept = AcceptViewer
	levels, viewers := session.New(a, lo), session.New(a, vo)
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	return &Reader{Levels: levels, Viewers: viewers, Overlays: &Overlays{TTL: time.Minute, Max: 10}}
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
