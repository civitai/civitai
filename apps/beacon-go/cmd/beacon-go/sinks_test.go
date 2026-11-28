package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/config"
	"github.com/civitai/civitai/apps/beacon-go/internal/server"
	"github.com/civitai/civitai/apps/beacon-go/internal/tracker"
)

// insertWriter's wiring: an insert reaches ClickHouse as the impressions INSERT with basic auth and
// is counted under table `impressions`.
func TestInsertWriterWiresTheMetrics(t *testing.T) {
	type got struct{ query, user string }
	seen := make(chan got, 1)
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, _, _ := r.BasicAuth()
		seen <- got{r.URL.Query().Get("query"), u}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()
	metrics := server.NewMetrics(prometheus.NewRegistry())
	w := insertWriter(&config.Config{ClickHouseHost: ch.URL, ClickHouseUsername: "u", ClickHousePassword: "p", ClickHouseWorkers: 1, ClickHouseQueue: 2}, metrics)
	if !w.Enqueue(beacon.Write{Table: beacon.TableImpressions, Body: []byte(`{"userId":0}`), Sink: beacon.SinkClickHouse}) {
		t.Fatal("insert refused")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := w.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if g := <-seen; g.query != "INSERT INTO impressions FORMAT JSONEachRow" || g.user != "u" {
		t.Fatalf("insert %+v", g)
	}
	if n := testutil.ToFloat64(metrics.TrackerWrites.WithLabelValues(beacon.TableImpressions, "ok")); n != 1 {
		t.Fatalf("ok inserts %v", n)
	}
}

// No FLIPT_URL: no rate source (every feed batch falls back). A bad one is a start-up error. A good
// one reads the `feed-events-sample-rate` variant in the background.
func TestFeedSampleRate(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if f, err := feedSampleRate(context.Background(), &config.Config{}, log); f != nil || err != nil {
		t.Fatalf("unset: %v %v", f != nil, err)
	}
	if _, err := feedSampleRate(context.Background(), &config.Config{FliptURL: "flipt"}, log); err == nil {
		t.Fatal("a bad FLIPT_URL accepted")
	}
	flags := make(chan string, 4)
	flipt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		flags <- string(b)
		_, _ = io.WriteString(w, `{"match":true,"variantKey":"0.2"}`)
	}))
	defer flipt.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f, err := feedSampleRate(ctx, &config.Config{FliptURL: flipt.URL}, log)
	if err != nil || f == nil {
		t.Fatalf("configured: %v", err)
	}
	select {
	case b := <-flags:
		if b != `{"namespaceKey":"default","flagKey":"feed-events-sample-rate","entityId":"global","context":{}}` {
			t.Fatalf("evaluated %s", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no read")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if v, ok := f(); ok {
			if v != 0.2 {
				t.Fatalf("rate %v", v)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no reading")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// writers drains each writer in turn and merges what they gave up on; the first error is returned.
func TestWritersCloseMerges(t *testing.T) {
	var order []string
	first := errors.New("first")
	ws := writers{
		fakeWriter{onClose: func() { order = append(order, "a") }, abandoned: tracker.Abandoned{Dropped: map[string]int{"search": 2}, InFlight: 1}, err: first},
		fakeWriter{onClose: func() { order = append(order, "b") }, abandoned: tracker.Abandoned{Dropped: map[string]int{"search": 1, "impressions": 3}}, err: errors.New("second")},
	}
	a, err := ws.Close(context.Background())
	if !errors.Is(err, first) || len(order) != 2 || order[0] != "a" || order[1] != "b" {
		t.Fatalf("err %v order %v", err, order)
	}
	if a.Dropped["search"] != 3 || a.Dropped["impressions"] != 3 || a.InFlight != 1 || a.Total() != 6 {
		t.Fatalf("merged %+v", a)
	}
	if a, err := (writers{}).Close(context.Background()); err != nil || a.Total() != 0 {
		t.Fatalf("empty: %+v %v", a, err)
	}
}
