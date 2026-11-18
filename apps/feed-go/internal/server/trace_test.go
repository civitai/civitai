package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
)

// Trace ids by the Node sampler's decision at 0.1 (tracing.NodeRatio, pinned against the JS sampler
// in internal/tracing): inTrace is kept, outTrace is not.
const (
	inTrace    = "0577cd69a35d1adc3df3616183b98451"
	outTrace   = "4bf92f3577b34da6a3ce929d0e0e4736"
	nodeSpanID = "00f067aa0ba902b7"
	sentinel   = "SENTINEL_USER_42"
)

func traceparent(traceID, flags string) string {
	return "00-" + traceID + "-" + nodeSpanID + "-" + flags
}

// traced turns tracing on for s, as main does, over an in-memory recorder at Node's ratio.
func traced(s *Server) *tracetest.SpanRecorder {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(tracing.HeadSampler(0.1)), sdktrace.WithSpanProcessor(rec))
	s.Tracer, s.Propagator = tp.Tracer("test"), tracing.Propagator()
	return rec
}

func spanAttrs(s sdktrace.ReadOnlySpan) map[attribute.Key]string {
	out := map[attribute.Key]string{}
	for _, kv := range s.Attributes() {
		out[kv.Key] = kv.Value.String()
	}
	return out
}

func endedNamed(rec *tracetest.SpanRecorder, name string) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.Name() == name {
			out = append(out, s)
		}
	}
	return out
}

// The go-arm path: a public :8080 request carrying a traceparent (the browser's, which the Faro
// frontend sends same-origin, or an edge's) is served under a server span that is the caller's child:
// same trace id, the caller's span as remote parent, the endpoint, mode and outcome as attributes.
// The sampler honours the parent: an unsampled parent, or a sampled one whose trace id the ratio
// drops, records nothing (and the request is answered the same).
func TestServeSpanContinuesTheCallersTrace(t *testing.T) {
	s := serveServer(prometheus.NewRegistry(), served(nil), &proxyRecorder{})
	rec := traced(s)
	r := publicRequest()
	r.Header.Set("traceparent", traceparent(inTrace, "01"))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("code %d, want 200", w.Code)
	}
	spans := rec.Ended()
	if len(spans) != 1 {
		t.Fatalf("%d spans, want 1", len(spans))
	}
	sp := spans[0]
	if sp.Name() != "serve as-posts" || sp.SpanKind() != trace.SpanKindServer {
		t.Fatalf("span %q kind %v, want `serve as-posts`, server", sp.Name(), sp.SpanKind())
	}
	if got := sp.SpanContext().TraceID().String(); got != inTrace {
		t.Fatalf("trace id %s, want the caller's %s", got, inTrace)
	}
	if got := sp.Parent(); got.SpanID().String() != nodeSpanID || !got.IsRemote() {
		t.Fatalf("parent %s remote=%v, want the caller's %s, remote", got.SpanID(), got.IsRemote(), nodeSpanID)
	}
	want := map[attribute.Key]string{"feed_endpoint": "as-posts", "feed_go.mode": "serve", "feed_go.outcome": "served"}
	if got := spanAttrs(sp); len(got) != len(want) || got["feed_endpoint"] != "as-posts" || got["feed_go.mode"] != "serve" || got["feed_go.outcome"] != "served" {
		t.Fatalf("attributes %v, want %v", got, want)
	}

	for _, tp := range []string{traceparent(inTrace, "00"), traceparent(outTrace, "01")} {
		rec.Reset()
		r := publicRequest()
		r.Header.Set("traceparent", tp)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusOK || len(rec.Ended()) != 0 {
			t.Fatalf("traceparent %s: code %d, %d spans recorded; want 200 and none", tp, w.Code, len(rec.Ended()))
		}
	}
}

