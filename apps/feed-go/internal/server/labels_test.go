package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime/pprof"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// profileLabelsOf is the pprof labels a compute saw, by the literal label names (not the constants,
// so the test reads the same on code that predates them).
func profileLabelsOf(ctx context.Context) [2]string {
	ep, _ := pprof.Label(ctx, "feed_endpoint")
	mode, _ := pprof.Label(ctx, "mode")
	return [2]string{ep, mode}
}

// Every public tRPC route computes under its own feed_endpoint and mode=serve labels, on the context
// the compute receives and on the request's.
func TestServeRunsUnderProfileLabels(t *testing.T) {
	for _, c := range []struct {
		endpoint string
		call     func(s *Server, w http.ResponseWriter, r *http.Request)
		set      func(s *Server, fn func(context.Context, *http.Request) (*computed, error))
	}{
		{EndpointAsPosts, (*Server).ServeHTTP, func(s *Server, fn func(context.Context, *http.Request) (*computed, error)) { s.computeFn = fn }},
		{EndpointInfinite, (*Server).ServeInfiniteHTTP, func(s *Server, fn func(context.Context, *http.Request) (*computed, error)) {
			s.ServeInfinite, s.computeInfiniteFn = true, fn
		}},
		{EndpointModelGetAll, (*Server).ServeModelGetAllHTTP, func(s *Server, fn func(context.Context, *http.Request) (*computed, error)) {
			s.ServeModelGetAll, s.computeModelsFn = true, fn
		}},
	} {
		t.Run(c.endpoint, func(t *testing.T) {
			var fromCtx, fromReq [2]string
			s := serveServer(prometheus.NewRegistry(), nil, &proxyRecorder{})
			c.set(s, func(ctx context.Context, r *http.Request) (*computed, error) {
				fromCtx, fromReq = profileLabelsOf(ctx), profileLabelsOf(r.Context()) //nolint:contextcheck // reads the request's own context, the one the handler labelled
				return nil, fallback.New("test")
			})
			c.call(s, httptest.NewRecorder(), publicRequest())
			want := [2]string{c.endpoint, "serve"}
			if fromCtx != want || fromReq != want {
				t.Fatalf("compute labels: context %q, request %q; want %q", fromCtx, fromReq, want)
			}
		})
	}
}

// The goroutine that computes a served answer carries the labels too (what a CPU profile records,
// not only what the context says), and the handler's goroutine has its own labels back once the
// request returns, so no later work on it is charged to this route.
func TestServeSetsGoroutineProfileLabels(t *testing.T) {
	before, ok := testkit.GoroutineLabels()
	if !ok {
		t.Fatal("the goroutine profile has no record of this goroutine")
	}
	var inCompute map[string]string
	s := serveServer(prometheus.NewRegistry(), nil, &proxyRecorder{})
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		inCompute, ok = testkit.GoroutineLabels()
		return nil, fallback.New("test")
	}
	s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	if want := map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "serve"}; !ok || len(inCompute) != 2 ||
		inCompute["feed_endpoint"] != want["feed_endpoint"] || inCompute["mode"] != want["mode"] {
		t.Fatalf("compute goroutine labels %v (read %v), want %v", inCompute, ok, want)
	}
	after, ok := testkit.GoroutineLabels()
	if !ok || len(after) != len(before) {
		t.Fatalf("after the request: goroutine labels %v, want %v", after, before)
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("after the request: goroutine labels %v, want %v", after, before)
		}
	}
}

