package session

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// REGION and EXCHANGE FAILURES, over the real ClientSubscriber and registry client: the adapter here
// is an HTTP server that records each subscription's region headers and answers an empty private
// stream naming head 1.

type regionAdapter struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []string // "cf-ipcountry,cf-region-code,x-isuk" per subscription
}

func newRegionAdapter(t *testing.T) *regionAdapter {
	t.Helper()
	a := &regionAdapter{}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		a.seen = append(a.seen, r.Header.Get("cf-ipcountry")+","+r.Header.Get("cf-region-code")+","+r.Header.Get("x-isuk"))
		a.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"b1.0a1b2c3d4e5f60718293a4b5.p1.empty\",\"meta\":{\"head\":{\"seq\":1}}}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(a.srv.Close)
	return a
}

func (a *regionAdapter) regions() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return strings.Join(a.seen, " | ")
}

func regionManager(t *testing.T, a *regionAdapter, region bool) *Manager {
	t.Helper()
	m := New(ClientSubscriber{Client: &registry.Client{BaseURL: a.srv.URL}}, Options{
		MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Hour, MaxAge: time.Hour, MaxRecords: 100, MaxBytes: 1 << 20,
		Cooldown: time.Hour, NotPrivateCooldown: time.Hour, ExpiryMargin: time.Second,
		OverlayTTL: time.Minute, ReopenEvery: time.Minute, Region: region,
		Exchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
	})
	t.Cleanup(m.Close)
	return m
}

const regionSchema = "urn:schema:apps.civitai.com:todo-app/notes@v1"

func TestAStreamCarriesItsViewersRegion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	jp := Region{"JP", "", ""}
	caon := Region{"CA", "ON", ""}

	a := newRegionAdapter(t)
	m := regionManager(t, a, true)
	for _, r := range []Region{jp, jp, caon, {}} {
		if _, err := m.View(WithRegion(ctx, r), "civitai_ines", regionSchema, 0); err != nil {
			t.Fatal(err)
		}
	}
	// One stream per region: the second JP read is the first's stream; no region is a stream too.
	if got, want := a.regions(), "JP,, | CA,ON, | ,,"; got != want {
		t.Fatalf("regions sent: %q; want %q", got, want)
	}
	// An acknowledged write is shown over every region's stream of the token.
	m.Ack("civitai_ines", regionSchema, Ack{Key: "k-ack", Seq: 7, URN: "urn:apps.civitai.com:todo-app/notes/k-ack", Body: []byte(`{"t":"ACK-77"}`)})
	for _, r := range []Region{jp, caon, {}} {
		snap, err := m.View(WithRegion(ctx, r), "civitai_ines", regionSchema, 0)
		if err != nil || len(snap.Entities) != 1 || string(snap.Entities[0].Body) != `{"t":"ACK-77"}` {
			t.Fatalf("region %v after the ack: %+v %v", r, snap.Entities, err)
		}
	}

	off := newRegionAdapter(t)
	mo := regionManager(t, off, false)
	for _, r := range []Region{jp, caon} {
		if _, err := mo.View(WithRegion(ctx, r), "civitai_ines", regionSchema, 0); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := off.regions(), ",,"; got != want {
		t.Fatalf("Region off: regions sent %q; want one stream with none, %q", got, want)
	}
	if RegionOf(WithRegion(ctx, Region{})) != (Region{}) || RegionOf(ctx) != (Region{}) {
		t.Fatal("no region carried, yet one was read back")
	}
}

var errHubSaysNo = errors.New("the hub said no")

// An exchange error ClassifyExchange names closes the stream with its reason and answers its error,
// first read and cooldown alike; one it does not name stays ErrFailed.
func TestAClassifiedExchangeFailureIsItsOwnError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	a := newRegionAdapter(t)
	var mu sync.Mutex
	closed := map[string]int{}
	named := errors.New("named failure")
	m := New(ClientSubscriber{Client: &registry.Client{BaseURL: a.srv.URL}}, Options{
		MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Hour, MaxAge: time.Hour, MaxRecords: 100, MaxBytes: 1 << 20,
		Cooldown: time.Hour, NotPrivateCooldown: time.Hour, ExpiryMargin: time.Second,
		Exchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{}, errHubSaysNo
		},
		ClassifyExchange: func(err error) *ExchangeFailure {
			if errors.Is(err, errHubSaysNo) {
				return &ExchangeFailure{Reason: "named_reason", Err: named}
			}
			return nil
		},
		Closed: func(reason string) { mu.Lock(); closed[reason]++; mu.Unlock() },
	})
	t.Cleanup(m.Close)
	for i := range 2 {
		_, err := m.View(ctx, "civitai_jo", regionSchema, 0)
		var f *ExchangeFailure
		if !errors.Is(err, named) || !errors.As(err, &f) || f.Reason != "named_reason" || f.Error() != "named failure" {
			t.Fatalf("read %d: %v; want the named failure", i, err)
		}
		if i == 1 && !errors.Is(err, ErrCoolingDown) {
			t.Fatalf("read in the cooldown: %v; want ErrCoolingDown with its cause", err)
		}
	}
	mu.Lock()
	n := closed["named_reason"]
	mu.Unlock()
	if n != 1 {
		t.Fatalf("closed named_reason %d times; want 1", n)
	}

	unnamed := New(ClientSubscriber{Client: &registry.Client{BaseURL: a.srv.URL}}, Options{
		MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Hour, MaxAge: time.Hour, MaxRecords: 100, MaxBytes: 1 << 20,
		Cooldown: time.Hour, NotPrivateCooldown: time.Hour, ExpiryMargin: time.Second,
		Exchange: func(context.Context, string) (exchange.Token, error) {
			return exchange.Token{}, errors.New("something else")
		},
		ClassifyExchange: func(error) *ExchangeFailure { return nil },
	})
	t.Cleanup(unnamed.Close)
	if _, err := unnamed.View(ctx, "civitai_jo", regionSchema, 0); !errors.Is(err, ErrFailed) {
		t.Fatalf("an unnamed failure: %v; want ErrFailed", err)
	}
}
