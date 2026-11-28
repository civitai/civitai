package server

import (
	"net/http"
	"slices"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// EndpointLabel names the endpoint label. Not `endpoint`: that is a reserved scrape target label (the
// scraper's target label, set to the scrape port's name), which overwrites a series' own `endpoint`
// and moves ours to `exported_endpoint`, so a query on `endpoint="as-posts"` would match nothing.
const EndpointLabel = "feed_endpoint"

// Metrics are this service's Prometheus series. The Go and process collectors (registered in main)
// add `process_cpu_seconds_total` and the GC series the CPU-per-call measurement reads.
//
// Every feed_go_* series carries EndpointLabel (`feed_endpoint`), one of Endpoints.
type Metrics struct {
	Requests  *prometheus.CounterVec   // endpoint, mode, outcome
	Fallbacks *prometheus.CounterVec   // endpoint, mode, reason
	Duration  *prometheus.HistogramVec // endpoint, mode, outcome
	// ShadowResults, ShadowDiffs and ShadowResponse are the body and header comparisons of the Node
	// shadow samples: feed_go_shadow_compare_total, feed_go_shadow_field_diffs_total and
	// feed_go_shadow_response_total curried with source="shadow" (SourceShadow). The Parity* fields
	// are the same three families curried with source="serve-parity" (SourceServeParity): the
	// serve-side parity sampler's comparisons (serveparity.go). One family each, so a query that sums
	// by feed_endpoint (the recorded parity ratios) reads both sources, and `source` splits them.
	ShadowResults  *prometheus.CounterVec // endpoint, result
	ShadowDiffs    *prometheus.CounterVec // endpoint, category, kind
	ShadowDropped  *prometheus.CounterVec // endpoint
	ParityResults  *prometheus.CounterVec // endpoint, result (source="serve-parity")
	ParityDiffs    *prometheus.CounterVec // endpoint, category, kind (source="serve-parity")
	ParityResponse *prometheus.CounterVec // endpoint, result (source="serve-parity")
	// ServeParity counts the serve-side parity sampler's replays by outcome (feed_go_serve_parity_total:
	// endpoint, outcome: ServeParityOutcomes).
	ServeParity *prometheus.CounterVec

	// ShadowViewer counts the body comparison results of the endpoints whose answer reports a viewer
	// class (model-associated: modelfeed.ViewerClasses; the tRPC feeds: FeedViewerClasses), so a serve
	// gate can require samples per class (endpoint, viewer, result: ShadowResults' values). Seeded for
	// each class's match result.
	ShadowViewer *prometheus.CounterVec

	// ShadowResponse counts the header comparison of each compared sample, beside the body's
	// ShadowResults (endpoint, result: match|mismatch|uncompared).
	ShadowResponse *prometheus.CounterVec

	// ShadowResponseViewer is ShadowResponse's match and mismatch per viewer class, for the tRPC feeds
	// (FeedViewerEndpoints; endpoint, viewer: FeedViewerClasses, result). Seeded for every class and
	// result.
	ShadowResponseViewer *prometheus.CounterVec

	// Per-phase cost of a shadow sample (DESIGN.md §10). Phases: decode (read + parse the posted
	// sample, Node's envelope included), compute (the answer serving would produce), compare
	// (shadow.Compare + Classify). Labels: endpoint, phase, outcome.
	ShadowPhase     *prometheus.HistogramVec // wall time, every sample
	ShadowPhaseCPU  *prometheus.CounterVec   // process CPU over the phase, solo phases only
	ShadowPhaseSolo *prometheus.CounterVec   // phases counted in ShadowPhaseCPU
	// Wall time of the phases counted in ShadowPhaseCPU: against ShadowPhase's mean it shows whether
	// the solo phases are shorter than the rest (the length bias, DESIGN.md §10.1).
	ShadowPhaseSoloWall *prometheus.CounterVec

	// The Go-first probe (probe.go, DESIGN.md "Go-first probe").
	GoFirst        *prometheus.CounterVec // endpoint, result: would_serve | would_miss | raced | unsupported | error; viewer: GoFirstViewers
	GoFirstMiss    *prometheus.CounterVec // endpoint, cache: probes in which that cache missed an id
	GoFirstDropped *prometheus.CounterVec // endpoint: probes dropped (queue full, shutting down)
	GoFirstRaced   *prometheus.CounterVec // endpoint, cache: probes in which that cache had a raced entry
	// The cost gate: database queries a Go-first serve would make for the misses Go answers itself,
	// by cache, and the pages they were counted over (served probes only).
	GoFirstDBReads *prometheus.CounterVec // endpoint, cache
	GoFirstPages   *prometheus.CounterVec // endpoint
	// Seconds from the Node request's start to the probe's first cache read.
	GoFirstCheckLag *prometheus.HistogramVec // endpoint

	// Panics counts recovered panics by where (serve | shadow | probe | serve-parity | eval-capture). Not per endpoint.
	Panics *prometheus.CounterVec
	// RevocationDegraded counts session revocation reads that failed, by the verdict then given from the
	// markers already read (verdict: deny_cached | allow_unknown).
	RevocationDegraded *prometheus.CounterVec
	// JWKSRefresh counts periodic JWKS refreshes by result (ok | error).
	JWKSRefresh *prometheus.CounterVec
	// JWKSStale counts the times the key set was dropped for being older than its maximum staleness.
	JWKSStale prometheus.Counter
	// SessionCookieSlot counts resolved sessions by the cookie slot they were read from (auth.CookieSlot).
	SessionCookieSlot *prometheus.CounterVec
	// DevalueWrites counts the answers a public tRPC route computed and wrote, by write format
	// (endpoint, result: devalue | superjson_fallback | superjson). superjson_fallback is a request
	// that would have been devalue whose value devalue refused (computed.encode), so it was written as
	// superjson: the app's devalueFallbackObserver case, also logged once per answer.
	DevalueWrites *prometheus.CounterVec
	// FallbackProxyErrors counts fallback requests the proxy answered 502 because the Node app failed
	// before a response started, by reason (upstream | canceled). A failure mid-body aborts the
	// response with http.ErrAbortHandler and is not counted. Not per endpoint.
	FallbackProxyErrors *prometheus.CounterVec
	// ServeInFlight is the public requests computing now, each holding a serve slot (at most
	// Server.MaxInFlight across every public route; one past it is the `bulkhead` fallback), by the
	// feed_endpoint of the route holding it: one gauge per served endpoint, resolved here so the serve
	// path does no label lookup.
	ServeInFlight map[string]prometheus.Gauge
	// Errors counts every compute and proxy error (feed_go_errors_total: endpoint, mode, class), the
	// ones whose log line the limiter drops included. Labels are closed sets: Endpoints (+
	// EndpointUnknown), ErrorModes, fallback.ErrorClasses.
	Errors *prometheus.CounterVec
	// CacheMisses counts the per-entity cache misses hydration computed (cache, result: computed |
	// error), per missed id. Not per endpoint: hydration is shared by both.
	CacheMisses *prometheus.CounterVec
	// CacheWrites counts the cache writes of write-back (feed_go_cache_writes_total: cache, result:
	// written | nx_lost | error), per key. Seeded only for the written-back caches (SeedCacheWrites).
	CacheWrites *prometheus.CounterVec
	// SearchRejected counts the text searches of GET /api/v1/models the search guard did not make
	// (feed_go_search_rejected_total: why = open | busy; v1models.MeiliClient.OnReject). Each is a
	// `v1-models-query` fallback too, which alone would not tell it from the switch being off.
	SearchRejected *prometheus.CounterVec
	// ShadowServable counts the site-search shadow samples by what the public route would have done with
	// the same request (feed_go_shadow_servable_total: endpoint, reason: SearchServable, else the
	// hand-back reason; observeSearchServable). Seeded for SearchServable, SearchServeOnlyReasons and
	// searchServableComputeReasons.
	ShadowServable *prometheus.CounterVec
	// EvalCapture counts the eval capture's taps by outcome (feed_go_eval_capture_total: endpoint,
	// source: evalcapture.Sources, outcome: evalcapture.Outcomes, and evalcapture.OutcomeRefused for
	// corpus-only; evalcapture.go). Seeded per source for the endpoints it captures.
	EvalCapture *prometheus.CounterVec
	// EvalCaptureUnresolved counts the outcome-unresolved captures again, by why the viewer was not
	// resolved (feed_go_eval_capture_unresolved_total: endpoint, source, reason:
	// evalcapture.UnresolvedReasons). Seeded per source that resolves a viewer (not corpus-only).
	EvalCaptureUnresolved *prometheus.CounterVec
	// EvalCaptureRowsDropped counts the eval capture's rows its writers dropped, by table (samples |
	// cases) and chwrite reason (feed_go_eval_capture_rows_dropped_total): a batch ClickHouse refused
	// after its retries included, which feed_go_eval_capture_total (rows queued) cannot see. Not per
	// endpoint: a batch mixes endpoints.
	EvalCaptureRowsDropped *prometheus.CounterVec
	// FeedUnavailable counts the image.getInfinite 503s written here for a failed feed-service call
	// (outcome feed_unavailable), by why the call failed (feed_go_feed_unavailable_total: endpoint,
	// reason, detail; feedUnavailableCause). Not seeded: the series appear with the first failure.
	FeedUnavailable *prometheus.CounterVec
	// FeedRetry counts the second feed-service calls image.getInfinite makes when it answers the app's
	// 503 here (feed.WithFeedRetry), by outcome (feed_go_feed_retry_total: endpoint, outcome, one of
	// feed.RetryOutcomes). Seeded on the infinite route.
	FeedRetry *prometheus.CounterVec
}

// MetricsHandler is the /metrics handler over g. With openMetrics (on with tracing) it answers a scrape
// that asks for OpenMetrics in that format, the only one that carries the duration histograms'
// trace-id exemplars; any other scrape gets the classic text format either way.
func MetricsHandler(g prometheus.Gatherer, openMetrics bool) http.Handler {
	return promhttp.HandlerFor(g, promhttp.HandlerOpts{EnableOpenMetrics: openMetrics})
}

// ObserveCacheMiss is hydrate.MissCompute's Observe.
func (m *Metrics) ObserveCacheMiss(cache, result string, n int) {
	m.CacheMisses.WithLabelValues(cache, result).Add(float64(n))
}

// ObserveCacheWrite is hydrate.MissCompute's ObserveWrite.
func (m *Metrics) ObserveCacheWrite(cache, result string, n int) {
	m.CacheWrites.WithLabelValues(cache, result).Add(float64(n))
}

// SeedCacheWrites creates the write counter's series of caches (the written-back ones) for every
// result, so a write-back cache that has written nothing, or lost no race, reads 0 rather than an
// absent series.
func (m *Metrics) SeedCacheWrites(caches []string) {
	for _, c := range caches {
		for _, r := range hydrate.WriteResults {
			m.CacheWrites.WithLabelValues(c, r)
		}
	}
}

// probeLagBuckets resolve the first tens of milliseconds, where the probe races Node's fills.
var probeLagBuckets = []float64{.001, .0025, .005, .01, .015, .025, .05, .075, .1, .25, .5, 1, 2.5}

// NewMetrics registers the series on reg.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_requests_total",
			Help: "Requests by mode (serve|shadow) and outcome (served|served_empty|served_cached|fallback|error|region_blocked|feed_unavailable|not_found).",
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
		ShadowViewer: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_compare_viewer_total",
			Help: "Shadow comparison results by the sample's viewer class (anon, user, owner, moderator), for the endpoints whose answer reports one.",
		}, []string{EndpointLabel, "viewer", "result"}),
		EvalCapture: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_eval_capture_total",
			Help: "Eval capture taps (DESIGN.md §19.6) by source (shadow | serve-parity | serve | corpus-only) and outcome: written (admitted: sample and case rows queued), deduped (sample row queued, not admitted), unresolved (the viewer could not be resolved; nothing captured), invalid (the request built no case), dropped (lost to load or shutdown: a row not queued, a T3 capture with every worker busy), refused (corpus-only: a sample still carrying a credential or Node's answer).",
		}, []string{EndpointLabel, "source", "outcome"}),
		EvalCaptureUnresolved: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_eval_capture_unresolved_total",
			Help: "Eval capture taps whose viewer could not be resolved (feed_go_eval_capture_total outcome unresolved), by reason: bearer-token (an API credential), session-cache-miss, session-cache-cleared, session-id-mismatch, other.",
		}, []string{EndpointLabel, "source", "reason"}),
		EvalCaptureRowsDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_eval_capture_rows_dropped_total",
			Help: "Eval capture rows the ClickHouse writers dropped, by table (samples | cases) and reason (queue_full, marshal, http_4xx, http_5xx, http_other, transport, shutdown).",
		}, []string{"table", "reason"}),
		ServeParity: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_serve_parity_total",
			Help: "Serve-side parity replays (a served answer re-asked of the Node app after the response), by outcome: compared, dropped_queue, skipped_bulkhead, skipped_credential, skipped_closing, upstream_error, upstream_status, timeout, bad_body.",
		}, []string{EndpointLabel, "outcome"}),
		ShadowResponseViewer: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_response_viewer_total",
			Help: "feed_go_shadow_response_total's match and mismatch by the sample's viewer class (anon, crawler, banned, user, moderator), for the tRPC feed endpoints (Node shadow samples only).",
		}, []string{EndpointLabel, "viewer", "result"}),
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
		GoFirst: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_total",
			Help: "Go-first probes by result: would_serve, would_miss (a cache Go falls back on missed), raced (an entry of a cache Go falls back on, filled after the request began), unsupported (another fallback), error; and viewer class (anon, crawler, banned, user, moderator; unknown: the probe ended before its viewer was resolved, or the endpoint reports none).",
		}, []string{EndpointLabel, "result", "viewer"}),
		GoFirstMiss: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_miss_total",
			Help: "Go-first probes in which the cache missed at least one id, by cache (whatever the probe's result).",
		}, []string{EndpointLabel, "cache"}),
		GoFirstDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_dropped_total",
			Help: "Go-first probes dropped because the probe queue was full or the service was shutting down.",
		}, []string{EndpointLabel}),
		GoFirstRaced: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_raced_total",
			Help: "Go-first probes in which the cache held an entry filled at or after the request began (less the skew margin), every cache whatever the probe's result: the probe likely lost the race to Node's fill there.",
		}, []string{EndpointLabel, "cache"}),
		GoFirstDBReads: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_db_reads_total",
			Help: "Database queries a Go-first serve would make for the cache misses, and the entries filled after the request began, of the caches Go answers itself (replica path or computed), by cache; served probes (would_serve, raced) only. A lower bound.",
		}, []string{EndpointLabel, "cache"}),
		GoFirstPages: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_gofirst_pages_total",
			Help: "Page hydrations checked by served Go-first probes (would_serve, raced): the denominator of DB reads per page.",
		}, []string{EndpointLabel}),
		GoFirstCheckLag: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "feed_go_gofirst_check_lag_seconds",
			Help:    "Seconds from the start of the sampled Node request to the probe's first page-cache read (the margin over Node's own fills).",
			Buckets: probeLagBuckets,
		}, []string{EndpointLabel}),
		Panics: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_panics_total",
			Help: "Recovered panics, by where they were caught (serve: a public request, answered by the fallback; shadow: a shadow sample, dropped; probe: a Go-first probe, counted as error).",
		}, []string{"where"}),
		RevocationDegraded: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_revocation_degraded_total",
			Help: "Session revocation reads that failed (store slow or down), by verdict: deny_cached (a revocation marker this process had already read applied; signed out) or allow_unknown (no known marker applied; the session was allowed), as the app's session_revocation_degraded_total.",
		}, []string{"verdict"}),
		JWKSRefresh: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_jwks_refresh_total",
			Help: "Periodic JWKS refreshes by result (ok|error); an error keeps the last good key set.",
		}, []string{"result"}),
		CacheMisses: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_cache_miss_total",
			Help: "Per-entity cache miss ids this service computed itself (result=computed) or failed to (result=error, the request falls back), by cache.",
		}, []string{"cache", "result"}),
		CacheWrites: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_cache_writes_total",
			Help: "Cache writes of write-back (FEED_GO_CACHE_WRITEBACK), per key, by cache and result: written, nx_lost (a SET NX found the key filled by another writer since the read; nothing written) or error (the write failed). Series exist only for the written-back caches.",
		}, []string{"cache", "result"}),
		SearchRejected: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_search_rejected_total",
			Help: "Text searches (GET /api/v1/models `query`) not made, by why: open (the search circuit is open, or its half-open trial is in flight) or busy (the per-process concurrency cap is reached). Each is handed back to the app as a v1-models-query fallback.",
		}, []string{"why"}),
		ShadowServable: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_shadow_servable_total",
			Help: "Site-search shadow samples by what the public route would have done with the same request: servable (answered by this service), else the reason it would hand it back to the app (the shadow's own fallback reason, or a check only the public route makes: region-blocked (a drift signal: the app answers a blocked region before sampling), search-etag, search-profanity). Not counted: the rate-limit ceiling, the client-address case and the body size, which a sample does not show, and requests the app never samples (API credentials, every answer but a 200).",
		}, []string{EndpointLabel, "reason"}),
		Errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_errors_total",
			Help: "Compute errors (mode serve|shadow|probe) and fallback-proxy errors (mode proxy), by the error's class (fallback.ErrorClasses: deadline, canceled, pg_no_rows, pg_<SQLSTATE class>, redis_nil, timeout, conn_refused, http_5xx, ...). Every error is counted, whether or not its log line was rate-limited.",
		}, []string{EndpointLabel, "mode", "class"}),
		JWKSStale: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feed_go_jwks_stale_total",
			Help: "Times the JWKS key set was dropped (sessions verify as signed out) because no fetch had succeeded for FEED_GO_JWKS_MAX_STALENESS_MS.",
		}),
		DevalueWrites: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_devalue_write_total",
			Help: "Answers written on a public tRPC route, by format: devalue (TRPC_WRITE_DEVALUE on, a capable web bundle, not edge-cacheable), superjson_fallback (would have been devalue, but devalue refused the value), superjson (every other answer).",
		}, []string{EndpointLabel, "result"}),
		SessionCookieSlot: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_session_cookie_slot_total",
			Help: "Sessions resolved from a session cookie, by the cookie slot they were read from (host | shared).",
		}, []string{"slot"}),
		FeedUnavailable: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_feed_unavailable_total",
			Help: "image.getInfinite 503s written here for a failed feed-service call (outcome feed_unavailable), by the fallback they replace: reason feed-unavailable (the call failed; detail is the error's class: deadline, timeout, conn_refused, conn_reset, dns, net_*, eof, json, other, ...) or feed-status (the feed answered a 5xx; detail is the status). A value outside those sets is other.",
		}, []string{EndpointLabel, "reason", "detail"}),
		FeedRetry: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_feed_retry_total",
			Help: "image.getInfinite feed-service calls that failed as the app's 503 with FEED_GO_INFINITE_ANSWER_FEED_UNAVAILABLE on, by what became of the one retry: recovered (the second call answered 200), failed (it failed again: the 503), other (another answer, handled as before), handed_back (too little of the request budget left for a whole call: handed back, the app's call is the retry).",
		}, []string{EndpointLabel, "outcome"}),
		FallbackProxyErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "feed_go_fallback_proxy_errors_total",
			Help: "Fallback requests the proxy answered 502 because the Node app failed before a response started, by reason (upstream: unreachable or connection broken; canceled: the client left first). A failure mid-body aborts the response (http.ErrAbortHandler) and is not counted.",
		}, []string{"reason"}),
	}
	serveInFlight := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "feed_go_serve_in_flight",
		Help: "Public requests computing now, by the route holding the serve slot; the slots are shared by every public route, and at FEED_GO_MAX_IN_FLIGHT the next one is not computed but proxied to the Node app (feed_go_fallback_total{reason=\"bulkhead\"}).",
	}, []string{EndpointLabel})
	// A pod that never shed reads 0 rather than an absent series, on each served endpoint.
	m.ServeInFlight = map[string]prometheus.Gauge{}
	for _, e := range ServedEndpoints {
		m.ServeInFlight[e] = serveInFlight.WithLabelValues(e)
		m.Fallbacks.WithLabelValues(e, "serve", "bulkhead")
	}
	// One family per comparison, with `source` (SourceLabel) last so the curried vectors keep the
	// label order every caller uses.
	shadowResults := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "feed_go_shadow_compare_total",
		Help: "Body comparisons by result (match, match_empty, match_cached, fields, order, membership, unsupported, deadline, go_error, bad_request) and source (shadow: a Node sample; serve-parity: a served answer re-asked of the Node app).",
	}, []string{EndpointLabel, "result", SourceLabel})
	shadowDiffs := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "feed_go_shadow_field_diffs_total",
		Help: "Differing paths found by the body and header comparisons, by path category, kind and source (shadow | serve-parity).",
	}, []string{EndpointLabel, "category", "kind", SourceLabel})
	shadowResponse := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "feed_go_shadow_response_total",
		Help: "Comparisons of the compared response headers (shadow.ComparedHeaders), by result: match, mismatch (the diffs are in feed_go_shadow_field_diffs_total as header:<name>), uncompared (a REST endpoint, whose port writes no headers yet, or a sample that carried none); and source (shadow | serve-parity). Separate from feed_go_shadow_compare_total, which is the body's.",
	}, []string{EndpointLabel, "result", SourceLabel})
	m.ShadowResults = shadowResults.MustCurryWith(prometheus.Labels{SourceLabel: SourceShadow})
	m.ShadowDiffs = shadowDiffs.MustCurryWith(prometheus.Labels{SourceLabel: SourceShadow})
	m.ShadowResponse = shadowResponse.MustCurryWith(prometheus.Labels{SourceLabel: SourceShadow})
	m.ParityResults = shadowResults.MustCurryWith(prometheus.Labels{SourceLabel: SourceServeParity})
	m.ParityDiffs = shadowDiffs.MustCurryWith(prometheus.Labels{SourceLabel: SourceServeParity})
	m.ParityResponse = shadowResponse.MustCurryWith(prometheus.Labels{SourceLabel: SourceServeParity})
	m.seedOutcomes()
	m.seedServeParity()
	m.seedEvalCapture()
	for _, e := range []string{EndpointAsPosts, EndpointModelGetAll, EndpointInfinite} {
		for _, r := range []string{DevalueWriteDevalue, DevalueWriteFallback, DevalueWriteSuperjson} {
			m.DevalueWrites.WithLabelValues(e, r)
		}
	}
	// Seed the dropped counter per endpoint, and the panic and refresh counters, so "none" reads 0
	// rather than an absent series (the shadow results: seedOutcomes).
	for _, e := range Endpoints {
		m.ShadowDropped.WithLabelValues(e)
		for _, r := range []string{"match", "mismatch", "uncompared"} {
			m.ShadowResponse.WithLabelValues(e, r)
		}
	}
	for _, e := range ProbeEndpoints {
		for _, r := range []string{ProbeWouldServe, ProbeWouldMiss, ProbeRaced, ProbeUnsupported, ProbeError} {
			for _, v := range GoFirstViewers(e) {
				m.GoFirst.WithLabelValues(e, r, v)
			}
		}
		for _, c := range probeCaches() {
			m.GoFirstMiss.WithLabelValues(e, c)
			m.GoFirstRaced.WithLabelValues(e, c)
		}
		m.GoFirstPages.WithLabelValues(e)
		m.GoFirstDropped.WithLabelValues(e)
	}
	for _, w := range []string{"serve", "shadow", "probe", "serve-parity", "eval-capture"} {
		m.Panics.WithLabelValues(w)
	}
	for _, r := range []string{"ok", "error"} {
		m.JWKSRefresh.WithLabelValues(r)
	}
	for _, r := range []string{"upstream", "canceled"} {
		m.FallbackProxyErrors.WithLabelValues(r)
	}
	for _, v := range []string{auth.VerdictDenyCached, auth.VerdictAllowUnknown} {
		m.RevocationDegraded.WithLabelValues(v)
	}
	for _, c := range hydrate.MissCaches {
		for _, r := range []string{"computed", "error"} {
			m.CacheMisses.WithLabelValues(c, r)
		}
	}
	for _, v := range modelfeed.ViewerClasses {
		m.ShadowViewer.WithLabelValues(EndpointAssociated, v, "match")
	}
	for _, e := range FeedViewerEndpoints {
		for _, v := range FeedViewerClasses {
			m.ShadowViewer.WithLabelValues(e, v, "match")
			for _, r := range []string{"match", "mismatch"} {
				m.ShadowResponseViewer.WithLabelValues(e, v, r)
			}
		}
	}
	for _, v := range V1ImagesViewerClasses {
		m.ShadowViewer.WithLabelValues(EndpointV1Images, v, "match")
		for _, r := range []string{"match", "mismatch"} {
			m.ShadowResponseViewer.WithLabelValues(EndpointV1Images, v, r)
		}
	}
	reg.MustRegister(m.ShadowViewer, m.ShadowResponseViewer)
	reg.MustRegister(m.Requests, m.Fallbacks, m.Duration, shadowResults, shadowDiffs, shadowResponse, m.ShadowDropped, m.ServeParity, m.EvalCapture, m.EvalCaptureUnresolved, m.EvalCaptureRowsDropped,
		m.ShadowPhase, m.ShadowPhaseCPU, m.ShadowPhaseSolo, m.ShadowPhaseSoloWall,
		m.GoFirst, m.GoFirstMiss, m.GoFirstDropped, m.GoFirstRaced, m.GoFirstDBReads, m.GoFirstPages, m.GoFirstCheckLag,
		m.Panics, m.RevocationDegraded, m.JWKSRefresh, m.JWKSStale, m.FallbackProxyErrors, m.CacheMisses, m.CacheWrites, m.Errors, serveInFlight, m.SearchRejected,
		m.SessionCookieSlot, m.DevalueWrites, m.FeedUnavailable, m.FeedRetry, m.ShadowServable)
	for _, o := range feed.RetryOutcomes {
		m.FeedRetry.WithLabelValues(EndpointInfinite, o)
	}
	for _, s := range []string{"host", "shared"} {
		m.SessionCookieSlot.WithLabelValues(s)
	}
	for _, why := range []string{v1models.SearchRejectedOpen, v1models.SearchRejectedBusy} {
		m.SearchRejected.WithLabelValues(why)
	}
	for _, r := range slices.Concat([]string{SearchServable}, SearchServeOnlyReasons, searchServableComputeReasons) {
		m.ShadowServable.WithLabelValues(EndpointSearch, r)
	}
	return m
}