// A fallback is proxied inside a client span, the serve span's child, and the proxy sees that span in
// its request context (its traceparent is injected from there: cmd/feed-go's proxy test). The serve
// span carries the reason and a `fallback` event.
func TestFallbackProxyHopIsAChildSpan(t *testing.T) {
	var seen trace.SpanContext
	fb := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = trace.SpanContextFromContext(r.Context())
		w.WriteHeader(http.StatusTeapot)
	})
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, fallback.Safef("feed-status", "%d", 503)
	}, fb)
	rec := traced(s)
	r := publicRequest()
	r.Header.Set("traceparent", traceparent(inTrace, "01"))
	s.ServeHTTP(httptest.NewRecorder(), r)

	serve, hop := endedNamed(rec, "serve as-posts"), endedNamed(rec, "fallback-proxy as-posts")
	if len(serve) != 1 || len(hop) != 1 {
		t.Fatalf("spans %d serve, %d proxy; want 1 and 1", len(serve), len(hop))
	}
	if hop[0].Parent().SpanID() != serve[0].SpanContext().SpanID() || hop[0].SpanKind() != trace.SpanKindClient {
		t.Fatalf("proxy span parent %s kind %v, want the serve span %s, client", hop[0].Parent().SpanID(), hop[0].SpanKind(), serve[0].SpanContext().SpanID())
	}
	if seen.SpanID() != hop[0].SpanContext().SpanID() || seen.TraceID().String() != inTrace {
		t.Fatalf("the proxy saw span %s/%s, want the hop's %s in trace %s", seen.TraceID(), seen.SpanID(), hop[0].SpanContext().SpanID(), inTrace)
	}
	a := spanAttrs(serve[0])
	if a["feed_go.outcome"] != "fallback" || a["feed_go.fallback.reason"] != "feed-status" {
		t.Fatalf("serve span attributes %v", a)
	}
	ev := serve[0].Events()
	if len(ev) != 1 || ev[0].Name != "fallback" {
		t.Fatalf("serve span events %v, want one `fallback`", ev)
	}
	got := map[attribute.Key]string{}
	for _, kv := range ev[0].Attributes {
		got[kv.Key] = kv.Value.String()
	}
	if got["feed_go.fallback.reason"] != "feed-status" || got["feed_go.fallback.detail"] != "503" {
		t.Fatalf("fallback event attributes %v", got)
	}
}

// An inbound traceparent on the internal shadow endpoint is honoured if present (the Node samplers do
// not send one: their samples are independent roots), and the span ends when the comparison does,
// with its outcome and result; the shadow phase histogram gets the trace id as an exemplar.
func TestShadowSpanContinuesTheSamplersTrace(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	rec := traced(s)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+Procedure, shadowBody(t, "{}"))
	req.Header.Set("traceparent", traceparent(inTrace, "01"))
	w := httptest.NewRecorder()
	s.ShadowHandler(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
	waitFor(t, "the shadow span", func() bool { return len(rec.Ended()) == 1 })
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	sp := rec.Ended()[0]
	if sp.Name() != "shadow as-posts" || sp.SpanContext().TraceID().String() != inTrace || sp.Parent().SpanID().String() != nodeSpanID {
		t.Fatalf("span %q trace %s parent %s", sp.Name(), sp.SpanContext().TraceID(), sp.Parent().SpanID())
	}
	a := spanAttrs(sp)
	if a["feed_go.mode"] != "shadow" || a["feed_go.outcome"] != "served" || a["feed_go.shadow.result"] != "match" {
		t.Fatalf("attributes %v", a)
	}
	body := scrape(t, MetricsHandler(reg, true))
	if !hasExemplar(body, "feed_go_shadow_phase_seconds_bucket", inTrace) || !hasExemplar(body, "feed_go_request_duration_seconds_bucket", inTrace) {
		t.Fatalf("no trace-id exemplar on the shadow histograms:\n%s", grepLines(body, "trace_id"))
	}
}

