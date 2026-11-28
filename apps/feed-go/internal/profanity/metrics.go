package profanity

import "github.com/prometheus/client_golang/prometheus"

// Modes are the metric's `mode` values: the public route's check, and a shadow sample's.
var Modes = []string{"serve", "shadow"}

// NewMetrics registers feed_go_search_profanity_total{mode, verdict, reason} (reason is set on
// `unproven` only), seeded at zero for every combination. On a shadow sample, which Node's own check
// has already passed, `profane` counts the queries Go would refuse and Node did not, and `unproven`
// the ones this port cannot answer; on the public route each non-clean verdict is a hand-back.
func NewMetrics(reg prometheus.Registerer) *prometheus.CounterVec {
	c := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "feed_go_search_profanity_total",
		Help: "Site-search profanity checks on the SFW site, by mode, verdict and (unproven) reason.",
	}, []string{"mode", "verdict", "reason"})
	for _, m := range Modes {
		c.WithLabelValues(m, string(Clean), "")
		c.WithLabelValues(m, string(Profane), "")
		for _, r := range UnprovenReasons {
			c.WithLabelValues(m, string(Unproven), r)
		}
	}
	if reg != nil {
		reg.MustRegister(c)
	}
	return c
}

// Observe counts one check's result under mode, when the checker has a counter.
func (c *Checker) Observe(mode string, r Result) {
	if c == nil || c.Verdicts == nil {
		return
	}
	c.Verdicts.WithLabelValues(mode, string(r.Verdict), r.Reason).Inc()
}
