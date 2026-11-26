package shared

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// regionTap is the seam adapter, recording the region each subscription's context carried (the one
// session.ClientSubscriber sends as the adapter's region headers), by kind: level or per-viewer.
type regionTap struct {
	*seamAdapter
	mu            sync.Mutex
	level, viewer []session.Region
}

func (r *regionTap) Subscribe(ctx context.Context, schema, token string) (session.Stream, error) {
	return r.SubscribeMeta(ctx, schema, token, nil)
}

func (r *regionTap) SubscribeMeta(ctx context.Context, sch, token string, meta json.RawMessage) (session.Stream, error) {
	r.mu.Lock()
	if meta != nil {
		r.level = append(r.level, session.RegionOf(ctx))
	} else {
		r.viewer = append(r.viewer, session.RegionOf(ctx))
	}
	r.mu.Unlock()
	return r.seamAdapter.SubscribeMeta(ctx, sch, token, meta)
}

// 🔴 REGION through the real managers NewReader builds: with ForwardRegion the viewer's region goes on
// their per-viewer stream, the one the adapter judges it on, and NEVER on a level stream, which every
// viewer shares and the adapter reads as a service, held by no region.
func TestTheRegionGoesOnThePerViewerStreamNeverALevelStream(t *testing.T) {
	tap := &regionTap{seamAdapter: &seamAdapter{}}
	bounds := Bounds{MaxStreams: 10, MaxRecords: 100, MaxBytes: 1 << 20}
	r, levels, viewers := NewReader(Build{
		Sub: tap, Budget: session.NewBudget(20, 64<<20), Level: bounds, Viewer: bounds,
		ServiceToken: tap.serviceToken, ServiceRefused: tap.remint,
		ViewerExchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
		LevelMaxAge: time.Hour, IdleTTL: time.Hour, MaxAge: time.Hour, Cooldown: time.Millisecond,
		NotPrivateCooldown: time.Second, ExpiryMargin: time.Second, OverlayTTL: 90 * time.Second,
		ReopenEvery: time.Minute, MaxStreamsPerToken: 4, MaxOverlays: 10, MaxOverlayBytes: 1 << 20, ProbesPerApp: 2,
		ForwardRegion: true,
	})
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	fr := session.Region{"FR", "", ""}
	b, err := r.Read(session.WithRegion(ctx, fr), Viewer{Token: hubTok}, "bench-app", "records", 1, 0)
	if err != nil || shown(b) != "k-own=OWN*,k-pg=PG,k-r=R" {
		t.Fatalf("signed in: %s %v", shown(b), err)
	}
	tap.mu.Lock()
	defer tap.mu.Unlock()
	if len(tap.viewer) != 1 || tap.viewer[0] != fr {
		t.Fatalf("per-viewer subscriptions carried %v; want one, with %v", tap.viewer, fr)
	}
	if len(tap.level) == 0 {
		t.Fatal("no level stream was subscribed: the guard below would hold vacuously")
	}
	for _, reg := range tap.level {
		if reg != (session.Region{}) {
			t.Fatalf("🔴 a level stream carried the viewer's region %v: %v", reg, tap.level)
		}
	}
}