// A shadow sample's comparison runs in a background goroutine on the server's own context: it carries
// the sample's feed_endpoint and mode=shadow labels there too.
func TestShadowRunsUnderProfileLabels(t *testing.T) {
	got := make(chan [2]string, 1)
	s := newPhaseServer(prometheus.NewRegistry(), 1, func(ctx context.Context, _ *http.Request) (*computed, error) {
		got <- profileLabelsOf(ctx)
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	post(t, s, "{}")
	select {
	case labels := <-got:
		if want := [2]string{EndpointAsPosts, "shadow"}; labels != want {
			t.Fatalf("shadow compute labels %q, want %q", labels, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the shadow sample never computed")
	}
	waitFor(t, "the sample to finish", func() bool { return len(s.ShadowQueue) == 0 })
}

// A Go-first probe runs in a background goroutine too: under its endpoint's labels and mode=probe.
func TestProbeRunsUnderProfileLabels(t *testing.T) {
	env, fx, _ := probeEnv(t)
	got := make(chan [2]string, 1)
	orig := probes[Procedure]
	probes[Procedure] = probeSpec{endpoint: orig.endpoint, run: func(_ *Server, ctx context.Context, _ ProbeRequest, _ *hydrate.PresenceProbe) error {
		got <- profileLabelsOf(ctx)
		return nil
	}}
	t.Cleanup(func() { probes[Procedure] = orig })
	mux := InternalMux(env.server, http.NotFoundHandler(), false)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, float64(time.Now().UnixNano())/1e6)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
	select {
	case labels := <-got:
		if want := [2]string{EndpointAsPosts, "probe"}; labels != want {
			t.Fatalf("probe labels %q, want %q", labels, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the probe never ran")
	}
	waitFor(t, "the probe to finish", func() bool { return len(env.server.ProbeQueue) == 0 })
}

// gatheredFamilies is every metric family name a registry with cs registered exposes.
func gatheredFamilies(t *testing.T, cs ...prometheus.Collector) map[string]bool {
	t.Helper()
	reg := prometheus.NewRegistry()
	reg.MustRegister(cs...)
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, mf := range mfs {
		out[mf.GetName()] = true
	}
	return out
}

// NewGoCollector adds the runtime CPU-class and GC families to the default Go collector, and only
// those: every family it adds is go_cpu_classes_* or go_gc_*, and the CPU split a CPU-per-request
// reading needs (GC, scavenger, idle, user) is among them.
func TestGoCollectorAddsOnlyCPUClassAndGCFamilies(t *testing.T) {
	base := gatheredFamilies(t, collectors.NewGoCollector())
	got := gatheredFamilies(t, NewGoCollector())
	var added []string
	for name := range got {
		if !base[name] {
			added = append(added, name)
		}
	}
	sort.Strings(added)
	for _, name := range added {
		if !strings.HasPrefix(name, "go_cpu_classes_") && !strings.HasPrefix(name, "go_gc_") {
			t.Errorf("NewGoCollector adds %s, outside the /cpu/classes/ and /gc/ families", name)
		}
	}
	for name := range base {
		if !got[name] {
			t.Errorf("NewGoCollector drops the default family %s", name)
		}
	}
	for _, want := range []string{
		"go_cpu_classes_gc_total_cpu_seconds_total",
		"go_cpu_classes_scavenge_total_cpu_seconds_total",
		"go_cpu_classes_idle_cpu_seconds_total",
		"go_cpu_classes_user_cpu_seconds_total",
		"go_gc_cycles_total_gc_cycles_total",
	} {
		if !got[want] {
			t.Errorf("NewGoCollector does not export %s (added: %v)", want, added)
		}
	}
}

// Registered as main registers it, next to the process collector and this service's own series (no
// descriptor collides), /metrics serves its CPU-class series.
func TestMetricsServesCPUClasses(t *testing.T) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	NewMetrics(reg)
	srv := httptest.NewServer(MetricsHandler(reg, false))
	t.Cleanup(srv.Close)
	resp, err := getURL(srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"\ngo_cpu_classes_gc_total_cpu_seconds_total ", "\ngo_cpu_classes_user_cpu_seconds_total "} {
		if !strings.Contains(string(body), want) {
			t.Errorf("/metrics has no %q series", strings.TrimSpace(want))
		}
	}
}
