package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/config"
	"github.com/civitai/civitai/apps/beacon-go/internal/server"
)

// trackerWriter's wiring: a sent row reaches the tracker at /track/<table>, is counted under its
// result and timed in the send histogram, and the queue-depth gauge is registered on the registry.
func TestTrackerWriterWiresTheMetrics(t *testing.T) {
	paths := make(chan string, 1)
	tracker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer tracker.Close()
	reg := prometheus.NewRegistry()
	metrics := server.NewMetrics(reg)
	w := trackerWriter(&config.Config{TrackerURL: tracker.URL, TrackerWorkers: 2, TrackerQueue: 4}, metrics, reg)
	if !w.Enqueue(beacon.Write{Table: beacon.TableViews, Body: []byte("{}")}) {
		t.Fatal("row refused")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := w.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if p := <-paths; p != "/track/views" {
		t.Fatalf("POST %s, want /track/views", p)
	}
	if n := testutil.ToFloat64(metrics.TrackerWrites.WithLabelValues(beacon.TableViews, "ok")); n != 1 {
		t.Fatalf("ok writes %v, want 1", n)
	}
	const want = `
# HELP beacon_go_tracker_queue_depth Rows waiting in the tracker queue (serve mode only); a full queue drops the row (beacon_go_tracker_writes_total{result="dropped"}).
# TYPE beacon_go_tracker_queue_depth gauge
beacon_go_tracker_queue_depth 0
`
	if err := testutil.GatherAndCompare(reg, strings.NewReader(want), "beacon_go_tracker_queue_depth"); err != nil {
		t.Fatal(err)
	}
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var sent uint64
	for _, mf := range mfs {
		if mf.GetName() != "beacon_go_tracker_send_seconds" {
			continue
		}
		for _, m := range mf.GetMetric() {
			if m.GetLabel()[0].GetValue() == beacon.TableViews {
				sent = m.GetHistogram().GetSampleCount()
			}
		}
	}
	if sent != 1 {
		t.Fatalf("send-duration samples for views %d, want 1", sent)
	}
}
