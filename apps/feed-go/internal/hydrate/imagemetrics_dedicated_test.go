package hydrate

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// Which ClickHouse the image metric-hash populate reads: the dedicated entity-metrics one
// (MetricsClickHouse) only while it is configured AND `image-metrics-dedicated-clickhouse` reads on
// (MetricsClickHouseOn); the shared one (ClickHouse) otherwise. The two fakes answer different
// counts (11 shared, 29 dedicated), neither a count a default or an empty read could produce, so the
// served number says which one was read.
//
// The "reads the shared one" cases are INVARIANT guards: they pass on the code before the dedicated
// reader existed too, and pin that adding it changed nothing while it is not selected.

func likeCH(n int) *fakeCH {
	return &fakeCH{rows: []map[string]any{{"entityId": json.Number("32"), "metricType": "Like", "value": json.Number(strconv.Itoa(n))}}}
}

// dedicatedSources is a cold store (image 32's hash absent), write-back on (so every lookup is a
// populate, never the 10 s memo), with the shared and the dedicated reader and a flag read from on.
func dedicatedSources(on *atomic.Bool) (*Sources, *testkit.Redis, *fakeCH, *fakeCH) {
	r := testkit.NewRedis()
	shared, dedicated := likeCH(11), likeCH(29)
	return &Sources{Cache: r, Packed: &PackedReader{Redis: r}, Compute: &MissCompute{
		WriteBack: writeSet(true), ClickHouse: shared, MetricsClickHouse: dedicated, MetricsClickHouseOn: on.Load,
	}}, r, shared, dedicated
}

// readLike is image 32's Like count, its hash cleared first so the read is a populate.
func readLike(t *testing.T, s *Sources, r *testkit.Redis) int {
	t.Helper()
	const id = 32
	r.DelKey(metricHashKey(id))
	got, err := s.ImageMetrics(context.Background(), []int{id})
	if err != nil {
		t.Fatalf("ImageMetrics(%d): %v", id, err)
	}
	return got[id]["Like"]
}

// Invariant guard: flag off, the shared reader only.
func TestMetricsDedicatedFlagOffReadsShared(t *testing.T) {
	var on atomic.Bool
	s, r, shared, dedicated := dedicatedSources(&on)
	if got := readLike(t, s, r); got != 11 {
		t.Fatalf("Like %d, want 11 (the shared reader's)", got)
	}
	if len(shared.seen()) != 1 || len(dedicated.seen()) != 0 {
		t.Fatalf("shared %d, dedicated %d queries; want 1, 0", len(shared.seen()), len(dedicated.seen()))
	}
}

// Flag on with the dedicated reader configured: the dedicated reader only, with the same query text
// and settings the shared one would have been sent.
func TestMetricsDedicatedFlagOnReadsDedicated(t *testing.T) {
	var on atomic.Bool
	on.Store(true)
	s, r, shared, dedicated := dedicatedSources(&on)
	if got := readLike(t, s, r); got != 29 {
		t.Fatalf("Like %d, want 29 (the dedicated reader's)", got)
	}
	if len(shared.seen()) != 0 {
		t.Fatalf("shared reader sent %d queries, want none", len(shared.seen()))
	}
	q := dedicated.seen()
	if len(q) != 1 || q[0].sql != sqlImageMetrics([]int{32}) || !reflect.DeepEqual(q[0].settings, metricPointSettings) {
		t.Fatalf("dedicated queries %v, want one over 32 with the point settings", q)
	}
	// The written hash is the shared cache's, exactly as a shared read writes it.
	if h := r.Hash(metricHashKey(32)); h["Like"] != "29" {
		t.Fatalf("hash %v, want Like 29 written", h)
	}
}

// Invariant guard: flag on without the dedicated reader (CLICKHOUSE_METRICS_* unset), or with no flag
// read at all (no Flipt): the shared reader.
func TestMetricsDedicatedNotConfiguredReadsShared(t *testing.T) {
	var on atomic.Bool
	on.Store(true)
	s, r, shared, _ := dedicatedSources(&on)
	s.Compute.MetricsClickHouse = nil
	if got := readLike(t, s, r); got != 11 {
		t.Fatalf("no dedicated reader: Like %d, want 11", got)
	}
	s, r, shared2, dedicated := dedicatedSources(&on)
	s.Compute.MetricsClickHouseOn = nil
	if got := readLike(t, s, r); got != 11 {
		t.Fatalf("no flag read: Like %d, want 11", got)
	}
	if len(shared.seen()) != 1 || len(shared2.seen()) != 1 || len(dedicated.seen()) != 0 {
		t.Fatalf("queries shared %d/%d dedicated %d; want 1/1 0", len(shared.seen()), len(shared2.seen()), len(dedicated.seen()))
	}
}

// Invariant guard: the dedicated reader never turns the computation on. Without the shared reader the
// miss falls back `metrics-miss`, as before, flag on or not.
func TestMetricsDedicatedAloneDoesNotCompute(t *testing.T) {
	var on atomic.Bool
	on.Store(true)
	s, r, _, dedicated := dedicatedSources(&on)
	s.Compute.ClickHouse = nil
	r.DelKey(metricHashKey(32))
	if _, err := s.ImageMetrics(context.Background(), []int{32}); fallback.Reason(err) != "metrics-miss" {
		t.Fatalf("err %v (reason %q), want metrics-miss", err, fallback.Reason(err))
	}
	if len(dedicated.seen()) != 0 {
		t.Fatalf("dedicated reader sent %d queries, want none", len(dedicated.seen()))
	}
}

