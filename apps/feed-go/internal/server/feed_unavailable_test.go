package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"syscall"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
)

// The app's answer to image.getInfinite when the feed call failed (answerWithoutFeed's
// SERVICE_UNAVAILABLE TRPCError), in a production build, derived from the app's code (see
// internal/trpc/apperror_test.go for where each part comes from): the status, every header but the
// transport ones, X-Handled-By (the app's pod name) and X-Feed-Go-Served, and the body in each write
// format.
var (
	feedUnavailableHeaders = map[string]string{
		"content-type":    "application/json",             // resolveResponse
		"vary":            "trpc-accept, accept",          // resolveResponse
		"cache-control":   "max-age=0, private, no-cache", // applyApiRequestPolicy's private default
		"x-frame-options": "DENY",                         // next.config.mjs headers(), on this route too
	}
	feedUnavailableSuperjson = `{"error":{"json":{"message":"Image search is temporarily overloaded — please retry.","code":-32603,"data":{"code":"SERVICE_UNAVAILABLE","httpStatus":503,"path":"image.getInfinite"}}}}`
	feedUnavailableDevalue   = `{"error":"[{\"message\":1,\"code\":2,\"data\":3},\"Image search is temporarily overloaded — please retry.\",-32603,{\"code\":4,\"httpStatus\":5,\"path\":6},\"SERVICE_UNAVAILABLE\",503,\"image.getInfinite\"]"}`
)

// feedUnavailableServer is a Server for the public image.getInfinite route whose compute ends in
// err, with a fallback that counts what it proxies (and answers 418). answer is
// AnswerInfiniteFeedUnavailable.
func feedUnavailableServer(reg *prometheus.Registry, answer bool, err error) (*Server, *proxyRecorder) {
	up := &proxyRecorder{}
	s := &Server{
		Metrics:                       NewMetrics(reg),
		Log:                           quietLog(),
		AllowedOrigins:                allowed,
		Fallback:                      up,
		ServeInfinite:                 true,
		AnswerInfiniteFeedUnavailable: answer,
	}
	s.computeInfiniteFn = func(context.Context, *http.Request) (*computed, error) { return nil, err }
	s.computeFn = func(context.Context, *http.Request) (*computed, error) { return nil, err }
	return s, up
}

func marked503() error {
	return &feed.UnavailableError{Fallback: fallback.Wrap("feed-unavailable", errors.New("dial tcp: connection refused"))}
}

func feedUnavailableOutcome(t *testing.T, reg *prometheus.Registry, endpoint string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": endpoint, "mode": "serve", "outcome": "feed_unavailable"})
	return v
}

// With FEED_GO_INFINITE_ANSWER_FEED_UNAVAILABLE on, a feed failure the app answers with its 503
// (feed.UnavailableError) gets that 503 from this service: status, headers and body as the app
// writes them, in the request's write format (superjson, or devalue for a capable web bundle with
// TRPC_WRITE_DEVALUE on), with X-Feed-Go-Served: go. Nothing is proxied, and it is counted as the
// feed_unavailable outcome, never as served nor as a fallback.
func TestAnswerInfiniteFeedUnavailableWritesNodes503(t *testing.T) {
	for _, c := range []struct {
		name         string
		writeDevalue bool
		headers      map[string]string
		body         string
	}{
		{"superjson", false, nil, feedUnavailableSuperjson},
		{"devalue switch on, a client that cannot read it", true, map[string]string{"x-client": "web", "x-client-version": "5.0.2079"}, feedUnavailableSuperjson},
		{"devalue", true, map[string]string{"x-client": "web", "x-client-version": "5.0.2080"}, feedUnavailableDevalue},
	} {
		reg := prometheus.NewRegistry()
		s, up := feedUnavailableServer(reg, true, marked503())
		s.WriteDevalue = c.writeDevalue
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest("/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", c.headers))
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status %d, want 503", c.name, w.Code)
		}
		if body, _ := io.ReadAll(w.Body); string(body) != c.body {
			t.Errorf("%s: body\n  %s\nwant\n  %s", c.name, body, c.body)
		}
		if got := responseHeaders(w.Header()); !maps.Equal(got, feedUnavailableHeaders) {
			t.Errorf("%s: headers %v, want %v", c.name, got, feedUnavailableHeaders)
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByGo {
			t.Errorf("%s: %s = %q, want %q", c.name, ServedByHeader, got, ServedByGo)
		}
		if up.calls != 0 {
			t.Errorf("%s: proxied %d, want 0", c.name, up.calls)
		}
		for outcome, want := range map[string]float64{"feed_unavailable": 1, "served": 0, "fallback": 0, "error": 0} {
			if v := infiniteServeCount(t, reg, outcome); v != want {
				t.Errorf("%s: requests{outcome=%s} = %v, want %v", c.name, outcome, v, want)
			}
		}
		if v := infiniteServeFallbacks(t, reg, "feed-unavailable"); v != 0 {
			t.Errorf("%s: feed-unavailable fallbacks = %v, want 0", c.name, v)
		}
	}
}