// ShadowResultValues are the `result` values of feed_go_shadow_compare_total: the classifiers' match,
// fields, order and membership, the trivial and cached matches, and the compare path's own outcomes.
var ShadowResultValues = []string{"match", "match_empty", "match_cached", "fields", "order", "membership", "unsupported", "deadline", "go_error", "bad_request"}

// RequestOutcomes are the `outcome` values of feed_go_requests_total. region_blocked
// (OutcomeRegionBlocked) is the app's 451 written here for a blocked region: neither a served answer
// nor a fallback, so the served-traffic and fallback-rate figures keep their meaning. feed_unavailable
// (OutcomeFeedUnavailable) is, the same way, the app's 503 written here on image.getInfinite for a
// failed feed-service call. not_found (OutcomeNotFound) is, the same way, Node's 404 written here on
// GET /api/v1/models/{id} for a model the statement finds no row for.
var RequestOutcomes = []string{"served", "served_empty", "served_cached", "fallback", "error", OutcomeRegionBlocked, OutcomeFeedUnavailable, OutcomeNotFound}

// computeFallbackReasons are the fallback reasons every compute can end in, whatever its endpoint
// (Server.within: a panic, a gone client, the budget), so feed_go_fallback_total is seeded with them
// for each mode that computes. Serving, the request-determined reasons are seeded too
// (RequestFallbackReasons); every other reason is endpoint-specific and stays lazy.
var computeFallbackReasons = []string{"deadline", "canceled", "panic"}

