package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// metricValue reads one series of a counter (its value) or histogram (its sample count) by name and
// exact label set; found is false when the series does not exist.
func metricValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) (v float64, found bool) {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != name {
			continue
		}
	series:
		for _, m := range mf.GetMetric() {
			if len(m.GetLabel()) != len(labels) {
				continue
			}
			for _, l := range m.GetLabel() {
				if labels[l.GetName()] != l.GetValue() {
					continue series
				}
			}
			if h := m.GetHistogram(); h != nil {
				return float64(h.GetSampleCount()), true
			}
			return m.GetCounter().GetValue(), true
		}
	}
	return 0, false
}

func phaseLabels(phase, outcome string) map[string]string {
	return map[string]string{"phase": phase, "outcome": outcome}
}

// nodeEnvelope is a minimal superjson page both sides answer, so the comparison is a match.
const nodeEnvelope = `{"json":{"items":[{"postId":7}],"nextCursor":null}}`

func shadowBody(t *testing.T, input string) io.Reader {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{Input: input, Headers: map[string]string{}, Node: json.RawMessage(nodeEnvelope)})
	if err != nil {
		t.Fatal(err)
	}
	return strings.NewReader(string(b))
}

func post(t *testing.T, s *Server, input string) {
	t.Helper()
	w := httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequest(http.MethodPost, "/internal/shadow/"+Procedure, shadowBody(t, input)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("post %q: code %d, want 202", input, w.Code)
	}
}

// waitFor polls cond (which reads only atomics: metrics and the queue length) until it holds.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func newPhaseServer(reg *prometheus.Registry, workers int, fn func(context.Context, *http.Request) (*computed, error)) *Server {
	return &Server{
		Metrics:     NewMetrics(reg),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ShadowQueue: make(chan struct{}, workers),
		computeFn:   fn,
	}
}

func TestShadowPhasesRecordedForServedSample(t *testing.T) {
	if _, ok := processCPU(); !ok {
		t.Skip("no process CPU clock on this platform")
	}
	const spin = 20 * time.Millisecond
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 4, func(context.Context, *http.Request) (*computed, error) {
		// Burn a known amount of process CPU inside compute, so its phase must carry at least that.
		start, _ := processCPU()
		for {
			if now, _ := processCPU(); now-start >= spin {
				break
			}
		}
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	post(t, s, "{}")
	waitFor(t, "the sample to finish", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"result": "match"})
		return v == 1 && len(s.ShadowQueue) == 0
	})

	for _, p := range [][2]string{{"decode", "ok"}, {"compute", "served"}, {"compare", "ok"}} {
		if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels(p[0], p[1])); n != 1 {
			t.Errorf("feed_go_shadow_phase_seconds{%s,%s} count = %v, want 1", p[0], p[1], n)
		}
		if n, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_total", phaseLabels(p[0], p[1])); n != 1 {
			t.Errorf("feed_go_shadow_phase_solo_total{%s,%s} = %v, want 1 (one sample, nothing overlapping)", p[0], p[1], n)
		}
		if _, found := metricValue(t, reg, "feed_go_shadow_phase_cpu_seconds_total", phaseLabels(p[0], p[1])); !found {
			t.Errorf("feed_go_shadow_phase_cpu_seconds_total{%s,%s} missing", p[0], p[1])
		}
		if _, found := metricValue(t, reg, "feed_go_shadow_phase_solo_wall_seconds_total", phaseLabels(p[0], p[1])); !found {
			t.Errorf("feed_go_shadow_phase_solo_wall_seconds_total{%s,%s} missing", p[0], p[1])
		}
	}
	if wall, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_wall_seconds_total", phaseLabels("compute", "served")); wall <= 0 {
		t.Errorf("compute solo wall = %vs, want > 0", wall)
	}
	if cpu, _ := metricValue(t, reg, "feed_go_shadow_phase_cpu_seconds_total", phaseLabels("compute", "served")); cpu < spin.Seconds() {
		t.Errorf("compute CPU = %vs, want >= %vs (the CPU burned inside compute)", cpu, spin.Seconds())
	}
	// No phase is recorded under an outcome it did not have.
	for _, p := range [][2]string{{"compute", "fallback"}, {"compute", "error"}, {"decode", "bad_request"}, {"compare", "bad_request"}} {
		if _, found := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels(p[0], p[1])); found {
			t.Errorf("unexpected series feed_go_shadow_phase_seconds{%s,%s}", p[0], p[1])
		}
	}
}

