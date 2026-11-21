// Package metrics is the service's Prometheus series. Every label has a fixed value set. No label
// is named `endpoint`: a scrape target label of that name overwrites a series' own (see
// apps/beacon-go/DESIGN.md).
package metrics

import (
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// EventTypes are the `type` values of app_index_events_applied_total. `invalid` is an upsert
// whose body this index cannot use, applied as a delete.
var EventTypes = []string{"upsert", "delete", "live", "progress", "end", "invalid"}

// ReconnectReasons are the `reason` values of app_index_reconnects_total.
// `token` is a token that could not be fetched (no subscription was opened).
var ReconnectReasons = []string{"unavailable", "slow_consumer", "end", "bad_request", "auth", "store", "cursor_expired", "token"}

// RebuildReasons are the `reason` values of app_index_rebuilds_total.
var RebuildReasons = []string{"first_start", "cursor_expired", "layout", "empty_cursor"}

// MalformedTypes are the `type` values of app_index_malformed_events_total: the type an event that
// could not be decoded was sent as.
var MalformedTypes = []string{"upsert", "delete", "live", "progress"}

// TokenFetchOutcomes are the `outcome` values of app_index_token_fetches_total.
var TokenFetchOutcomes = []string{"ok", "error"}

// SearchOutcomes are the `outcome` values of app_index_search_requests_total.
var SearchOutcomes = []string{"ok", "bad_request", "not_ready", "error"}

// ListingReconnectReasons are the `reason` values of app_index_listings_reconnects_total: the
// app stream's, and `empty_snapshot`, a snapshot that ended with no listing, held and taken again.
var ListingReconnectReasons = append(append([]string{}, ReconnectReasons...), "empty_snapshot")

// Stream is the series of one followed stream: the app index's are `app_index_*`, the listings
// read model's `app_index_listings_*`.
type Stream struct {
	Applied    *prometheus.CounterVec
	Malformed  *prometheus.CounterVec
	Generation prometheus.Gauge
	Ready      prometheus.Gauge
	Reconnects *prometheus.CounterVec
	Rebuilds   *prometheus.CounterVec
	// EmptySnapshots counts snapshots that ended with no entity and were held: the serving
	// generation was kept and the snapshot taken again later. Nil for the app stream, which has no
	// such hold.
	EmptySnapshots prometheus.Counter

	lastEvent atomic.Int64 // unix nanos of the last applied event; 0 = none yet
	now       func() time.Time
}

// Metrics holds the app index's series: its stream's and the search and token series.
type Metrics struct {
	*Stream
	Searches   *prometheus.CounterVec
	SearchTime prometheus.Histogram
	// TokenFetches counts calls to the token endpoint (only with client credentials configured).
	TokenFetches *prometheus.CounterVec
}

// newStream is one stream's series, named prefix + "_*", and the collectors the caller registers.
// what names the stream's store in the help text.
func newStream(prefix, what string, reconnectReasons []string) (*Stream, []prometheus.Collector) {
	s := &Stream{
		Applied: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: prefix + "_events_applied_total",
			Help: "Registry events applied to " + what + ", by event type (invalid: an upsert whose body the index cannot use, applied as a delete).",
		}, []string{"type"}),
		Malformed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: prefix + "_malformed_events_total",
			Help: "Registry events of a known type that could not be decoded (no usable urn, unreadable data), by the type they were sent as. Skipped; the cursor advances past one only when it carried a readable cursor.",
		}, []string{"type"}),
		Generation: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: prefix + "_generation",
			Help: "The serving generation of " + what + " (0: none yet). It changes when a rebuild switches over.",
		}),
		Ready: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: prefix + "_ready",
			Help: "1 once a generation is serving (the first Live), else 0.",
		}),
		Reconnects: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: prefix + "_reconnects_total",
			Help: "Subscriptions that ended and were opened again, by why they ended.",
		}, []string{"reason"}),
		Rebuilds: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: prefix + "_rebuilds_total",
			Help: "Generations started from an empty cursor, by why.",
		}, []string{"reason"}),
		now: time.Now,
	}
	age := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: prefix + "_last_event_age_seconds",
		Help: "Seconds since the last registry event was applied (-1: none yet). A live stream may be quiet for any length of time; read with " + prefix + "_reconnects_total.",
	}, func() float64 {
		last := s.lastEvent.Load()
		if last == 0 {
			return -1
		}
		return s.now().Sub(time.Unix(0, last)).Seconds()
	})
	// Seed every label value, so a count that never moved reads 0 rather than an absent series.
	for _, v := range EventTypes {
		s.Applied.WithLabelValues(v)
	}
	for _, v := range MalformedTypes {
		s.Malformed.WithLabelValues(v)
	}
	for _, v := range reconnectReasons {
		s.Reconnects.WithLabelValues(v)
	}
	for _, v := range RebuildReasons {
		s.Rebuilds.WithLabelValues(v)
	}
	return s, []prometheus.Collector{s.Applied, s.Malformed, s.Generation, s.Ready, s.Reconnects, s.Rebuilds, age}
}

// New registers the app index's series on reg.
func New(reg prometheus.Registerer) *Metrics {
	s, cs := newStream("app_index", "the index", ReconnectReasons)
	m := &Metrics{
		Stream: s,
		Searches: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_search_requests_total",
			Help: "GET /search requests, by outcome.",
		}, []string{"outcome"}),
		TokenFetches: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_token_fetches_total",
			Help: "Calls to the token endpoint for the index's own client-credentials token, by outcome: one at start, one before each expiry, one after each invalid_token. Zero when no client is configured.",
		}, []string{"outcome"}),
		SearchTime: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "app_index_search_duration_seconds",
			Help:    "GET /search latency.",
			Buckets: []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
		}),
	}
	reg.MustRegister(append(cs, m.Searches, m.SearchTime, m.TokenFetches)...)
	for _, v := range SearchOutcomes {
		m.Searches.WithLabelValues(v)
	}
	for _, v := range TokenFetchOutcomes {
		m.TokenFetches.WithLabelValues(v)
	}
	return m
}

// NewListings registers the listings read model's stream series on reg (app_index_listings_*).
// Called only when APP_INDEX_LISTINGS is on, so the series do not exist while it is off.
func NewListings(reg prometheus.Registerer) *Stream {
	s, cs := newStream("app_index_listings", "the listings read model", ListingReconnectReasons)
	s.EmptySnapshots = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "app_index_listings_empty_snapshots_total",
		Help: "Listing snapshots that ended with no listing and were held: the serving generation was kept and the snapshot is taken again after the longest backoff.",
	})
	reg.MustRegister(append(cs, s.EmptySnapshots)...)
	return s
}

// TokenFetched counts one call to the token endpoint (token.Source.OnFetch).
func (m *Metrics) TokenFetched(err error) {
	if err != nil {
		m.TokenFetches.WithLabelValues("error").Inc()
		return
	}
	m.TokenFetches.WithLabelValues("ok").Inc()
}

// EventApplied counts one applied event and stamps the last-event time.
func (m *Stream) EventApplied(typ string) {
	m.Applied.WithLabelValues(typ).Inc()
	m.lastEvent.Store(m.now().UnixNano())
}