// RequestFallbackReasons is, per public route, every fallback reason the request alone decides (its
// method, region, user agent, headers, credential form, path, query or input, never a store's state
// or this process's config) that the route's serve path can reach: the series seedOutcomes creates at
// 0 for mode serve. A comparison of fallback rates between a new process and an old one subtracts
// these reasons, as they measure the traffic rather than the port; a reason series born inside the
// window would lose its first event to increase() and bias that comparison against the new process.
//
// Each list holds only the reasons that route's code can produce: the input-<key> and
// v1-models-<key> reasons are the parsers' own key lists, so a key added there is seeded here.
// `bearer-token` is seeded on the REST routes only: on the tRPC routes it means the API keys are not
// configured.
func RequestFallbackReasons() map[string][]string {
	// Every public route: the API request policy (apiRequestPolicy) and a method other than GET.
	policy := []string{"method", "region-blocked", "crawler-user-agent"}
	// The tRPC routes resolve a bearer credential (auth.bearerToken, resolveBearer).
	bearer := []string{"bearer-malformed", "bearer-multiple-headers", "bearer-query-token"}
	// The images input (feed.parseInput), on both image procedures.
	imagesInput := []string{
		"input-envelope", "input-invalid", "input-unknown-key", "input-sort", "input-include",
		"input-cursor", "input-tools", "input-techniques",
	}
	// Both REST model routes: preflight's credential check, the conditional request, the host.
	v1 := []string{"bearer-token", "v1-models-conditional", "v1-models-host"}

	asPosts := sortedUnion(policy, bearer, imagesInput, []string{"verified-bot", "input-include-no-cosmetics"},
		prefixed("input-", feed.UnsupportedInputKeys()))
	infinite := sortedUnion(policy, bearer, imagesInput, []string{
		"input-collectionTagId", "ids-not-int4", "collection-id", "collection-tag-id",
		"infinite-user-zero", "prioritized-cursor", "collection-random-cursor", "collection-random-post-id",
	}, prefixed("input-", feed.InfiniteUnsupportedInputKeys()))
	modelGetAll := sortedUnion(policy, bearer, []string{
		"verified-bot", "input-envelope", "input-invalid", "input-unknown-key", "input-ids",
		"model-cursor", "model-sort-recently-added", "model-collection-id", "model-ids", "input-hidePaid",
		"input-published-range",
	}, prefixed("input-", modelfeed.UnsupportedInputKeys()))
	v1Models := sortedUnion(policy, v1, []string{
		"v1-models-session-cookie", "v1-models-etag", "v1-models-query-encoding", "v1-models-authed-only",
		"v1-models-query", "v1-models-limit", "v1-models-input-number", "v1-models-sort",
		"v1-models-input-enum", "v1-models-input-duplicate", "v1-models-input-bool", "v1-models-ids",
		"v1-models-page-limit", "v1-models-cursor",
	}, prefixed("v1-models-", v1models.UnportedFallbackKeys()))
	v1ModelsID := sortedUnion(policy, v1, []string{"v1-models-origin", "v1-models-path", "v1-models-id"})
	// The REST images route: preflight's credential check, its serve-only checks, and feed.ParseV1 /
	// feed.ServeV1's request-determined reasons (the query, the shapes not ported, nextPage's host, the
	// paging guard, the cursors). Not `v1-path`: the route's pattern is the images path itself.
	v1Images := sortedUnion(policy, []string{
		"bearer-token", "v1-images-conditional", "v1-images-session-cookie", "input-unknown-key",
		"v1-host", "v1-query-encoding", "v1-input-duplicate", "v1-input-number",
		"v1-input-username", "v1-input-period", "v1-input-type", "v1-input-ids", "v1-input-bool",
		"v1-image-id", "v1-tags", "v1-base-models", "v1-user-zero", "v1-model-only", "v1-sort",
		"v1-with-tags", "v1-cursor", "v1-legacy-cursor", "v1-page-limit",
	})
	// The site-search route (sitesearch.go): its region block (no user-agent check: the path is not
	// bot-aware), the method, the credential form, the path, the etag query, the body, the indexes, the
	// address the rate limit keys on, and the profanity refusal civitai.com applies to any text.
	search := sortedUnion([]string{
		"method", "region-blocked", "bearer-token", "search-path", "search-etag", "search-content-type",
		"search-body-size", "search-input", "search-input-invalid", "search-input-duplicate",
		"input-unknown-key", "search-index", "search-rate-limit-ip", "search-profanity",
	})
	return map[string][]string{
		EndpointAsPosts:     asPosts,
		EndpointInfinite:    infinite,
		EndpointModelGetAll: modelGetAll,
		EndpointV1Models:    v1Models,
		EndpointV1ModelsID:  v1ModelsID,
		EndpointV1Images:    v1Images,
		EndpointSearch:      search,
	}
}