// scrape asks h for OpenMetrics, as a Prometheus scrape with exemplars on does.
func scrape(t *testing.T, h http.Handler) string {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/metrics", nil)
	req.Header.Set("Accept", "application/openmetrics-text; version=1.0.0; charset=utf-8")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	b, err := io.ReadAll(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func hasExemplar(body, series, traceID string) bool {
	for _, l := range strings.Split(body, "\n") {
		if strings.HasPrefix(l, series+"{") && strings.Contains(l, `# {trace_id="`+traceID+`"}`) {
			return true
		}
	}
	return false
}

func grepLines(body, sub string) string {
	var out []string
	for _, l := range strings.Split(body, "\n") {
		if strings.Contains(l, sub) {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// The request duration histogram carries the trace id as an exemplar only for a SAMPLED request, and
// /metrics serves it in OpenMetrics only with the format enabled (tracing on).
func TestDurationExemplarOnlyForSampledRequests(t *testing.T) {
	for _, c := range []struct {
		name        string
		tracing     bool
		traceparent string
		openMetrics bool
		want        bool
	}{
		{"sampled", true, traceparent(inTrace, "01"), true, true},
		{"unsampled parent", true, traceparent(inTrace, "00"), true, false},
		{"parent the ratio drops", true, traceparent(outTrace, "01"), true, false},
		{"tracing off", false, traceparent(inTrace, "01"), true, false},
		{"classic text format", true, traceparent(inTrace, "01"), false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s := serveServer(reg, served(nil), &proxyRecorder{})
			if c.tracing {
				traced(s)
			}
			r := publicRequest()
			r.Header.Set("traceparent", c.traceparent)
			s.ServeHTTP(httptest.NewRecorder(), r)
			body := scrape(t, MetricsHandler(reg, c.openMetrics))
			if !strings.Contains(body, `feed_go_request_duration_seconds_count{feed_endpoint="as-posts",mode="serve",outcome="served"} 1`) {
				t.Fatalf("the request was not observed:\n%s", grepLines(body, "feed_go_request_duration_seconds_count"))
			}
			if got := hasExemplar(body, "feed_go_request_duration_seconds_bucket", inTrace); got != c.want {
				t.Fatalf("exemplar present = %v, want %v:\n%s", got, c.want, grepLines(body, "trace_id"))
			}
			if !c.want && strings.Contains(body, "trace_id") {
				t.Fatalf("an exemplar where none is due:\n%s", grepLines(body, "trace_id"))
			}
		})
	}
}

// logLines decodes the JSON log lines in buf.
func logLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if l == "" {
			continue
		}
		m := map[string]any{}
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("log line %q: %v", l, err)
		}
		out = append(out, m)
	}
	return out
}

// checkLine compares the fields of a log line with want (numbers as JSON decodes them) and that it has
// no other field than want's plus time.
func checkLine(t *testing.T, got, want map[string]any) {
	t.Helper()
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("log field %s = %v, want %v (line %v)", k, got[k], v, got)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok && k != "time" {
			t.Fatalf("unexpected log field %s=%v (line %v)", k, got[k], got)
		}
	}
}

func inputRequest(input string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/api/trpc/"+Procedure+"?input="+url.QueryEscape(input), nil)
	r.Header.Set("Origin", "https://site.example")
	return r
}

// One line per fallback, through the real input parser: mode, endpoint, reason, the safe detail when
// the call site gives one, and the trace and span ids. A user value in the input never reaches the
// log (the detail of `input-username` and of a bad `limit` is not the value); the include value does
// (the positive control that details are written at all).
func TestFallbackLogLineFieldsAndRedaction(t *testing.T) {
	for _, c := range []struct {
		input string
		want  map[string]any
	}{
		{`{"json":{"username":"` + sentinel + `"}}`, map[string]any{"reason": "input-username"}},
		{`{"json":{"limit":"` + sentinel + `"}}`, map[string]any{"reason": "input-invalid", "detail": "limit"}},
		// The type name, filtered: `map[string]interface {}`.
		{`{"json":{"cursor":{"at":"` + sentinel + `"}}}`, map[string]any{"reason": "input-cursor", "detail": "map?string?interface ??"}},
		{`{"json":{"include":["tags"]}}`, map[string]any{"reason": "input-include", "detail": "tags"}},
	} {
		var buf bytes.Buffer
		s := serveServer(prometheus.NewRegistry(), nil, &proxyRecorder{})
		s.Events = &EventLog{Log: slog.New(slog.NewJSONHandler(&buf, nil)), FallbackPerMinute: 10}
		rec := traced(s)
		r := inputRequest(c.input)
		r.Header.Set("traceparent", traceparent(inTrace, "01"))
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusTeapot {
			t.Fatalf("%s: code %d, want the proxy's 418", c.input, w.Code)
		}
		serve := endedNamed(rec, "serve as-posts")
		if len(serve) != 1 {
			t.Fatalf("%s: %d serve spans", c.input, len(serve))
		}
		lines := logLines(t, &buf)
		if len(lines) != 1 {
			t.Fatalf("%s: %d log lines, want 1:\n%s", c.input, len(lines), buf.String())
		}
		want := map[string]any{"level": "INFO", "msg": "fallback", "mode": "serve", "endpoint": "as-posts",
			"trace_id": inTrace, "span_id": serve[0].SpanContext().SpanID().String()}
		for k, v := range c.want {
			want[k] = v
		}
		checkLine(t, lines[0], want)
		if strings.Contains(buf.String(), sentinel) {
			t.Fatalf("%s: the user value reached the log:\n%s", c.input, buf.String())
		}
		// The spans too: attributes, event attributes (feed_go.fallback.detail) and status.
		seen := spanStrings(rec)
		for _, v := range seen {
			if strings.Contains(v, sentinel) {
				t.Fatalf("%s: the user value reached a span: %q", c.input, v)
			}
		}
		// Positive control: the scan reads event attributes (the safe detail is there when there is one).
		if d, ok := c.want["detail"].(string); ok && !slices.Contains(seen, "event fallback feed_go.fallback.detail="+d) {
			t.Fatalf("%s: span scan did not see the fallback event's detail %q in %q", c.input, d, seen)
		}
	}
}

