package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/tracker"
)

// listen serves h on a fresh loopback port and returns the server and its base URL.
func listen(t *testing.T, h http.Handler) (*http.Server, string) {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &http.Server{Handler: h, ReadHeaderTimeout: time.Second}
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	return s, "http://" + ln.Addr().String()
}

// answers is whether a GET to url gets a 200.
func answers(url string) bool {
	c := &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	res, err := c.Get(url) //nolint:noctx // a loopback probe in a test
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	return res.StatusCode == http.StatusOK
}

type fakeSamples struct{ onClose func() }

func (f fakeSamples) Close(context.Context) error {
	f.onClose()
	return nil
}

type fakeWriter struct {
	onClose   func()
	abandoned tracker.Abandoned
	err       error
}

func (f fakeWriter) Close(context.Context) (tracker.Abandoned, error) {
	f.onClose()
	return f.abandoned, f.err
}

func ok() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
}

// The seam between the drain and the scrape: while the tracker rows drain (and Close counts the ones
// it gives up on), the public listener is already closed and the internal one (/metrics) still
// answers; it closes only after the drain. Shutting the internal listener first would leave every
// count the drain makes unscrapeable.
func TestShutdownClosesTheInternalListenerAfterTheDrain(t *testing.T) {
	public, publicURL := listen(t, ok())
	internal, internalURL := listen(t, ok())
	var order []string
	var publicAtDrain, internalAtSamples, internalAtDrain bool
	samples := fakeSamples{onClose: func() {
		order = append(order, "samples")
		internalAtSamples = answers(internalURL + "/metrics")
	}}
	writer := fakeWriter{onClose: func() {
		order = append(order, "writer")
		publicAtDrain = answers(publicURL + "/")
		internalAtDrain = answers(internalURL + "/metrics")
	}}
	shutdown(slog.New(slog.DiscardHandler), 5*time.Second, []*http.Server{public}, internal, samples, writer)
	if len(order) != 2 || order[0] != "samples" || order[1] != "writer" {
		t.Fatalf("drain order %v, want samples then writer", order)
	}
	if publicAtDrain {
		t.Fatal("the public listener still answered while the tracker rows drained")
	}
	if !internalAtSamples || !internalAtDrain {
		t.Fatalf("/metrics answered during the samples drain %v, during the tracker drain %v; want both", internalAtSamples, internalAtDrain)
	}
	if answers(internalURL + "/metrics") {
		t.Fatal("the internal listener still answers after shutdown returned")
	}
}

// Shadow mode has no writer (a nil interface): the samples drain and the internal listener closes.
func TestShutdownWithoutAWriter(t *testing.T) {
	internal, internalURL := listen(t, ok())
	closed := false
	shutdown(slog.New(slog.DiscardHandler), 5*time.Second, nil, internal, fakeSamples{onClose: func() { closed = true }}, nil)
	if !closed || answers(internalURL+"/metrics") {
		t.Fatalf("samples closed %v, internal still answering %v", closed, answers(internalURL+"/metrics"))
	}
}

// When the drain gives up, the shutdown warning carries the per-table dropped rows and the in-flight
// count, so the loss is countable from the logs even when no scrape lands before the exit.
func TestShutdownLogsTheRowsTheDrainGaveUpOn(t *testing.T) {
	internal, _ := listen(t, ok())
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	writer := fakeWriter{
		onClose:   func() {},
		abandoned: tracker.Abandoned{Dropped: map[string]int{"views": 3, "pageViews": 7}, InFlight: 2},
		err:       context.DeadlineExceeded,
	}
	shutdown(log, 5*time.Second, nil, internal, fakeSamples{onClose: func() {}}, writer)
	var line struct {
		Level        string         `json:"level"`
		Msg          string         `json:"msg"`
		Dropped      map[string]int `json:"dropped"`
		DroppedTotal int            `json:"dropped_total"`
		InFlight     int            `json:"in_flight"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("one JSON log line expected, got %q: %v", buf.String(), err)
	}
	if line.Level != "WARN" || line.Dropped["views"] != 3 || line.Dropped["pageViews"] != 7 || len(line.Dropped) != 2 ||
		line.DroppedTotal != 10 || line.InFlight != 2 {
		t.Fatalf("log %q, want a WARN with views 3, pageViews 7, total 10, in_flight 2", buf.String())
	}
}

// A drain that finishes in time logs nothing.
func TestShutdownLogsNothingWhenTheDrainFinishes(t *testing.T) {
	internal, _ := listen(t, ok())
	var buf bytes.Buffer
	shutdown(slog.New(slog.NewJSONHandler(&buf, nil)), 5*time.Second, nil, internal, fakeSamples{onClose: func() {}},
		fakeWriter{onClose: func() {}})
	if buf.Len() != 0 {
		t.Fatalf("logged %q after a clean drain", buf.String())
	}
}
