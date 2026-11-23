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
// `none` is a read refused before either was asked (bad request, no token, overloaded), or a
// registry-only read the registry did not answer (outcome `registry_only`).
var Sources = []string{"registry", "rest", "none"}

// FallbackReasons are the `reason` values of app_data_fallbacks_total: why a read went to REST.
// `empty` is a stream that holds nothing, which the origin also answers a token it refuses.
// `unkeyed` is a `keyPrefix` read of a stream whose records carry no key (an adapter that predates
// private keys), which cannot be filtered.
var FallbackReasons = []string{
	"registry_off", "token_not_exchangeable", "empty", "capacity", "token_capacity", "not_live", "stalled",
	"cooling_down", "invalid_token", "exchange_refused", "not_private", "too_large", "ended", "failed", "closed",
	"block_spent", "block_cache_full", "unkeyed",
}

// CloseReasons are the `reason` values of app_data_streams_closed_total (session.Close*).
var CloseReasons = []string{"idle", "age", "expiry", "invalid_token", "exchange_refused", "not_private", "revoked", "too_large", "end", "malformed", "error", "shutdown", "block_spent", "block_cache_full"}

// Outcomes are the `outcome` values of app_data_reads_total. `registry_only` is a read that asked for
// the registry's answer only (api.RegistryOnlyHeader) and that the registry could not answer: REST
// was not read, and the read is not counted in app_data_fallbacks_total.
var Outcomes = []string{"ok", "refused", "bad_request", "unauthenticated", "busy", "error", "registry_only"}

// BlockOutcomes are the `outcome` values of app_data_block_exchanges_total (exchange.Block*). Only
// `refused` and `remembered` carry a refusal code in `error` (exchange.RefusalCodes); the rest `none`.
var BlockOutcomes = []string{
	exchange.BlockIssued, exchange.BlockReused, exchange.BlockRefused, exchange.BlockRemembered,
	exchange.BlockFailed, exchange.BlockSpent, exchange.BlockFull, exchange.BlockUnverifiable,
}

// WriteOps are the `op` values of app_data_writes_total and app_data_write_forward_seconds (the
// write routes, WRITES-DESIGN.md "The API"; publish and unpublish are not served yet). A PATCH is
// named by its operator ($inc increment, $mark mark, $unmark unmark); `patch` is a PATCH refused here
// before its operator could be read (a body that is not exactly one operator).
var WriteOps = []string{"create", "put", "delete", "mark", "unmark", "increment", "info", "patch"}

// WriteOutcomes are the `outcome` values of app_data_writes_total. `2xx`, `4xx` and `501` are the
// store's answer, passed on. `refused_here` is a request this service refused before forwarding it
// (its shape, its token); `unavailable` is `503 not_forwarded` refused here (shutting down, the
// block-token key set unavailable, the request could not be built), and `signature` is `503
// not_forwarded` for the site's refusal of the forward itself (its signature check, or its internal
// route off), each safe to resend; `unknown` is a
// forward whose answer was lost (`504`, a site 5xx other than 501, a transport error, the timeout, a
// redirect).
var WriteOutcomes = []string{"2xx", "4xx", "501", "refused_here", "unknown", "unavailable", "signature"}

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
	// Writes counts the write routes' answers by op and outcome (WriteOps, WriteOutcomes); zero while
	// APP_DATA_WRITES is off.
	Writes *prometheus.CounterVec
	// WriteForward is the time of each forward to the site, by op: only requests that were sent.
	WriteForward *prometheus.HistogramVec
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
			Help: "App Block token exchanges at the hub, by outcome (issued, reused, refused, remembered, failed, spent, full, unverifiable) and the refusal code (local: refused here, never sent).",
		}, []string{"outcome", "error"}),
		Writes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "app_data_writes_total",
			Help: "Write-route answers (and info), by op and outcome (2xx, 4xx, 501: the store's; refused_here; unavailable, signature: 503 not_forwarded; unknown: 504, the outcome lost).",
		}, []string{"op", "outcome"}),
		WriteForward: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "app_data_write_forward_seconds",
			Help:    "Time of one forward to the site's internal storage route, by op.",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60},
		}, []string{"op"}),
	}
	gauge := func(name, help string, pick func(s, l, r, b int) int) prometheus.Collector {
		return prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, func() float64 {
			return float64(pick(stats()))
		})
	}
	reg.MustRegister(m.Reads, m.Fallbacks, m.StreamsOpened, m.StreamsClosed, m.ReadTime, m.BlockExchanges,
		m.Writes, m.WriteForward,
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
	for _, op := range WriteOps {
		m.WriteForward.WithLabelValues(op)
		for _, o := range WriteOutcomes {
			m.Writes.WithLabelValues(op, o)
		}
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
		// A token refused here or not checkable here is counted, not logged: a flood of made-up tokens (or a
		// JWKS outage) must not become a flood of log lines.
		if log == nil || outcome == exchange.BlockIssued || outcome == exchange.BlockReused ||
			outcome == exchange.BlockUnverifiable || code == exchange.LocalRefusalCode {
			return
		}
		log.Info("block token not exchanged; the read goes to REST", "outcome", outcome, "error", code)
	}
}
