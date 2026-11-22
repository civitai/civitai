package server

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// The ratio counters exist at 0 from construction, so a new pod's first event is an increase rate()
// sees, not the creation of a series at 1 that it misses. Each series is looked up by Gather
// (metricValue), never by WithLabelValues, which would create the series it is meant to find.

// Every request outcome a path can reach is a 0 series per endpoint, and only those: served_cached
// on the single-model route alone (the only cached answer), on both modes.
func TestRequestOutcomesAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// serve: 5 public routes x served, served_empty, fallback, error, + v1-models-id served_cached;
	// shadow: 7 endpoints x the same 4, + v1-models-id served_cached.
	if n := testutil.CollectAndCount(m.Requests); n != 5*4+1+7*4+1 {
		t.Fatalf("feed_go_requests_total has %d series at construction, want 50", n)
	}
	served := []string{"as-posts", "model-getall", "infinite", "v1-models", "v1-models-id"}
	all := append([]string{"v1-images", "model-associated"}, served...)
	for mode, endpoints := range map[string][]string{"serve": served, "shadow": all} {
		for _, e := range endpoints {
			for _, o := range []string{"served", "served_empty", "fallback", "error"} {
				l := map[string]string{"feed_endpoint": e, "mode": mode, "outcome": o}
				if v, found := metricValue(t, reg, "feed_go_requests_total", l); !found || v != 0 {
					t.Errorf("requests%v = %v found=%v, want a 0 series", l, v, found)
				}
			}
		}
		l := map[string]string{"feed_endpoint": "v1-models-id", "mode": mode, "outcome": "served_cached"}
		if v, found := metricValue(t, reg, "feed_go_requests_total", l); !found || v != 0 {
			t.Errorf("requests%v = %v found=%v, want a 0 series", l, v, found)
		}
		l = map[string]string{"feed_endpoint": "as-posts", "mode": mode, "outcome": "served_cached"}
		if _, found := metricValue(t, reg, "feed_go_requests_total", l); found {
			t.Errorf("requests%v exists: as-posts has no cached answer", l)
		}
	}
	if _, found := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": "v1-images", "mode": "serve", "outcome": "served"}); found {
		t.Error("v1-images has no public route, yet a serve series exists")
	}
}

// Every shadow result the compare path can count is a 0 series per endpoint: the diff results
// (fields, order, membership) and the matches they are a share of, and only those.
func TestShadowResultsAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// 7 endpoints x 10 results, less match_cached on the 6 without a cached answer and order on
	// v1-models-id (one model: ClassifyV1ModelID has no order).
	if n := testutil.CollectAndCount(m.ShadowResults); n != 7*10-6-1 {
		t.Fatalf("feed_go_shadow_compare_total has %d series at construction, want 63", n)
	}
	common := []string{"match", "match_empty", "fields", "membership", "unsupported", "deadline", "go_error", "bad_request"}
	for _, e := range []string{"as-posts", "v1-images", "infinite", "model-getall", "v1-models", "v1-models-id", "model-associated"} {
		results := append([]string(nil), common...)
		if e != "v1-models-id" {
			results = append(results, "order")
		}
		for _, r := range results {
			if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": r}); !found || v != 0 {
				t.Errorf("shadow_compare{%s,%s} = %v found=%v, want a 0 series", e, r, v, found)
			}
		}
	}
	if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": "v1-models-id", "result": "match_cached"}); !found || v != 0 {
		t.Errorf("shadow_compare{v1-models-id,match_cached} = %v found=%v, want a 0 series", v, found)
	}
	for _, c := range [][2]string{{"as-posts", "match_cached"}, {"v1-models-id", "order"}} {
		if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": c[0], "result": c[1]}); found {
			t.Errorf("shadow_compare{%s,%s} exists, but the compare path cannot count it", c[0], c[1])
		}
	}
}

// The fallback reasons every compute can end in (Server.within: deadline, canceled, panic) are 0
// series for each mode's endpoints, with serve's `error` and `bulkhead`; the endpoint-specific
// reasons stay lazy.
func TestComputeFallbackReasonsAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// serve: 5 routes x (bulkhead, error, deadline, canceled, panic); shadow: 7 x 3; probe: 3 x 3.
	if n := testutil.CollectAndCount(m.Fallbacks); n != 5*5+7*3+3*3 {
		t.Fatalf("feed_go_fallback_total has %d series at construction, want 55", n)
	}
	cases := map[string]struct {
		endpoints, reasons []string
	}{
		"serve":  {[]string{"as-posts", "model-getall", "infinite", "v1-models", "v1-models-id"}, []string{"bulkhead", "error", "deadline", "canceled", "panic"}},
		"shadow": {[]string{"as-posts", "v1-images", "infinite", "model-getall", "v1-models", "v1-models-id", "model-associated"}, []string{"deadline", "canceled", "panic"}},
		"probe":  {[]string{"as-posts", "infinite", "model-getall"}, []string{"deadline", "canceled", "panic"}},
	}
	for mode, c := range cases {
		for _, e := range c.endpoints {
			for _, r := range c.reasons {
				l := map[string]string{"feed_endpoint": e, "mode": mode, "reason": r}
				if v, found := metricValue(t, reg, "feed_go_fallback_total", l); !found || v != 0 {
					t.Errorf("fallback%v = %v found=%v, want a 0 series", l, v, found)
				}
			}
		}
	}
}

// Invariant guards (these series were seeded before the outcome seeding, and still are): the panic
// counter per where, and every devalue write result on the tRPC routes. The error counter is NOT
// seeded: its class label is ~70 values per endpoint and mode, far past what is ever reached.
func TestPanicsDevalueSeededErrorsLazy(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	if n := testutil.CollectAndCount(m.Panics); n != 3 {
		t.Errorf("feed_go_panics_total has %d series, want 3", n)
	}
	for _, w := range []string{"serve", "shadow", "probe"} {
		if v, found := metricValue(t, reg, "feed_go_panics_total", map[string]string{"where": w}); !found || v != 0 {
			t.Errorf("panics{%s} = %v found=%v, want a 0 series", w, v, found)
		}
	}
	for _, e := range []string{"as-posts", "model-getall", "infinite"} {
		if v, found := metricValue(t, reg, "feed_go_devalue_write_total", map[string]string{"feed_endpoint": e, "result": "superjson_fallback"}); !found || v != 0 {
			t.Errorf("devalue_write{%s,superjson_fallback} = %v found=%v, want a 0 series", e, v, found)
		}
	}
	if n := testutil.CollectAndCount(m.Errors); n != 0 {
		t.Errorf("feed_go_errors_total has %d series at construction, want none (unbounded class)", n)
	}
}