// sortedUnion joins lists into one sorted list without duplicates.
func sortedUnion(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

func prefixed(prefix string, keys []string) []string {
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = prefix + k
	}
	return out
}

// cachedEndpoint reports whether endpoint can answer from the origin response cache (served_cached,
// match_cached): the single-model route only (v1models.Answer.Cached).
func cachedEndpoint(e string) bool { return e == EndpointV1ModelsID }

// emptyReachable reports whether endpoint can count a trivial answer (served_empty, match_empty) in
// mode: never on as-posts or site-search, whose computes do not mark one, and on the single-model route
// only in the shadow, as its trivial answer is the not-found body, which the public route answers as
// not_found (OutcomeNotFound) or falls back on, never as served_empty.
func emptyReachable(endpoint, mode string) bool {
	return endpoint != EndpointAsPosts && endpoint != EndpointSearch && (endpoint != EndpointV1ModelsID || mode == "shadow")
}

// outcomeReachable reports whether the mode's path can count outcome for endpoint.
func outcomeReachable(endpoint, mode, outcome string) bool {
	switch outcome {
	case "served_cached":
		return cachedEndpoint(endpoint)
	case "served_empty":
		return emptyReachable(endpoint, mode)
	case OutcomeRegionBlocked:
		// site-search always hands a blocked region back (ServeSearchHTTP).
		return mode == "serve" && endpoint != EndpointSearch
	case OutcomeFeedUnavailable:
		return mode == "serve" && endpoint == EndpointInfinite
	case OutcomeNotFound:
		return mode == "serve" && endpoint == EndpointV1ModelsID
	}
	return true
}