// spanStrings is every string an ended span exports: its name, attributes, event names and event
// attributes, and status description, each as one "<where> <key>=<value>" entry.
func spanStrings(rec *tracetest.SpanRecorder) []string {
	var out []string
	for _, sp := range rec.Ended() {
		out = append(out, "name "+sp.Name(), "status "+sp.Status().Description)
		for _, kv := range sp.Attributes() {
			out = append(out, "attr "+string(kv.Key)+"="+kv.Value.String())
		}
		for _, ev := range sp.Events() {
			out = append(out, "event "+ev.Name)
			for _, kv := range ev.Attributes {
				out = append(out, "event "+ev.Name+" "+string(kv.Key)+"="+kv.Value.String())
			}
		}
	}
	return out
}

// Without FEED_GO_FALLBACK_LOG_PER_MIN (0) no fallback line is written; without a span there are no
// trace fields.
func TestFallbackLogOffByDefault(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	newServer := func() *Server {
		s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
			return nil, fallback.New("verified-bot")
		}, &proxyRecorder{})
		s.Log = log
		return s
	}
	newServer().ServeHTTP(httptest.NewRecorder(), publicRequest())
	if buf.Len() != 0 {
		t.Fatalf("fallback logged with the default (off):\n%s", buf.String())
	}
	s := newServer()
	s.Events = &EventLog{Log: log, FallbackPerMinute: 1}
	s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	lines := logLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("%d lines, want 1", len(lines))
	}
	checkLine(t, lines[0], map[string]any{"level": "INFO", "msg": "fallback", "mode": "serve", "endpoint": "as-posts", "reason": "verified-bot"})
}

// A compute error (not a fallback) is logged by class and type, never its text, with the trace ids.
func TestServeErrorLogLineHasNoErrorText(t *testing.T) {
	var buf bytes.Buffer
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, errors.New("replica on fire for user " + sentinel)
	}, &proxyRecorder{})
	s.Log = slog.New(slog.NewJSONHandler(&buf, nil))
	rec := traced(s)
	r := publicRequest()
	r.Header.Set("traceparent", traceparent(inTrace, "01"))
	s.ServeHTTP(httptest.NewRecorder(), r)
	serve := endedNamed(rec, "serve as-posts")
	lines := logLines(t, &buf)
	if len(lines) != 1 || len(serve) != 1 {
		t.Fatalf("%d lines, %d spans; want 1 and 1:\n%s", len(lines), len(serve), buf.String())
	}
	checkLine(t, lines[0], map[string]any{"level": "ERROR", "msg": "feed compute failed; falling back", "mode": "serve",
		"endpoint": "as-posts", "err_class": "other", "err_type": "*errors.errorString",
		"trace_id": inTrace, "span_id": serve[0].SpanContext().SpanID().String()})
	if strings.Contains(buf.String(), sentinel) {
		t.Fatalf("the error text reached the log:\n%s", buf.String())
	}
	seen := spanStrings(rec)
	for _, v := range seen {
		if strings.Contains(v, sentinel) {
			t.Fatalf("the error text reached a span: %q", v)
		}
	}
	// Positive control: the scan reads event attributes.
	if !slices.Contains(seen, "event error feed_go.error.class=other") {
		t.Fatalf("span scan did not see the error event's class in %q", seen)
	}
	if st := serve[0].Status(); st.Description != "other" {
		t.Fatalf("span status %+v, want error `other`", st)
	}
}

