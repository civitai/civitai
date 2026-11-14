package server

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics are this service's Prometheus series. The Go and process collectors (registered in main)
// add `process_cpu_seconds_total` and the GC series the CPU-per-call measurement reads.
type Metrics struct {
	Requests      *prometheus.CounterVec   // mode, outcome
	Fallbacks     *prometheus.CounterVec   // mode, reason
	Duration      *prometheus.HistogramVec // mode, outcome
	ShadowResults *prometheus.CounterVec   // result
	ShadowDiffs   *prometheus.CounterVec   // category, kind
	ShadowDropped prometheus.Counter

	// Per-phase cost of a shadow sample (DESIGN.md §10). Phases: decode (read + parse the posted
	// sample, Node's envelope included), compute (the answer serving would produce), compare
	// (shadow.Compare + Classify). Labels: phase, outcome.
	ShadowPhase     *prometheus.HistogramVec // wall time, every sample
	ShadowPhaseCPU  *prometheus.CounterVec   // process CPU over the phase, solo phases only
	ShadowPhaseSolo *prometheus.CounterVec   // phases counted in ShadowPhaseCPU
}

// NewMetrics registers the series on reg.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_requests_total",
			Help: "Requests by mode (serve|shadow) and outcome (served|fallback|error).",
		}, []string{"mode", "outcome"}),
		Fallbacks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_fallback_total",
			Help: "Requests this service did not answer itself, by reason.",
		}, []string{"mode", "reason"}),
		Duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "feed_go_request_duration_seconds",
			Help:    "Wall time computing a response (excludes a proxied fallback).",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{"mode", "outcome"}),
		ShadowResults: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_compare_total",
			Help: "Shadow comparisons by result: match, fields, order, membership, unsupported, go_error, bad_request.",
		}, []string{"result"}),
		ShadowDiffs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_field_diffs_total",
			Help: "Differing paths found by shadow comparisons, by path category and kind.",
		}, []string{"category", "kind"}),
		ShadowDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feed_go_shadow_dropped_total",
			Help: "Shadow requests dropped because the comparison queue was full.",
		}),
		ShadowPhase: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "feed_go_shadow_phase_seconds",
			Help:    "Wall time per shadow-sample phase (decode|compute|compare), by outcome.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{"phase", "outcome"}),
		ShadowPhaseCPU: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_phase_cpu_seconds_total",
			Help: "Process CPU seconds spent during a shadow-sample phase, counted only when no other shadow sample overlapped it.",
		}, []string{"phase", "outcome"}),
		ShadowPhaseSolo: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_phase_solo_total",
			Help: "Shadow-sample phases counted in feed_go_shadow_phase_cpu_seconds_total (the denominator for CPU per phase).",
		}, []string{"phase", "outcome"}),
	}
	reg.MustRegister(m.Requests, m.Fallbacks, m.Duration, m.ShadowResults, m.ShadowDiffs, m.ShadowDropped,
		m.ShadowPhase, m.ShadowPhaseCPU, m.ShadowPhaseSolo)
	return m
}
