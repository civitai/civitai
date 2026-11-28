package metrics

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// Without EnableCache no cache series exists: a service with no cache exposes what it did before.
func TestTheCacheSeriesExistOnlyWithTheCache(t *testing.T) {
	_, reg := newMetrics(t)
	families, _ := reg.Gather()
	for _, f := range families {
		if strings.Contains(f.GetName(), "cache_ops") || strings.Contains(f.GetName(), "resumes") || strings.Contains(f.GetName(), "breaker") {
			t.Fatalf("%s exists without the cache", f.GetName())
		}
	}
}

func TestTheCacheSeriesAreBoundedAndCounted(t *testing.T) {
	m, reg := newMetrics(t)
	open := false
	m.EnableCache(reg, func() bool { return open })
	// Every kind × op × its own outcomes, at zero from the start; nothing else.
	want := 0
	for _, o := range CacheOps {
		want += len(o) * len(CacheKinds)
	}
	if n := testutil.CollectAndCount(m.CacheOps); n != want {
		t.Fatalf("%d series, want %d", n, want)
	}
	if n := testutil.CollectAndCount(m.Resumes); n != len(ResumeOutcomes) {
		t.Fatalf("%d resume series", n)
	}
	m.ObserveCache("snapshot", "get", "hit")
	m.ObserveResume("synced")
	if v := testutil.ToFloat64(m.CacheOps.WithLabelValues("snapshot", "get", "hit")); v != 1 {
		t.Fatalf("hit %v", v)
	}
	if v := testutil.ToFloat64(m.Resumes.WithLabelValues("synced")); v != 1 {
		t.Fatalf("synced %v", v)
	}
	gauge := func() float64 {
		families, _ := reg.Gather()
		for _, f := range families {
			if f.GetName() == "app_data_cache_breaker_open" {
				return f.GetMetric()[0].GetGauge().GetValue()
			}
		}
		return -1
	}
	if g := gauge(); g != 0 {
		t.Fatalf("closed: %v", g)
	}
	open = true
	if g := gauge(); g != 1 {
		t.Fatalf("open: %v", g)
	}
}
