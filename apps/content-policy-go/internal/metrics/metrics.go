// Package metrics is the service's Prometheus series. Every label has a fixed value set. No label
// is named `endpoint`: a scrape target label of that name overwrites a series' own (see
// apps/beacon-go/DESIGN.md).
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// Endpoints are the `context` label values a caller context is counted under: the values the ports
// manifest's metricEndpoint is checked against (scripts/ports/manifest.mjs reads this slice).
var Endpoints = []string{policy.ContextRegistrySubscription, policy.ContextSite, policy.ContextPublicAPI}

// InvalidContext is the `context` value of a request whose context is missing or unknown, so the
// label stays bounded.
const InvalidContext = "invalid"

// LookupResults are the `result` values of content_policy_user_lookups_total.
var LookupResults = []string{"cache_hit", "found", "not_found", "error", "timeout"}

// Metrics holds the series.
type Metrics struct {
	Decisions *prometheus.CounterVec
	Duration  *prometheus.HistogramVec
	Lookups   *prometheus.CounterVec
	DBErrors  prometheus.Counter
	Info      *prometheus.GaugeVec
}

// New registers the series on reg.
func New(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Decisions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "content_policy_decisions_total",
			Help: "Decisions answered, by caller context, reason and region hold. reason=error, reason=invalid-input and reason=missing-input are the SFW fallback.",
		}, []string{"context", "reason", "region_hold"}),
		Duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "content_policy_decision_duration_seconds",
			Help:    "POST /v1/decide latency, user lookup included, by caller context.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
		}, []string{"context"}),
		Lookups: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "content_policy_user_lookups_total",
			Help: "User settings lookups, by result: cache_hit, found / not_found (read from the database), error, timeout.",
		}, []string{"result"}),
		DBErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "content_policy_db_errors_total",
			Help: "User settings reads that failed or timed out; each one answered the SFW fallback (reason=error).",
		}),
		Info: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "content_policy_info",
			Help: "1, labelled with the policy version in force (the data file, the context rules and both region lists).",
		}, []string{"policy_version"}),
	}
	reg.MustRegister(m.Decisions, m.Duration, m.Lookups, m.DBErrors, m.Info)
	// Seed the fallback series and every lookup result, so a count that never moved reads 0 rather
	// than an absent series (an alert on the fallback rate needs the zero).
	for _, c := range append(append([]string(nil), Endpoints...), InvalidContext) {
		m.Decisions.WithLabelValues(c, policy.ReasonError, policy.HoldRestricted)
		m.Decisions.WithLabelValues(c, policy.ReasonInvalidInput, policy.HoldRestricted)
		m.Decisions.WithLabelValues(c, policy.ReasonMissingInput, policy.HoldRestricted)
		m.Duration.WithLabelValues(c)
	}
	for _, r := range LookupResults {
		m.Lookups.WithLabelValues(r)
	}
	return m
}

// ContextLabel is the `context` value for a request's context.
func ContextLabel(context string) string {
	if _, ok := policy.Contexts[context]; ok {
		return context
	}
	return InvalidContext
}
