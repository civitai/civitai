package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

func errorsTotal(t *testing.T, reg *prometheus.Registry, endpoint, mode, class string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_errors_total", map[string]string{"feed_endpoint": endpoint, "mode": mode, "class": class})
	return v
}

// feed_go_errors_total counts every compute and proxy error by its class, the ones the log limiter
// drops included: 61 serve errors write 60 lines (the default cap) and count 61.
func TestErrorsCounterCountsEveryError(t *testing.T) {
	var buf bytes.Buffer
	reg := prometheus.NewRegistry()
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		return nil, fmt.Errorf("replica: %w", &net.OpError{Op: "read", Err: &os.SyscallError{Syscall: "read", Err: syscall.ECONNRESET}})
	}, &proxyRecorder{})
	s.Log = slog.New(slog.NewJSONHandler(&buf, nil))
	for range 61 {
		s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	}
	if n := len(logLines(t, &buf)); n != 60 {
		t.Fatalf("%d error lines, want 60 (the default cap)", n)
	}
	if got := errorsTotal(t, reg, "as-posts", "serve", "conn_reset"); got != 61 {
		t.Fatalf("feed_go_errors_total{as-posts,serve,conn_reset} = %v, want 61", got)
	}

	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+ProcedureModelGetAll, nil)
	s.NoteProxyError(r, "upstream", &net.OpError{Op: "dial", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}})
	if got := errorsTotal(t, reg, "model-getall", "proxy", "conn_refused"); got != 1 {
		t.Fatalf("feed_go_errors_total{model-getall,proxy,conn_refused} = %v, want 1", got)
	}

	reg = prometheus.NewRegistry()
	sh := newPhaseServer(reg, 1, func(context.Context, *http.Request) (*computed, error) {
		return nil, fmt.Errorf("lookup: %w", pgx.ErrNoRows)
	})
	post(t, sh, "{}")
	waitFor(t, "the shadow error", func() bool { return errorsTotal(t, reg, "as-posts", "shadow", "pg_no_rows") == 1 })
	if err := sh.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// Every label value feed_go_errors_total can carry is from a closed set: the endpoints (plus
// EndpointUnknown for a proxied path no public route names), ErrorModes, and fallback.ErrorClasses.
func TestErrorsCounterLabelsAreClosed(t *testing.T) {
	if got := strings.Join(ErrorModes, ","); got != "serve,shadow,probe,proxy" {
		t.Fatalf("ErrorModes = %s", got)
	}
	if EndpointUnknown != "unknown" {
		t.Fatalf("EndpointUnknown = %q", EndpointUnknown)
	}
	classes := map[string]bool{}
	for _, c := range fallback.ErrorClasses() {
		classes[c] = true
	}
	if len(classes) == 0 {
		t.Fatal("fallback.ErrorClasses is empty")
	}
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	m.ObserveError("", "proxy", errors.New("x"))              // no endpoint: EndpointUnknown
	m.ObserveError("user.getAll", "serve", errors.New("x"))   // not an endpoint: EndpointUnknown
	m.ObserveError(EndpointAsPosts, "batch", errors.New("x")) // not a mode: dropped
	m.ObserveError(EndpointAsPosts, "serve", nil)             // no error: not counted
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	endpoints := map[string]bool{EndpointUnknown: true}
	for _, e := range Endpoints {
		endpoints[e] = true
	}
	modes := map[string]bool{}
	for _, md := range ErrorModes {
		modes[md] = true
	}
	n := 0
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_errors_total" {
			continue
		}
		for _, metric := range mf.GetMetric() {
			if metric.GetCounter().GetValue() == 0 {
				continue
			}
			n++
			for _, l := range metric.GetLabel() {
				ok := map[string]map[string]bool{"feed_endpoint": endpoints, "mode": modes, "class": classes}[l.GetName()]
				if ok == nil || !ok[l.GetValue()] {
					t.Errorf("label %s=%q outside its set", l.GetName(), l.GetValue())
				}
			}
		}
	}
	if n != 2 {
		t.Fatalf("%d non-zero series, want 2", n)
	}
	if got := errorsTotal(t, reg, EndpointUnknown, "proxy", "other"); got != 1 {
		t.Fatalf("errors_total{unknown,proxy,other} = %v, want 1", got)
	}
	if got := errorsTotal(t, reg, EndpointUnknown, "serve", "other"); got != 1 {
		t.Fatalf("errors_total{unknown,serve,other} = %v, want 1", got)
	}
}
