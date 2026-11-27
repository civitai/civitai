package metrics

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
)

func newMetrics(t *testing.T) (*Metrics, *prometheus.Registry) {
	t.Helper()
	reg := prometheus.NewRegistry()
	return New(reg, func() (int, int, int, int) { return 0, 0, 0, 0 }), reg
}

// THE SHARED-REFUSAL LABEL SET IS BOUNDED: every registered reason exists at zero from the start, and
// a reason outside the set (a slug, a collection, a new code nobody registered) is counted as `other`,
// never as a new series.
func TestSharedRefusalReasonsAreBounded(t *testing.T) {
	m, reg := newMetrics(t)
	series := func() int { return testutil.CollectAndCount(m.SharedRefusals, "app_data_shared_refusals_total") }
	if n := series(); n != len(SharedRefusalReasons) || n != 29 {
		t.Fatalf("%d series at start, want the %d registered (29)", n, len(SharedRefusalReasons))
	}
	seen := map[string]bool{}
	for _, r := range SharedRefusalReasons {
		if seen[r] {
			t.Fatalf("reason %s registered twice", r)
		}
		seen[r] = true
	}
	m.ObserveSharedRefusal("not_resolved")
	m.ObserveSharedRefusal("not_resolved")
	m.ObserveSharedRefusal("signed_out_busy")
	for _, junk := range []string{"todo-app", "notes", "", "capacity "} {
		m.ObserveSharedRefusal(junk)
	}
	if n := series(); n != len(SharedRefusalReasons) {
		t.Fatalf("🔴 %d series after unregistered reasons, want %d: the label set grew", n, len(SharedRefusalReasons))
	}
	for r, want := range map[string]float64{"not_resolved": 2, "signed_out_busy": 1, "other": 4, "capacity": 0} {
		if n := testutil.ToFloat64(m.SharedRefusals.WithLabelValues(r)); n != want {
			t.Errorf("%s: %v, want %v", r, n, want)
		}
	}
	if _, err := reg.Gather(); err != nil {
		t.Fatal(err)
	}
}

// THE BLOCK-EXCHANGE LOG SAYS WHAT THE READ DOES NEXT: with APP_DATA_WRITES off it falls back to REST;
// on, a read has no REST fallback (cut over, or shared) and is refused, so the line must not say REST.
// The counted-only outcomes stay unlogged in both modes.
func TestTheBlockExchangeLogNamesWhatTheReadDoes(t *testing.T) {
	for _, c := range []struct {
		writes    bool
		msg, read string
	}{
		{false, "block token not exchanged; the read falls back to REST", "rest"},
		{true, "block token not exchanged; the read is refused (no REST fallback with APP_DATA_WRITES on)", "refused"},
	} {
		m, _ := newMetrics(t)
		var buf bytes.Buffer
		observe := m.ObserveBlockExchange(slog.New(slog.NewJSONHandler(&buf, nil)), c.writes)
		observe(exchange.BlockRefused, "invalid_grant")
		observe(exchange.BlockIssued, "none")
		observe(exchange.BlockUnverifiable, "none")
		observe(exchange.BlockRefused, exchange.LocalRefusalCode)
		lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
		if len(lines) != 1 {
			t.Fatalf("writes=%v: %d lines logged, want 1: %s", c.writes, len(lines), buf.String())
		}
		var got struct{ Msg, Outcome, Error, Read string }
		if err := json.Unmarshal([]byte(lines[0]), &got); err != nil {
			t.Fatal(err)
		}
		if got.Msg != c.msg || got.Read != c.read || got.Outcome != exchange.BlockRefused || got.Error != "invalid_grant" {
			t.Errorf("writes=%v: logged %+v, want %q read=%s", c.writes, got, c.msg, c.read)
		}
		if c.writes && (strings.Contains(got.Msg, "falls back") || strings.Contains(got.Msg, "goes to REST")) {
			t.Errorf("🔴 writes on, the log still says the read falls back to REST: %q", got.Msg)
		}
		if n := testutil.ToFloat64(m.BlockExchanges.WithLabelValues(exchange.BlockRefused, "invalid_grant")); n != 1 {
			t.Errorf("writes=%v: refused counted %v", c.writes, n)
		}
	}
}