// The flag is read on every populate, so a flip takes effect on the next one, both ways, in the same
// process (no rebuilt Sources).
func TestMetricsDedicatedRuntimeFlip(t *testing.T) {
	var on atomic.Bool
	s, r, shared, dedicated := dedicatedSources(&on)
	want := []struct {
		on   bool
		like int
	}{{false, 11}, {true, 29}, {true, 29}, {false, 11}}
	for i, w := range want {
		on.Store(w.on)
		if got := readLike(t, s, r); got != w.like {
			t.Fatalf("read %d (flag %v): Like %d, want %d", i, w.on, got, w.like)
		}
	}
	if len(shared.seen()) != 2 || len(dedicated.seen()) != 2 {
		t.Fatalf("shared %d, dedicated %d queries; want 2, 2", len(shared.seen()), len(dedicated.seen()))
	}
}

// One populate sends every batch to the server it started on, even when the flag flips mid-populate.
func TestMetricsDedicatedOnePopulateOneServer(t *testing.T) {
	var on atomic.Bool
	on.Store(true)
	s, _, shared, dedicated := dedicatedSources(&on)
	dedicated.onQuery = func() { on.Store(false) }
	ids := make([]int, 1001)
	for i := range ids {
		ids[i] = 40001 + i
	}
	if _, err := s.ImageMetrics(context.Background(), ids); err != nil {
		t.Fatal(err)
	}
	if len(dedicated.seen()) != 2 || len(shared.seen()) != 0 {
		t.Fatalf("dedicated %d, shared %d queries; want both batches (2) on the dedicated one", len(dedicated.seen()), len(shared.seen()))
	}
}

// A failed dedicated read fails the lookup exactly as a failed shared read does (`metrics-miss-failed`,
// counted as an error, nothing written) and is never retried on the shared reader.
func TestMetricsDedicatedFailureNoSharedRetry(t *testing.T) {
	for name, failing := range map[string]*fakeCH{
		"error": {err: &chread.ServerError{Code: 210, Message: "Connection refused"}},
		"busy":  {err: chread.ErrBusy},
		"slow":  {delay: time.Minute},
		"other": {err: errors.New("dial tcp: connection refused")},
	} {
		t.Run(name, func(t *testing.T) {
			var on atomic.Bool
			on.Store(true)
			s, r, shared, _ := dedicatedSources(&on)
			s.Compute.MetricsClickHouse = failing
			s.Compute.MetricsTimeout = 50 * time.Millisecond
			var errs int
			s.Compute.Observe = func(cache, result string, n int) {
				if cache == MissMetrics && result == "error" {
					errs += n
				}
			}
			_, err := s.ImageMetrics(context.Background(), []int{32})
			if fallback.Reason(err) != "metrics-miss-failed" {
				t.Fatalf("err %v (reason %q), want metrics-miss-failed", err, fallback.Reason(err))
			}
			if errs != 1 {
				t.Fatalf("errors counted %d, want 1", errs)
			}
			if len(failing.seen()) != 1 {
				t.Fatalf("dedicated reader sent %d queries, want 1", len(failing.seen()))
			}
			if n := len(shared.seen()); n != 0 {
				t.Fatalf("shared reader sent %d queries after the dedicated read failed, want none (no retry)", n)
			}
			if h := r.Hash(metricHashKey(32)); h != nil {
				t.Fatalf("hash %v written, want none", h)
			}
		})
	}
}

// Invariant guard: every per-query settings list a populate can send stays inside the dedicated
// server's user constraints: max_threads in [1, 2], max_execution_time in [1, 30] s, and nothing
// named that the constraints cap otherwise (max_memory_usage is never sent; the server's own
// profile value applies).
func TestMetricsSettingsInsideDedicatedConstraints(t *testing.T) {
	bounds := map[string][2]int{"max_threads": {1, 2}, "max_execution_time": {1, 30}}
	allowed := map[string]bool{"max_threads": true, "max_execution_time": true, "timeout_overflow_mode": true}
	lists := map[string][]chread.Setting{"point": metricPointSettings, "retry": metricRetrySettings}
	// Every list metricLookupSettings can return (past 100 ids: none).
	r := testkit.NewRedis()
	s := &Sources{Cache: r}
	lists["over-100"] = s.metricLookupSettings(context.Background(), make([]int, metricPointLookupMax+1))
	r.SetString(metricTimedOutKey(7), []byte("1"))
	lists["marked"] = s.metricLookupSettings(context.Background(), []int{7})
	lists["unmarked"] = s.metricLookupSettings(context.Background(), []int{8})
	for name, list := range lists {
		for _, st := range list {
			if !allowed[st.Name] {
				t.Errorf("%s: setting %s is not one the populate is known to send", name, st.Name)
			}
			if b, ok := bounds[st.Name]; ok {
				n, err := strconv.Atoi(st.Value)
				if err != nil || n < b[0] || n > b[1] {
					t.Errorf("%s: %s=%s outside [%d, %d]", name, st.Name, st.Value, b[0], b[1])
				}
			}
		}
	}
	if !reflect.DeepEqual(lists["marked"], metricRetrySettings) || !reflect.DeepEqual(lists["unmarked"], metricPointSettings) || lists["over-100"] != nil {
		t.Fatalf("settings by case %v: the cases did not reach every list", lists)
	}
}
