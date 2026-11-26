package server

import (
	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/shadow"
	"github.com/civitai/civitai/apps/beacon-go/internal/tracker"
)

// EndpointLabel names the endpoint label. Not `endpoint`: that is a reserved scrape target label (set
// to the scrape port's name), which overwrites a series' own `endpoint` and moves ours to
// `exported_endpoint` — the same reason feed-go's series use `feed_endpoint`.
const EndpointLabel = "beacon_endpoint"

// Endpoints are the label values: one per beacon.
var Endpoints = []string{beacon.EndpointPing, beacon.EndpointPulse}

// Metrics are the beacon_go_* series. Every label takes values from a fixed set.
type Metrics struct {
	// Requests counts served-path requests by outcome: served | fallback | error.
	Requests *prometheus.CounterVec
	// Fallbacks counts fallbacks (served and shadow) by reason (internal/fallback reasons).
	Fallbacks *prometheus.CounterVec
	// ShadowCompare counts shadow comparisons by result (shadow.Results).
	ShadowCompare *prometheus.CounterVec
	// ShadowDiffs counts, per mismatching sample, each field that differed (shadow.Verdict.Diffs,
	// folded onto a fixed set by DiffField).
	ShadowDiffs *prometheus.CounterVec
	// TrackerWrites counts rows sent to the tracker by table and result (tracker.Results).
	TrackerWrites *prometheus.CounterVec
	// TrackerSendSeconds is, per sent row, the time from a worker taking it to its result (every
	// attempt and the waits between them), by table. It is what the worker pool is sized against.
	TrackerSendSeconds *prometheus.HistogramVec
	// Panics counts recovered panics by where they happened: serve | shadow.
	Panics               *prometheus.CounterVec
	RevocationReadErrors prometheus.Counter
	JWKSRefresh          *prometheus.CounterVec
	JWKSStale            prometheus.Counter
	// SessionCookieSlot counts resolved sessions by the cookie slot they were read from (auth.CookieSlot).
	SessionCookieSlot *prometheus.CounterVec
}

// NewMetrics registers the series on reg and seeds every fixed label combination at 0, so "none"
// reads as 0 rather than as an absent series.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_requests_total",
			Help: "Beacon requests on the public listener, by endpoint and outcome (served | fallback | error).",
		}, []string{EndpointLabel, "outcome"}),
		Fallbacks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_fallback_total",
			Help: "Requests this service would not answer itself (served: proxied to the Node app; shadow: counted), by endpoint, path (serve | shadow) and reason.",
		}, []string{EndpointLabel, "path", "reason"}),
		ShadowCompare: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_shadow_compare_total",
			Help: "Shadow samples by endpoint and result: match, mismatch_{status,headers,body,writes} (response and tracker write payloads compared byte for byte), fallback, invalid, error, dropped.",
		}, []string{EndpointLabel, "result"}),
		ShadowDiffs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_shadow_diffs_total",
			Help: "Fields that differed in mismatching shadow samples, by endpoint and field.",
		}, []string{EndpointLabel, "field"}),
		TrackerWrites: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_tracker_writes_total",
			Help: "Rows sent to the ClickHouse tracker (serve mode only), by table and result (ok | rejected | failed | dropped).",
		}, []string{"table", "result"}),
		TrackerSendSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "beacon_go_tracker_send_seconds",
			Help:    "Per row sent to the ClickHouse tracker (serve mode only): seconds from a worker taking it to its result, every attempt and retry wait included, by table.",
			Buckets: TrackerSendBuckets,
		}, []string{"table"}),
		Panics: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_panics_total",
			Help: "Recovered panics, by where (serve | shadow).",
		}, []string{"where"}),
		RevocationReadErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "beacon_go_revocation_read_errors_total",
			Help: "Revocation registry reads that failed; each such request falls back (revocation-unavailable).",
		}),
		JWKSRefresh: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_jwks_refresh_total",
			Help: "Periodic JWKS refreshes, by result (ok | error).",
		}, []string{"result"}),
		JWKSStale: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "beacon_go_jwks_stale_total",
			Help: "Times the JWKS key set was dropped for staleness (sessions verify as signed out until a fetch succeeds).",
		}),
		SessionCookieSlot: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "beacon_go_session_cookie_slot_total",
			Help: "Sessions resolved from a session cookie, by the cookie slot they were read from (host | shared).",
		}, []string{"slot"}),
	}
	reg.MustRegister(m.Requests, m.Fallbacks, m.ShadowCompare, m.ShadowDiffs, m.TrackerWrites, m.TrackerSendSeconds, m.Panics,
		m.RevocationReadErrors, m.JWKSRefresh, m.JWKSStale, m.SessionCookieSlot)
	for _, s := range []string{"host", "shared"} {
		m.SessionCookieSlot.WithLabelValues(s)
	}
	for _, e := range Endpoints {
		for _, o := range []string{"served", "fallback", "error"} {
			m.Requests.WithLabelValues(e, o)
		}
		for _, r := range shadow.Results {
			m.ShadowCompare.WithLabelValues(e, r)
		}
	}
	for _, t := range []string{beacon.TablePageViews, beacon.TableViews} {
		for _, r := range tracker.Results {
			m.TrackerWrites.WithLabelValues(t, r)
		}
		m.TrackerSendSeconds.WithLabelValues(t)
	}
	for _, w := range []string{"serve", "shadow"} {
		m.Panics.WithLabelValues(w)
	}
	for _, r := range []string{"ok", "error"} {
		m.JWKSRefresh.WithLabelValues(r)
	}
	return m
}

// TrackerSendBuckets span one fast POST (milliseconds) to three attempts that each hit the per-attempt
// timeout (tracker.AttemptTimeout) plus the retry waits.
var TrackerSendBuckets = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 35}

// TrackerQueueDepth is the beacon_go_tracker_queue_depth gauge (serve mode only): the rows waiting in
// the tracker queue, read from depth at each scrape.
func TrackerQueueDepth(depth func() int) prometheus.GaugeFunc {
	return prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "beacon_go_tracker_queue_depth",
		Help: "Rows waiting in the tracker queue (serve mode only); a full queue drops the row (beacon_go_tracker_writes_total{result=\"dropped\"}).",
	}, func() float64 { return float64(depth()) })
}

// diffFields is the fixed set a diff is counted under; anything else is `other`.
var diffFields = func() map[string]bool {
	m := map[string]bool{"status": true, "body": true, "writes:count": true}
	for _, h := range beacon.ComparedHeaders {
		m["header:"+h] = true
	}
	rows := map[string][]string{
		beacon.TablePageViews: {"userId", "memberType", "ip", "pageId", "path", "host", "country", "ads", "duration", "windowWidth", "windowHeight"},
		beacon.TableViews:     {"userId", "ip", "userAgent", "type", "entityType", "entityId", "ads", "nsfw", "details", "nsfwLevel", "browsingLevel"},
	}
	for table, keys := range rows {
		for _, k := range append(keys, "table", "order", "unparsed") {
			m["write:"+table+":"+k] = true
		}
	}
	return m
}()

// DiffField folds a Verdict diff onto the fixed label set.
func DiffField(d string) string {
	if diffFields[d] {
		return d
	}
	return "other"
}
