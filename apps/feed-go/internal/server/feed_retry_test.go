package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// retryFeed is the feed service failing its first `fail` calls with a refused connection, then
// answering an empty page; it counts the calls.
type retryFeed struct {
	mu    sync.Mutex
	fail  int
	calls int
}

func (f *retryFeed) Fetch(context.Context, string) (feedsvc.Answer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls <= f.fail {
		return feedsvc.Answer{}, errors.New("dial tcp: connection refused")
	}
	return feedsvc.Answer{Status: 200}, nil
}

// feedRetryCount reads feed_go_feed_retry_total{feed_endpoint="infinite",outcome}.
func feedRetryCount(t *testing.T, reg *prometheus.Registry, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_feed_retry_total", map[string]string{"feed_endpoint": "infinite", "outcome": outcome})
	return v
}

// The public image.getInfinite route end to end (the real compute, resolver and feed handler), for a
// signed-in viewer, whose failed feed call is the app's 503: with FEED_GO_INFINITE_ANSWER_FEED_UNAVAILABLE
// on, the call is made a second time here before that 503, as the app's own call after a hand-back
// would be. A second answer is served (recovered), a second failure is the 503 (failed). With a
// request budget shorter than one feed call (2 s against the client's 5 s) there is no second call
// here: the request is handed back, the app's call being the retry (handed_back). Off, there is one
// call and the request is handed back as before (the app makes the second), with no retry counted.
func TestServeInfiniteRetriesTheFeedCallBeforeThe503(t *testing.T) {
	const input = `{"json":{"browsingLevel":1,"sort":"Newest","limit":10}}`
	for _, c := range []struct {
		name        string
		answer      bool
		budget      time.Duration // 0: DefaultRequestBudget (6 s)
		fail        int
		wantCode    int
		wantCalls   int
		wantProxied int
		wantRetry   map[string]float64
		wantOutcome map[string]float64
	}{
		{"on, a failure then a page", true, 0, 1, http.StatusOK, 2, 0,
			map[string]float64{"recovered": 1, "failed": 0, "other": 0, "handed_back": 0},
			map[string]float64{"served_empty": 1, "feed_unavailable": 0, "fallback": 0}},
		{"on, two failures", true, 0, 2, http.StatusServiceUnavailable, 2, 0,
			map[string]float64{"recovered": 0, "failed": 1, "other": 0, "handed_back": 0},
			map[string]float64{"served_empty": 0, "feed_unavailable": 1, "fallback": 0}},
		{"off, a failure", false, 0, 1, http.StatusTeapot, 1, 1,
			map[string]float64{"recovered": 0, "failed": 0, "other": 0, "handed_back": 0},
			map[string]float64{"served_empty": 0, "feed_unavailable": 0, "fallback": 1}},
		{"on, a 2s budget: handed back", true, 2 * time.Second, 2, http.StatusTeapot, 1, 1,
			map[string]float64{"recovered": 0, "failed": 0, "other": 0, "handed_back": 1},
			map[string]float64{"served_empty": 0, "feed_unavailable": 0, "fallback": 1}},
	} {
		f := newComputeFixture(t)
		reg := prometheus.NewRegistry()
		rf := &retryFeed{fail: c.fail}
		f.s.Metrics = NewMetrics(reg)
		f.s.Deps.Feed = rf
		f.s.Infinite = &feed.InfiniteDeps{Deps: f.s.Deps}
		f.s.ServeInfinite = true
		f.s.AnswerInfiniteFeedUnavailable = c.answer
		f.s.RequestBudget = c.budget
		f.s.AllowedOrigins = allowed
		proxied := 0
		f.s.Fallback = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			proxied++
			w.WriteHeader(http.StatusTeapot)
		})
		r := regionRequest("/api/trpc/"+ProcedureInfinite+"?input="+url.QueryEscape(input), map[string]string{"cookie": "civ-token=" + f.token(t, 42)})
		r.Host = "green.example"
		w := httptest.NewRecorder()
		f.s.ServeInfiniteHTTP(w, r)
		if w.Code != c.wantCode {
			body, _ := io.ReadAll(w.Body)
			t.Errorf("%s: status %d (%s), want %d", c.name, w.Code, body, c.wantCode)
		}
		if rf.calls != c.wantCalls || proxied != c.wantProxied {
			t.Errorf("%s: feed calls %d, proxied %d, want %d, %d", c.name, rf.calls, proxied, c.wantCalls, c.wantProxied)
		}
		for o, want := range c.wantRetry {
			if v := feedRetryCount(t, reg, o); v != want {
				t.Errorf("%s: feed_go_feed_retry_total{%s} = %v, want %v", c.name, o, v, want)
			}
		}
		for o, want := range c.wantOutcome {
			if v := infiniteServeCount(t, reg, o); v != want {
				t.Errorf("%s: requests{outcome=%s} = %v, want %v", c.name, o, v, want)
			}
		}
	}
}

// feed_go_feed_retry_total exists at 0 for every retry outcome on the infinite route, and on no other
// route (only image.getInfinite retries).
func TestFeedRetryIsSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, o := range []string{"recovered", "failed", "other", "handed_back"} {
		if v, found := metricValue(t, reg, "feed_go_feed_retry_total", map[string]string{"feed_endpoint": "infinite", "outcome": o}); !found || v != 0 {
			t.Errorf("feed_retry{infinite,%s} = %v found=%v, want a 0 series", o, v, found)
		}
	}
	if !slices.Equal(feed.RetryOutcomes, []string{"recovered", "failed", "other", "handed_back"}) {
		t.Errorf("feed.RetryOutcomes = %v", feed.RetryOutcomes)
	}
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_feed_retry_total" {
			continue
		}
		if n := len(mf.GetMetric()); n != 4 {
			t.Errorf("feed_go_feed_retry_total has %d series, want 4", n)
		}
	}
}
