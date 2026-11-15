package server

import (
	"github.com/prometheus/client_golang/prometheus"
)

// EndpointLabel names the endpoint label. Not `endpoint`: that is a reserved scrape target label (the
// scraper's target label, set to the scrape port's name), which overwrites a series' own `endpoint`
// and moves ours to `exported_endpoint`, so a query on `endpoint="as-posts"` would match nothing.
const EndpointLabel = "feed_endpoint"

// Metrics are this service's Prometheus series. The Go and process collectors (registered in main)
// add `process_cpu_seconds_total` and the GC series the CPU-per-call measurement reads.
//
// Every feed_go_* series carries EndpointLabel (`feed_endpoint`: one of Endpoints, EndpointAsPosts |
// EndpointV1Images | EndpointInfinite): three values, so the label multiplies each family's
// cardinality by three at most.
type Metrics struct {
	Requests      *prometheus.CounterVec   // endpoint, mode, outcome
	Fallbacks     *prometheus.CounterVec   // endpoint, mode, reason
	Duration      *prometheus.HistogramVec // endpoint, mode, outcome
	ShadowResults *prometheus.CounterVec   // endpoint, result
	ShadowDiffs   *prometheus.CounterVec   // endpoint, category, kind
	ShadowDropped *prometheus.CounterVec   // endpoint

	// Per-phase cost of a shadow sample (DESIGN.md §10). Phases: decode (read + parse the posted
	// sample, Node's envelope included), compute (the answer serving would produce), compare
	// (shadow.Compare + Classify). Labels: endpoint, phase, outcome.
	ShadowPhase     *prometheus.HistogramVec // wall time, every sample
	ShadowPhaseCPU  *prometheus.CounterVec   // process CPU over the phase, solo phases only
	ShadowPhaseSolo *prometheus.CounterVec   // phases counted in ShadowPhaseCPU
	// Wall time of the phases counted in ShadowPhaseCPU: against ShadowPhase's mean it shows whether
	// the solo phases are shorter than the rest (the length bias, DESIGN.md §10.1).
	ShadowPhaseSoloWall *prometheus.CounterVec

	// Panics counts recovered panics by where (serve | shadow). Not per endpoint.
	Panics *prometheus.CounterVec
	// RevocationFailOpen counts session revocation reads that failed and allowed the request.
	RevocationFailOpen prometheus.Counter
	// JWKSRefresh counts periodic JWKS refreshes by result (ok | error).
	JWKSRefresh *prometheus.CounterVec
	// JWKSStale counts the times the key set was dropped for being older than its maximum staleness.
	JWKSStale prometheus.Counter
}

// NewMetrics registers the series on reg.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_requests_total",
			Help: "Requests by mode (serve|shadow) and outcome (served|served_empty|fallback|error).",
		}, []string{EndpointLabel, "mode", "outcome"}),
		Fallbacks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_fallback_total",
			Help: "Requests this service did not answer itself, by reason.",
		}, []string{EndpointLabel, "mode", "reason"}),
		Duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "feed_go_request_duration_seconds",
			Help:    "Wall time computing a response (excludes a proxied fallback).",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{EndpointLabel, "mode", "outcome"}),
		ShadowResults: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_compare_total",
			Help: "Shadow comparisons by result: match, match_empty, fields, order, membership, unsupported, deadline, go_error, bad_request.",
		}, []string{EndpointLabel, "result"}),
		ShadowDiffs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_field_diffs_total",
			Help: "Differing paths found by shadow comparisons, by path category and kind.",
		}, []string{EndpointLabel, "category", "kind"}),
		ShadowDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_dropped_total",
			Help: "Shadow requests dropped because the comparison queue was full.",
		}, []string{EndpointLabel}),
		ShadowPhase: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "feed_go_shadow_phase_seconds",
			Help:    "Wall time per shadow-sample phase (decode|compute|compare), by outcome.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{EndpointLabel, "phase", "outcome"}),
		ShadowPhaseCPU: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_phase_cpu_seconds_total",
			Help: "Process CPU seconds spent during a shadow-sample phase, counted only when no other shadow sample overlapped it.",
		}, []string{EndpointLabel, "phase", "outcome"}),
		ShadowPhaseSolo: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_phase_solo_total",
			Help: "Shadow-sample phases counted in feed_go_shadow_phase_cpu_seconds_total (the denominator for CPU per phase).",
		}, []string{EndpointLabel, "phase", "outcome"}),
		ShadowPhaseSoloWall: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_phase_solo_wall_seconds_total",
			Help: "Wall seconds of the shadow-sample phases counted in feed_go_shadow_phase_cpu_seconds_total.",
		}, []string{EndpointLabel, "phase", "outcome"}),
		Panics: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_panics_total",
			Help: "Recovered panics, by where they were caught (serve: a public request, answered by the fallback; shadow: a shadow sample, dropped).",
		}, []string{"where"}),
		RevocationFailOpen: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feed_go_revocation_fail_open_total",
			Help: "Session revocation reads that failed (store slow or down) and let the session through, as the app does.",
		}),
		JWKSRefresh: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_jwks_refresh_total",
			Help: "Periodic JWKS refreshes by result (ok|error); an error keeps the last good key set.",
		}, []string{"result"}),
		JWKSStale: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feed_go_jwks_stale_total",
			Help: "Times the JWKS key set was dropped (sessions verify as signed out) because no fetch had succeeded for FEED_GO_JWKS_MAX_STALENESS_MS.",
		}),
	}
	// Seed the dropped counter per endpoint, and the panic and refresh counters, so "none" reads 0
	// rather than an absent series.
	for _, e := range Endpoints {
		m.ShadowDropped.WithLabelValues(e)
		m.ShadowResults.WithLabelValues(e, "deadline")
	}
	for _, w := range []string{"serve", "shadow"} {
		m.Panics.WithLabelValues(w)
	}
	for _, r := range []string{"ok", "error"} {
		m.JWKSRefresh.WithLabelValues(r)
	}
	reg.MustRegister(m.Requests, m.Fallbacks, m.Duration, m.ShadowResults, m.ShadowDiffs, m.ShadowDropped,
		m.ShadowPhase, m.ShadowPhaseCPU, m.ShadowPhaseSolo, m.ShadowPhaseSoloWall,
		m.Panics, m.RevocationFailOpen, m.JWKSRefresh, m.JWKSStale)
	return m
}