func TestShadowPhaseCPUOnlyForPhasesNoOtherSampleOverlapped(t *testing.T) {
	if _, ok := processCPU(); !ok {
		t.Skip("no process CPU clock on this platform")
	}
	reg := prometheus.NewRegistry()
	entered := map[string]chan struct{}{"A": make(chan struct{}), "B": make(chan struct{})}
	release := map[string]chan struct{}{"A": make(chan struct{}), "B": make(chan struct{})}
	s := newPhaseServer(reg, 2, func(_ context.Context, r *http.Request) (*computed, error) {
		id := r.URL.Query().Get("input")
		close(entered[id])
		<-release[id]
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	matches := func(n float64) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"result": "match"})
			return v == n
		}
	}

	post(t, s, "A") // A's decode: alone -> solo.
	<-entered["A"]  // A's compute started alone, but B is admitted before it ends -> not solo.
	post(t, s, "B") // B's decode: A in flight -> not solo.
	<-entered["B"]  // B's compute starts with A in flight -> not solo, though A is gone by its end.
	close(release["A"])
	waitFor(t, "A to finish", matches(1)) // A's compare: B in flight -> not solo.
	waitFor(t, "A's slot to free", func() bool { return len(s.ShadowQueue) == 1 })
	close(release["B"])
	waitFor(t, "B to finish", matches(2)) // B's compare: alone -> solo.
	waitFor(t, "B's slot to free", func() bool { return len(s.ShadowQueue) == 0 })

	want := map[[2]string]float64{{"decode", "ok"}: 1, {"compute", "served"}: 0, {"compare", "ok"}: 1}
	for p, solo := range want {
		if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels(p[0], p[1])); n != 2 {
			t.Errorf("feed_go_shadow_phase_seconds{%s,%s} count = %v, want 2 (wall time is recorded for every sample)", p[0], p[1], n)
		}
		if n, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_total", phaseLabels(p[0], p[1])); n != solo {
			t.Errorf("feed_go_shadow_phase_solo_total{%s,%s} = %v, want %v", p[0], p[1], n, solo)
		}
	}
}

// A sample admitted AND released inside another sample's phase leaves the queue length as it was, so
// only the admission counter can exclude that phase. Here a bad body (400, slot released before the
// handler returns) arrives while A is in compute: A's compute must not be counted solo, and A's
// compare, which nothing overlaps, must be (so the exclusion is not just "nothing is ever solo").
func TestShadowPhaseCPUExcludesSampleAdmittedAndReleasedDuringPhase(t *testing.T) {
	if _, ok := processCPU(); !ok {
		t.Skip("no process CPU clock on this platform")
	}
	reg := prometheus.NewRegistry()
	entered, release := make(chan struct{}), make(chan struct{})
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		close(entered)
		<-release
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})

	post(t, s, "A")
	<-entered // A's compute started alone.
	w := httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequest(http.MethodPost, "/internal/shadow/"+Procedure, strings.NewReader("not json")))
	if w.Code != http.StatusBadRequest || len(s.ShadowQueue) != 1 {
		t.Fatalf("bad body: code=%d queued=%d, want 400 and 1 (only A)", w.Code, len(s.ShadowQueue))
	}
	close(release)
	waitFor(t, "A to finish", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"result": "match"})
		return v == 1 && len(s.ShadowQueue) == 0
	})

	for p, solo := range map[[2]string]float64{{"decode", "ok"}: 1, {"compute", "served"}: 0, {"compare", "ok"}: 1, {"decode", "bad_request"}: 0} {
		if n, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_total", phaseLabels(p[0], p[1])); n != solo {
			t.Errorf("feed_go_shadow_phase_solo_total{%s,%s} = %v, want %v", p[0], p[1], n, solo)
		}
	}
}

func TestShadowPhaseRecordedForBadBody(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	w := httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequest(http.MethodPost, "/internal/shadow/"+Procedure, strings.NewReader("not json")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code %d, want 400", w.Code)
	}
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels("decode", "bad_request")); n != 1 {
		t.Fatalf("decode/bad_request count = %v, want 1", n)
	}
	if _, found := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels("compute", "served")); found {
		t.Fatal("a bad body must not reach compute")
	}
}