// The proxy's error line names the endpoint of the request's path and the trace, not the error text.
func TestNoteProxyErrorLine(t *testing.T) {
	var buf bytes.Buffer
	s := &Server{Log: slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))}
	sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: mustTraceID(t, inTrace), SpanID: trace.SpanID{0, 0, 0, 0, 0, 0, 0, 7}, TraceFlags: trace.FlagsSampled})
	r := httptest.NewRequestWithContext(trace.ContextWithSpanContext(context.Background(), sc), http.MethodGet, "/api/trpc/"+ProcedureModelGetAll+"?input=%7B%7D", nil)
	s.NoteProxyError(r, "upstream", &net.OpError{Op: "dial", Err: errors.New("connection refused " + sentinel)})
	s.NoteProxyError(r, "canceled", context.Canceled)
	lines := logLines(t, &buf)
	if len(lines) != 2 {
		t.Fatalf("%d lines, want 2:\n%s", len(lines), buf.String())
	}
	checkLine(t, lines[0], map[string]any{"level": "WARN", "msg": "fallback proxy: the Node app did not answer",
		"endpoint": "model-getall", "reason": "upstream", "err_class": "net_dial", "err_type": "*errors.errorString",
		"trace_id": inTrace, "span_id": "0000000000000007"})
	checkLine(t, lines[1], map[string]any{"level": "DEBUG", "msg": "fallback proxy: the Node app did not answer",
		"endpoint": "model-getall", "reason": "canceled", "err_class": "canceled", "err_type": "*errors.errorString",
		"trace_id": inTrace, "span_id": "0000000000000007"})
	if strings.Contains(buf.String(), sentinel) {
		t.Fatalf("the error text reached the log:\n%s", buf.String())
	}
}

func mustTraceID(t *testing.T, hex string) trace.TraceID {
	t.Helper()
	id, err := trace.TraceIDFromHex(hex)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// The limiter: PerMinute lines per key at once, refilled continuously; a dropped line is counted on
// the key's next line (there is no separate flush line: feed_go_errors_total and feed_go_fallback_total
// count every event); keys are independent.
func TestEventLogRateLimitsPerKey(t *testing.T) {
	var buf bytes.Buffer
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := &EventLog{Log: slog.New(slog.NewJSONHandler(&buf, nil)), FallbackPerMinute: 2, Now: func() time.Time { return now }}
	ctx := context.Background()
	status := fallback.Safef("feed-status", "%d", 503)
	for range 5 {
		l.Fallback(ctx, "serve", EndpointAsPosts, status)
	}
	l.Fallback(ctx, "shadow", EndpointAsPosts, status)                  // another key (mode)
	l.Fallback(ctx, "serve", EndpointAsPosts, fallback.New("bulkhead")) // another key (reason)
	lines := logLines(t, &buf)
	if len(lines) != 4 {
		t.Fatalf("%d lines, want 2 + 1 + 1:\n%s", len(lines), buf.String())
	}
	if _, ok := lines[1]["suppressed"]; ok {
		t.Fatalf("second line carries suppressed before anything was dropped: %v", lines[1])
	}
	buf.Reset()
	l.Fallback(ctx, "serve", EndpointAsPosts, status)
	l.Fallback(ctx, "serve", EndpointAsPosts, status)
	now = now.Add(30 * time.Second) // one token back (2 per minute)
	l.Fallback(ctx, "serve", EndpointAsPosts, status)
	l.Fallback(ctx, "serve", EndpointAsPosts, status)
	lines = logLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("after 30 s: %d lines, want 1:\n%s", len(lines), buf.String())
	}
	// 3 dropped at the start, 2 more before the refill.
	checkLine(t, lines[0], map[string]any{"level": "INFO", "msg": "fallback", "mode": "serve", "endpoint": "as-posts",
		"reason": "feed-status", "detail": "503", "suppressed": float64(5)})
	buf.Reset()
	now = now.Add(30 * time.Second)
	l.Fallback(ctx, "serve", EndpointAsPosts, status)
	lines = logLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("after 60 s: %d lines, want 1", len(lines))
	}
	if _, ok := lines[0]["suppressed"]; !ok || lines[0]["suppressed"] != float64(1) {
		t.Fatalf("line after the refill: suppressed = %v, want 1 (the one dropped after the last line)", lines[0]["suppressed"])
	}

	// Errors: the default 60 per minute per key.
	buf.Reset()
	for range 61 {
		l.Error(ctx, slog.LevelWarn, "shadow compute failed", "shadow", EndpointInfinite, errors.New("x"))
	}
	if n := len(logLines(t, &buf)); n != 60 {
		t.Fatalf("%d error lines, want 60", n)
	}
}

// Past maxEventKeys, new keys share one overflow bucket per kind: memory stays bounded.
func TestEventLogKeysAreBounded(t *testing.T) {
	l := &EventLog{Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), FallbackPerMinute: 1}
	for i := range maxEventKeys + 50 {
		l.Fallback(context.Background(), "serve", EndpointAsPosts, fallback.New("r"+strconv.Itoa(i)))
	}
	if len(l.buckets) != maxEventKeys+1 {
		t.Fatalf("%d buckets, want %d (+1 overflow)", len(l.buckets), maxEventKeys)
	}
	if _, ok := l.buckets[eventKey{kind: eventFallback, reason: overflowReason}]; !ok {
		t.Fatal("no overflow bucket")
	}
}
