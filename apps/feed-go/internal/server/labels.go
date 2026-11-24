package server

import (
	"context"
	"regexp"
	"runtime/pprof"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Profile labels: every public, shadow and probe handler runs under the pprof labels
// ProfileLabelEndpoint (one of Endpoints, the `feed_endpoint` of its metrics) and ProfileLabelMode
// (`serve`, `shadow` or `probe`, the `mode` of its metrics), so one CPU profile pulled from
// /debug/pprof/profile (FEED_GO_PPROF) splits per route and per mode: `go tool pprof -tagfocus
// feed_endpoint=infinite -tagfocus mode=serve`, or `-tags` for the split itself. The labels are on
// the handler's goroutine and on its context, so every goroutine the request starts (a hydration
// errgroup worker, a shadow or probe sample's background goroutine) inherits them. They change no
// answer, header or metric.
const (
	ProfileLabelEndpoint = EndpointLabel
	ProfileLabelMode     = "mode"
)

// withProfileLabels runs fn with ctx's and the goroutine's pprof labels set to endpoint and mode
// (pprof.Do: restored when fn returns).
func withProfileLabels(ctx context.Context, endpoint, mode string, fn func(context.Context)) {
	pprof.Do(ctx, pprof.Labels(ProfileLabelEndpoint, endpoint, ProfileLabelMode, mode), fn)
}

// goRuntimeMetrics are the runtime/metrics families NewGoCollector exports on top of the collector's
// defaults: the CPU classes (`/cpu/classes/…`: GC mark assist / dedicated / idle / pause, scavenger,
// idle and user CPU seconds) and the GC families (`/gc/…`: cycles, heap goal, allocs and frees by
// count and size, stack and globals scan, gogc, gomemlimit, pauses). Both are fixed sets the runtime
// defines, independent of traffic, so the series count is bounded.
var goRuntimeMetrics = regexp.MustCompile(`^/(cpu/classes|gc)/`)

// NewGoCollector is the Go runtime collector main registers (once): the default Go collector plus the
// goRuntimeMetrics families, so a dashboard can read GC, scavenger, idle and user CPU time next to
// process_cpu_seconds_total.
func NewGoCollector() prometheus.Collector {
	return collectors.NewGoCollector(collectors.WithGoCollectorRuntimeMetrics(collectors.GoRuntimeMetricsRule{Matcher: goRuntimeMetrics}))
}
