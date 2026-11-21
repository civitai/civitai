// Package metrics is the service's Prometheus series. Every label has a fixed value set; no label
// ever holds a token, a user, an app or a collection (unbounded, and a user names a person: the auth
// extension's Telemetry section).
package metrics

import (
	"log/slog"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
)

// Sources are the `source` values of app_data_reads_total: where a read's answer came from.
// `none` is a read refused before either was asked (bad request, no token, overloaded).
var Sources = []string{"registry", "rest", "none"}

// FallbackReasons are the `reason` values of app_data_fallbacks_total: why a read went to REST.
// `empty` is a stream that holds nothing, which the origin also answers a token it refuses.
var FallbackReasons = []string{
	"registry_off", "token_not_exchangeable", "empty", "capacity", "token_capacity", "not_live", "stalled",
	"cooling_down", "invalid_token", "exchange_refused", "not_private", "too_large", "ended", "failed", "closed",
	"block_spent", "block_cache_full",
}

// CloseReasons are the `reason` values of app_data_streams_closed_total (session.Close*).
var CloseReasons = []string{"idle", "age", "expiry", "invalid_token", "exchange_refused", "not_private", "revoked", "too_large", "end", "malformed", "error", "shutdown", "block_spent", "block_cache_full"}

// Outcomes are the `outcome` values of app_data_reads_total.
var Outcomes = []string{"ok", "refused", "bad_request", "unauthenticated", "busy", "error"}

// BlockOutcomes are the `outcome` values of app_data_block_exchanges_total (exchange.Block*). Only
// `refused` and `remembered` carry a refusal code in `error` (exchange.RefusalCodes); the rest `none`.
var BlockOutcomes = []string{
	exchange.BlockIssued, exchange.BlockReused, exchange.BlockRefused, exchange.BlockRemembered,
	exchange.BlockFailed, exchange.BlockSpent, exchange.BlockFull,
}

// Metrics holds the series.
type Metrics struct {
	Reads         *prometheus.CounterVec
	Fallbacks     *prometheus.CounterVec
	StreamsOpened prometheus.Counter
	StreamsClosed *prometheus.CounterVec
	ReadTime      *prometheus.HistogramVec
	// BlockExchanges counts App Block token exchanges by outcome and refusal code; zero while the block
	// exchange is off.
	BlockExchanges *prometheus.CounterVec
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
		BlockExchanges: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_data_block_exchanges_total",
			Help: "App Block token exchanges at the hub, by outcome (issued, reused, refused, remembered, failed, spent, full) and the hub's refusal code.",
		}, []string{"outcome", "error"}),
	}
	gauge := func(name, help string, pick func(s, l, r, b int) int) prometheus.Collector {
		return prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, func() float64 {
			return float64(pick(stats()))
		})
	}
	reg.MustRegister(m.Reads, m.Fallbacks, m.StreamsOpened, m.StreamsClosed, m.ReadTime, m.BlockExchanges,
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
	for _, o := range BlockOutcomes {
		if o != exchange.BlockRefused && o != exchange.BlockRemembered {
			m.BlockExchanges.WithLabelValues(o, "none")
			continue
		}
		for _, c := range exchange.RefusalCodes {
			m.BlockExchanges.WithLabelValues(o, c)
		}
	}
	return m
}

// ObserveBlockExchange is the exchange.BlockCache observer: it counts each outcome and logs every one
// that sends the read to REST, with the hub's refusal code. Neither carries a token, user or app.
func (m *Metrics) ObserveBlockExchange(log *slog.Logger) func(outcome, code string) {
	return func(outcome, code string) {
		m.BlockExchanges.WithLabelValues(outcome, code).Inc()
		if log == nil || outcome == exchange.BlockIssued || outcome == exchange.BlockReused {
			return
		}
		log.Info("block token not exchanged; the read goes to REST", "outcome", outcome, "error", code)
	}
}
