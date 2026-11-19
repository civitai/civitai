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
var ReconnectReasons = []string{"unavailable", "slow_consumer", "end", "bad_request", "auth", "store", "cursor_expired"}

// RebuildReasons are the `reason` values of app_index_rebuilds_total.
var RebuildReasons = []string{"first_start", "cursor_expired", "layout", "empty_cursor"}

// SearchOutcomes are the `outcome` values of app_index_search_requests_total.
var SearchOutcomes = []string{"ok", "bad_request", "not_ready", "error"}

// Metrics holds the series.
type Metrics struct {
	Applied    *prometheus.CounterVec
	Generation prometheus.Gauge
	Ready      prometheus.Gauge
	Reconnects *prometheus.CounterVec
	Rebuilds   *prometheus.CounterVec
	Searches   *prometheus.CounterVec
	SearchTime prometheus.Histogram

	lastEvent atomic.Int64 // unix nanos of the last applied event; 0 = none yet
	now       func() time.Time
}

// New registers the series on reg.
func New(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Applied: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_events_applied_total",
			Help: "Registry events applied to the index, by event type (invalid: an upsert whose body the index cannot use, applied as a delete).",
		}, []string{"type"}),
		Generation: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "app_index_generation",
			Help: "The serving generation of the index (0: none yet). It changes when a rebuild switches over.",
		}),
		Ready: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "app_index_ready",
			Help: "1 once a generation is serving (the first Live), else 0.",
		}),
		Reconnects: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_reconnects_total",
			Help: "Subscriptions that ended and were opened again, by why they ended.",
		}, []string{"reason"}),
		Rebuilds: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_rebuilds_total",
			Help: "Generations started from an empty cursor, by why.",
		}, []string{"reason"}),
		Searches: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_index_search_requests_total",
			Help: "GET /search requests, by outcome.",
		}, []string{"outcome"}),
		SearchTime: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "app_index_search_duration_seconds",
			Help:    "GET /search latency.",
			Buckets: []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
		}),
		now: time.Now,
	}
	age := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "app_index_last_event_age_seconds",
		Help: "Seconds since the last registry event was applied (-1: none yet). A live stream may be quiet for any length of time; read with app_index_reconnects_total.",
	}, func() float64 {
		last := m.lastEvent.Load()
		if last == 0 {
			return -1
		}
		return m.now().Sub(time.Unix(0, last)).Seconds()
	})
	reg.MustRegister(m.Applied, m.Generation, m.Ready, m.Reconnects, m.Rebuilds, m.Searches, m.SearchTime, age)
	// Seed every label value, so a count that never moved reads 0 rather than an absent series.
	for _, v := range EventTypes {
		m.Applied.WithLabelValues(v)
	}
	for _, v := range ReconnectReasons {
		m.Reconnects.WithLabelValues(v)
	}
	for _, v := range RebuildReasons {
		m.Rebuilds.WithLabelValues(v)
	}
	for _, v := range SearchOutcomes {
		m.Searches.WithLabelValues(v)
	}
	return m
}

// EventApplied counts one applied event and stamps the last-event time.
func (m *Metrics) EventApplied(typ string) {
	m.Applied.WithLabelValues(typ).Inc()
	m.lastEvent.Store(m.now().UnixNano())
}