// Off (the default), the same failure is handed back as before: the `feed-unavailable` fallback,
// proxied to the app (which calls the feed again), X-Feed-Go-Served: node, no feed_unavailable outcome.
func TestAnswerInfiniteFeedUnavailableOffHandsBack(t *testing.T) {
	if (&Server{}).AnswerInfiniteFeedUnavailable {
		t.Fatal("AnswerInfiniteFeedUnavailable is on in a zero Server")
	}
	reg := prometheus.NewRegistry()
	s, up := feedUnavailableServer(reg, false, marked503())
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, regionRequest("/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", nil))
	if w.Code != http.StatusTeapot || up.calls != 1 {
		t.Fatalf("off: code=%d proxied=%d, want 418, 1", w.Code, up.calls)
	}
	if got := w.Header().Get(ServedByHeader); got != ServedByNode {
		t.Errorf("off: %s = %q, want %q", ServedByHeader, got, ServedByNode)
	}
	if v := infiniteServeFallbacks(t, reg, "feed-unavailable"); v != 1 {
		t.Errorf("off: feed-unavailable fallbacks = %v, want 1", v)
	}
	if v := feedUnavailableOutcome(t, reg, EndpointInfinite); v != 0 {
		t.Errorf("off: requests{outcome=feed_unavailable} = %v, want 0", v)
	}
}

// Control, switch on: a feed failure that is not marked (an anonymous first page, which the app may
// answer from its last-good page; a 4xx) and any other fallback are handed back as before, and the
// mark on another route (the gallery's) is not answered here.
func TestAnswerInfiniteFeedUnavailableOnlyForMarkedInfinite(t *testing.T) {
	for _, c := range []struct {
		name, path, reason string
		err                error
	}{
		{"an unmarked feed failure", "/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", "feed-unavailable", fallback.Wrap("feed-unavailable", errors.New("down"))},
		{"a feed refusal", "/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", "feed-status", fallback.Safef("feed-status", "%d", 400)},
		{"the mark on the gallery route", "/api/trpc/image.getImagesAsPostsInfinite?input=%7B%22json%22%3A%7B%7D%7D", "feed-unavailable", marked503()},
	} {
		reg := prometheus.NewRegistry()
		s, up := feedUnavailableServer(reg, true, c.err)
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest(c.path, nil))
		if w.Code != http.StatusTeapot || up.calls != 1 {
			t.Errorf("%s: code=%d proxied=%d, want 418, 1", c.name, w.Code, up.calls)
		}
		if v := fallbackCount(t, reg, c.reason); v != 1 {
			t.Errorf("%s: %s fallbacks = %v, want 1", c.name, c.reason, v)
		}
		for _, e := range []string{EndpointInfinite, EndpointAsPosts} {
			if v := feedUnavailableOutcome(t, reg, e); v != 0 {
				t.Errorf("%s: requests{%s,outcome=feed_unavailable} = %v, want 0", c.name, e, v)
			}
		}
	}
}