// shadowResultReachable reports whether the compare path can count result for endpoint: match_cached
// needs a cached answer, match_empty a trivial one, and the single-model route's classifier
// (ClassifyV1ModelID) has no order, nor has site-search's (ClassifySearch).
func shadowResultReachable(endpoint, result string) bool {
	switch result {
	case "match_cached":
		return cachedEndpoint(endpoint)
	case "match_empty":
		return emptyReachable(endpoint, "shadow")
	case "order":
		return endpoint != EndpointV1ModelsID && endpoint != EndpointSearch
	}
	return true
}

// seedOutcomes creates, at 0, every request outcome, shadow result and generic fallback series the
// serve, shadow and probe paths can reach, and serving the request-determined fallback reasons
// (RequestFallbackReasons), so a new pod's first event is an increase from 0 that
// rate() over its lifetime counts, rather than the creation of a series at 1 that it does not. The
// label values are the closed sets above crossed with the endpoints each path serves; the series are
// the ones those paths create on their own, never more.
func (m *Metrics) seedOutcomes() {
	for _, e := range ServedEndpoints {
		for _, o := range RequestOutcomes {
			if outcomeReachable(e, "serve", o) {
				m.Requests.WithLabelValues(e, "serve", o)
			}
		}
		// An error that is no fallback is counted with reason `error` (serveFallback).
		m.Fallbacks.WithLabelValues(e, "serve", "error")
		for _, r := range computeFallbackReasons {
			m.Fallbacks.WithLabelValues(e, "serve", r)
		}
	}
	for e, reasons := range RequestFallbackReasons() {
		for _, r := range reasons {
			m.Fallbacks.WithLabelValues(e, "serve", r)
		}
	}
	for _, e := range Endpoints {
		for _, o := range RequestOutcomes {
			if outcomeReachable(e, "shadow", o) {
				m.Requests.WithLabelValues(e, "shadow", o)
			}
		}
		for _, r := range ShadowResultValues {
			if shadowResultReachable(e, r) {
				m.ShadowResults.WithLabelValues(e, r)
			}
		}
		for _, r := range computeFallbackReasons {
			m.Fallbacks.WithLabelValues(e, "shadow", r)
		}
	}
	for _, e := range ProbeEndpoints {
		for _, r := range computeFallbackReasons {
			m.Fallbacks.WithLabelValues(e, "probe", r)
		}
	}
}

