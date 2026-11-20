// Package metrics is the service's Prometheus series. Every label has a fixed value set; no label
// ever holds a token, a user, an app or a collection (unbounded, and a user names a person: the auth
// extension's Telemetry section).
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Sources are the `source` values of app_data_reads_total: where a read's answer came from.
// `none` is a read refused before either was asked (bad request, no token, overloaded).
var Sources = []string{"registry", "rest", "none"}

// FallbackReasons are the `reason` values of app_data_fallbacks_total: why a read went to REST.
// `empty` is a stream that holds nothing, which the origin also answers a token it refuses.
var FallbackReasons = []string{
	"registry_off", "token_not_exchangeable", "empty", "capacity", "token_capacity", "not_live", "stalled",
	"cooling_down", "invalid_token", "too_large", "ended", "failed", "closed",
}

// CloseReasons are the `reason` values of app_data_streams_closed_total (session.Close*).
var CloseReasons = []string{"idle", "age", "invalid_token", "too_large", "end", "malformed", "error", "shutdown"}

// Outcomes are the `outcome` values of app_data_reads_total.
var Outcomes = []string{"ok", "refused", "bad_request", "unauthenticated", "busy", "error"}

// Metrics holds the series.
type Metrics struct {
	Reads         *prometheus.CounterVec
	Fallbacks     *prometheus.CounterVec
	StreamsOpened prometheus.Counter
	StreamsClosed *prometheus.CounterVec
	ReadTime      *prometheus.HistogramVec
}

// Stats is what the session manager holds now (session.Stats), read at scrape time.
type Stats func() (streams, live, records, bytes int)

// New registers the series on reg.
func New(reg prometheus.Registerer, stats Stats) *Metrics {
	m := &Metrics{
		Reads: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_data_reads_total",
			Help: "Reads answered, by where the answer came from and its outcome (refused: the site refused the token or the collection).",
		}, []string{"source", "outcome"}),
		Fallbacks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_data_fallbacks_total",
			Help: "Reads that went to the REST document store instead of a registry stream, by why.",
		}, []string{"reason"}),
		StreamsOpened: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "app_data_streams_opened_total",
			Help: "Per-user registry streams opened.",
		}),
		StreamsClosed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_data_streams_closed_total",
			Help: "Per-user registry streams closed, by why.",
		}, []string{"reason"}),
		ReadTime: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "app_data_read_duration_seconds",
			Help:    "Time to answer a read, by where the answer came from.",
			Buckets: []float64{.001, .005, .01, .05, .1, .25, .5, 1, 2, 4, 8},
		}, []string{"source"}),
	}
	gauge := func(name, help string, pick func(s, l, r, b int) int) prometheus.Collector {
		return prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, func() float64 {
			return float64(pick(stats()))
		})
	}
	reg.MustRegister(m.Reads, m.Fallbacks, m.StreamsOpened, m.StreamsClosed, m.ReadTime,
		gauge("app_data_streams_open", "Per-user registry streams open now (each counts against the origin's subscription caps).",
			func(s, _, _, _ int) int { return s }),
		gauge("app_data_streams_live", "Open streams that have sent Live, so reads are answered from them.",
			func(_, l, _, _ int) int { return l }),
		gauge("app_data_cached_records", "Records held in every stream's cache.",
			func(_, _, r, _ int) int { return r }),
		gauge("app_data_cached_bytes", "Approximate bytes held in every stream's cache.",
			func(_, _, _, b int) int { return b }),
	)
	// Every labelled series exists from the start, at zero, so a rate over it is never absent.
	for _, s := range Sources {
		m.ReadTime.WithLabelValues(s)
		for _, o := range Outcomes {
			m.Reads.WithLabelValues(s, o)
		}
	}
	for _, r := range FallbackReasons {
		m.Fallbacks.WithLabelValues(r)
	}
	for _, r := range CloseReasons {
		m.StreamsClosed.WithLabelValues(r)
	}
	return m
}