// feedUnavailableCauses is every feed_go_feed_unavailable_total series in reg, as
// "endpoint reason detail" -> value.
func feedUnavailableCauses(t *testing.T, reg *prometheus.Registry) map[string]float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]float64{}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_feed_unavailable_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			l := map[string]string{}
			for _, p := range m.GetLabel() {
				l[p.GetName()] = p.GetValue()
			}
			out[l[EndpointLabel]+" "+l["reason"]+" "+l["detail"]] = m.GetCounter().GetValue()
		}
	}
	return out
}

// The answered 503 records why the feed call failed, as the fallback it replaces would have
// (feed_go_fallback_total's reason plus the fallback's loggable detail), on
// feed_go_feed_unavailable_total{feed_endpoint, reason, detail}: a refused connection, the feed
// client's own timeout and a 5xx are three different series, so an outage can be told apart. The
// detail is bounded: a failed call's is one of fallback.ErrorClasses, a 5xx's its status, anything
// else `other`. With the switch off nothing is counted there (the fallback records it instead).
func TestAnswerInfiniteFeedUnavailableRecordsTheCause(t *testing.T) {
	refused := &url.Error{Op: "Get", URL: "http://feed.invalid/v1/feed", Err: &net.OpError{Op: "dial", Net: "tcp",
		Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}}
	timedOut := &url.Error{Op: "Get", URL: "http://feed.invalid/v1/feed", Err: context.DeadlineExceeded}
	mark := func(fb error) error { return &feed.UnavailableError{Fallback: fb} }
	for _, c := range []struct {
		name string
		err  error
		want string
	}{
		{"connection refused", mark(fallback.Wrap("feed-unavailable", refused)), "infinite feed-unavailable conn_refused"},
		{"the feed client's timeout", mark(fallback.Wrap("feed-unavailable", timedOut)), "infinite feed-unavailable deadline"},
		{"a body that is not JSON", mark(fallback.Wrap("feed-unavailable", &json.SyntaxError{})), "infinite feed-unavailable json"},
		{"a 503", mark(fallback.Safef("feed-status", "%d", 503)), "infinite feed-status 503"},
		{"a 502", mark(fallback.Safef("feed-status", "%d", 502)), "infinite feed-status 502"},
		{"a detail outside the classes", mark(fallback.Safef("feed-unavailable", "%s", "free text")), "infinite feed-unavailable other"},
		{"a status outside 5xx", mark(fallback.Safef("feed-status", "%d", 404)), "infinite feed-status other"},
		{"another reason", mark(fallback.Safef("feed-hydrate-error", "%s", "pg_57")), "infinite other other"},
	} {
		reg := prometheus.NewRegistry()
		s, _ := feedUnavailableServer(reg, true, c.err)
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest("/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", nil))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status %d, want 503", c.name, w.Code)
		}
		if got, want := feedUnavailableCauses(t, reg), map[string]float64{c.want: 1}; !maps.Equal(got, want) {
			t.Errorf("%s: feed_go_feed_unavailable_total %v, want %v", c.name, got, want)
		}
	}
	reg := prometheus.NewRegistry()
	s, _ := feedUnavailableServer(reg, false, mark(fallback.Wrap("feed-unavailable", refused)))
	PublicMux(s).ServeHTTP(httptest.NewRecorder(), regionRequest("/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", nil))
	if got := feedUnavailableCauses(t, reg); len(got) != 0 {
		t.Errorf("off: feed_go_feed_unavailable_total %v, want no series", got)
	}
	if v := infiniteServeFallbacks(t, reg, "feed-unavailable"); v != 1 {
		t.Errorf("off: feed-unavailable fallbacks = %v, want 1", v)
	}
}
