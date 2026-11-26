package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
	"github.com/civitai/civitai/apps/app-data-go/internal/token"
)

// THE SERVICE TOKEN through the handler: the real shared reader and its two real managers (built by
// shared.NewReader, as main builds them), the level streams' token from a real token.Source against
// a fake hub token endpoint. Only the API this test calls existed before the separate service client,
// so it compiles on the commit before it: there a hub refusal answered `503 failed`, then
// `503 cooling_down`, and a reader with no service token panicked on the first read.

// adapterStub serves the per-viewer stream (mask PG|R) to any exchanged viewer token, and a live,
// empty level stream to anything else; it counts the subscriptions it was asked for.
type adapterStub struct {
	mu     sync.Mutex
	levels int
	views  int
}

type stubStream struct {
	ev   chan registry.Event
	done chan struct{}
	once sync.Once
}

func (s *stubStream) Next() (registry.Event, error) {
	select {
	case e := <-s.ev:
		return e, nil
	case <-s.done:
		return registry.Event{}, io.EOF
	}
}

func (s *stubStream) Close() error { s.once.Do(func() { close(s.done) }); return nil }

func (a *adapterStub) Subscribe(ctx context.Context, schema, tok string) (session.Stream, error) {
	return a.SubscribeMeta(ctx, schema, tok, nil)
}

func (a *adapterStub) SubscribeMeta(_ context.Context, _, _ string, meta json.RawMessage) (session.Stream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := &stubStream{ev: make(chan registry.Event, 4), done: make(chan struct{})}
	if meta != nil {
		a.levels++
		st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.l1.x", Meta: json.RawMessage(`{"head":{"seq":1},"currentMajor":1}`)}
		return st, nil
	}
	a.views++
	st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.v1.x", Meta: json.RawMessage(`{"head":{"seq":1},"mask":5}`)}
	return st, nil
}

func (a *adapterStub) counts() (levels, views int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.levels, a.views
}

// realSharedStack is newSharedStack with the real shared reader; serviceToken nil is no service
// client.
func realSharedStack(t *testing.T, a *adapterStub, serviceToken func(context.Context) (string, time.Time, error), serviceRefused func()) *stack {
	t.Helper()
	s, _ := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-e"] = true
	bounds := shared.Bounds{MaxStreams: 10, MaxRecords: 100, MaxBytes: 1 << 20}
	reader, levels, viewers := shared.NewReader(shared.Build{
		Sub: a, Budget: session.NewBudget(20, 64<<20), Level: bounds, Viewer: bounds,
		ServiceToken: serviceToken, ServiceRefused: serviceRefused,
		ViewerExchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x.AppDataRead." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
		// A cooldown far longer than the test: the second read meets the first one's cooldown.
		LevelMaxAge: time.Hour, IdleTTL: time.Hour, MaxAge: time.Hour, Cooldown: time.Hour,
		NotPrivateCooldown: time.Hour, ExpiryMargin: time.Second, OverlayTTL: 90 * time.Second,
		ReopenEvery: time.Minute, MaxStreamsPerToken: 4, MaxOverlays: 10, MaxOverlayBytes: 1 << 20, ProbesPerApp: 2,
	})
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	s.srv.Shared = reader
	s.h = s.srv.Handler()
	return s
}

// tokenEndpoint is a fake hub token endpoint answering every call status with body.
func tokenEndpoint(t *testing.T, status int, body string) (*httptest.Server, *int) {
	t.Helper()
	var mu sync.Mutex
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

// 🔴 A hub that refuses to mint the service token (the answer it gave a relay client asking for one,
// `unauthorized_client`) answers every shared read `503 service_token_refused`, the first and the
// ones its cooldown answers alike: never `failed` or `cooling_down`, which a network blip also
// answers. A hub that cannot be reached answers `service_token_unavailable`.
func TestAHubRefusalOfTheServiceTokenIsItsOwnReason(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		closed bool
		want   string
	}{
		{"refused", http.StatusBadRequest, `{"error":"unauthorized_client","error_description":"grant_type is invalid"}`, false, "service_token_refused"},
		{"bad secret", http.StatusUnauthorized, `{"error":"invalid_client"}`, false, "service_token_refused"},
		{"hub failing", http.StatusBadGateway, `{"error":"server_error"}`, false, "service_token_unavailable"},
		{"hub rate-limiting", http.StatusTooManyRequests, `{"error":"slow_down"}`, false, "service_token_unavailable"},
		{"hub unreachable", http.StatusOK, `{}`, true, "service_token_unavailable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hub, _ := tokenEndpoint(t, c.status, c.body)
			if c.closed {
				hub.Close()
			}
			svc := token.New(token.Config{URL: hub.URL, ClientID: "svc-client", ClientSecret: "svc-secret", Scope: "AppsRead"}, nil)
			a := &adapterStub{}
			s := realSharedStack(t, a, svc.TokenExpiring, svc.Invalidate)
			for i, what := range []string{"first read", "read in the cooldown"} {
				g := s.shared(t, notesPath, "civitai_shared-e")
				if g.status != http.StatusServiceUnavailable || g.err.Error != c.want || g.err.Code != c.want || g.header.Get("Retry-After") != "1" {
					t.Fatalf("%s (%d): %d %v %s; want 503 %s", what, i, g.status, g.header, g.body, c.want)
				}
			}
			if levels, _ := a.counts(); levels != 0 {
				t.Fatalf("%d level streams subscribed without a service token", levels)
			}
			if s.store.calls.Load() != 0 {
				t.Fatalf("🔴 REST was read %d times", s.store.calls.Load())
			}
		})
	}
}

// 🔴 With no service client the shared path refuses every read `503 service_client_unconfigured`,
// before it opens any stream: never a level stream under another client's token. No Retry-After:
// waiting does not configure a client.
func TestNoServiceClientRefusesSharedReadsExplicitly(t *testing.T) {
	a := &adapterStub{}
	s := realSharedStack(t, a, nil, nil)
	for range 2 {
		g := s.shared(t, notesPath, "civitai_shared-e")
		if g.status != http.StatusServiceUnavailable || g.err.Error != "service_client_unconfigured" || g.err.Code != "service_client_unconfigured" ||
			len(g.header.Values("Retry-After")) != 0 {
			t.Fatalf("no service client: %d %v %s; want 503 service_client_unconfigured", g.status, g.header, g.body)
		}
	}
	if levels, views := a.counts(); levels != 0 || views != 0 {
		t.Fatalf("no service client opened %d level and %d per-viewer streams; want none", levels, views)
	}
}

// The positive control for both: the same stack with a hub that mints the token serves the read from
// the level streams (so the refusals above are the token's, not the stack's).
func TestAMintedServiceTokenServesTheSharedRead(t *testing.T) {
	hub, calls := tokenEndpoint(t, http.StatusOK, `{"access_token":"svc-jwt","token_type":"Bearer","expires_in":900}`)
	svc := token.New(token.Config{URL: hub.URL, ClientID: "svc-client", ClientSecret: "svc-secret", Scope: "AppsRead"}, nil)
	a := &adapterStub{}
	s := realSharedStack(t, a, svc.TokenExpiring, svc.Invalidate)
	g := s.shared(t, notesPath, "civitai_shared-e")
	if g.status != http.StatusOK {
		t.Fatalf("minted: %d %s; want 200", g.status, g.body)
	}
	if levels, views := a.counts(); levels == 0 || views != 1 || *calls != 1 {
		t.Fatalf("minted: %d level streams, %d per-viewer, %d token calls", levels, views, *calls)
	}
}