// ServedEndpoints are the endpoints with a public route (each takes its serve slot from the one
// shared pool): the three tRPC procedures, the two REST model routes, the REST images route and site
// search.
var ServedEndpoints = []string{EndpointAsPosts, EndpointModelGetAll, EndpointInfinite, EndpointV1Models, EndpointV1ModelsID, EndpointV1Images, EndpointSearch}

// ErrorModes are the `mode` values of feed_go_errors_total: a compute error on the public route, in a
// shadow sample or in a Go-first probe, and a fallback-proxy error.
var ErrorModes = []string{"serve", "shadow", "probe", "proxy"}

// EndpointUnknown is feed_go_errors_total's feed_endpoint for an error under no known endpoint (a
// proxied path no public route names).
const EndpointUnknown = "unknown"

// ObserveError counts err on feed_go_errors_total by its fallback.Class. A nil err is not counted, a
// mode outside ErrorModes is dropped and an endpoint outside Endpoints is EndpointUnknown, so every
// label comes from a closed set.
func (m *Metrics) ObserveError(endpoint, mode string, err error) {
	if err == nil || !slices.Contains(ErrorModes, mode) {
		return
	}
	if !slices.Contains(Endpoints, endpoint) {
		endpoint = EndpointUnknown
	}
	m.Errors.WithLabelValues(endpoint, mode, fallback.Class(err)).Inc()
}
