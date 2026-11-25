package shared

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/token"
)

// THE SERVICE TOKEN's failures, named: a hub refusal is ErrServiceTokenRefused, any other failure to
// mint it ErrServiceTokenUnavailable; a cancelled stream is left to the manager.
func TestClassifyServiceToken(t *testing.T) {
	cases := []struct {
		err    error
		reason string
		want   error
	}{
		{&token.EndpointError{Status: 400, Code: "unauthorized_client"}, CloseServiceTokenRefused, ErrServiceTokenRefused},
		{fmt.Errorf("wrapped: %w", &token.EndpointError{Status: 401, Code: "invalid_client"}), CloseServiceTokenRefused, ErrServiceTokenRefused},
		{&token.EndpointError{Status: 429, Code: "none"}, CloseServiceTokenUnavailable, ErrServiceTokenUnavailable},
		{&token.EndpointError{Status: 502, Code: "none"}, CloseServiceTokenUnavailable, ErrServiceTokenUnavailable},
		{errors.New("token endpoint unreachable"), CloseServiceTokenUnavailable, ErrServiceTokenUnavailable},
		{context.DeadlineExceeded, CloseServiceTokenUnavailable, ErrServiceTokenUnavailable},
	}
	for _, c := range cases {
		f := ClassifyServiceToken(c.err)
		if f == nil || f.Reason != c.reason || !errors.Is(f, c.want) {
			t.Errorf("%v: %+v; want %s %v", c.err, f, c.reason, c.want)
		}
	}
	if f := ClassifyServiceToken(context.Canceled); f != nil {
		t.Errorf("cancelled: %+v; want nil", f)
	}
}

// With no service client every read is refused before any stream opens: Reader.Read is the only path
// to the level manager, so no level stream is ever minted another way.
func TestNoServiceClientOpensNothing(t *testing.T) {
	a := &seamAdapter{}
	bounds := Bounds{MaxStreams: 10, MaxRecords: 100, MaxBytes: 1 << 20}
	var closed []string
	r, levels, viewers := NewReader(Build{
		Sub: a, Budget: session.NewBudget(20, 64<<20), Level: bounds, Viewer: bounds,
		ViewerExchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
		LevelMaxAge: time.Hour, IdleTTL: time.Hour, MaxAge: time.Hour, Cooldown: time.Hour,
		NotPrivateCooldown: time.Second, ExpiryMargin: time.Second, OverlayTTL: 90 * time.Second,
		ReopenEvery: time.Minute, MaxStreamsPerToken: 4, MaxOverlays: 10, MaxOverlayBytes: 1 << 20, ProbesPerApp: 2,
		Closed: func(reason string) { closed = append(closed, reason) },
	})
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, v := range []Viewer{{Token: hubTok}, {Anonymous: &Anonymous{Mask: 1, AppBlockID: "apb_bench"}}} {
		if _, err := r.Read(ctx, v, "bench-app", "records", 1, 0); !errors.Is(err, ErrNoServiceClient) {
			t.Fatalf("%+v: %v; want ErrNoServiceClient", v, err)
		}
	}
	if st := viewers.Stats(); st.Streams != 0 || len(closed) != 0 {
		t.Fatalf("a refused read opened streams: %+v, closed %v", st, closed)
	}
	if st := levels.Stats(); st.Streams != 0 || a.levelSubs(schema) != 0 {
		t.Fatal("🔴 a level stream subscribed with no service client")
	}
}
