package v1models

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The expected request bodies below are resolveModelSearchIds' options (src/server/services/
// model-search.service.ts) for these inputs, written out by hand from that code: `{ q, offset:
// queryOffset || undefined, limit: limit + 1, filter: [nsfwLevel IN [instanceToArray], type IN […],
// inArray('versions.baseModel', …)], attributesToRetrieve: ['id'], sort? }`, as JSON.stringify writes
// it. The golden fixtures (list-query-*) pin the same call from the running Node code.
func TestSearchRequestIsNodesCall(t *testing.T) {
	for _, c := range []struct {
		query string
		level int
		want  string
	}{
		{"query=golden", browsing.PublicLevels,
			`{"q":"golden","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"]}`},
		// The schema default sort is not sent; a named one is (Highest Rated and Most Liked alike).
		{"query=a&sort=Highest%20Rated&limit=3", browsing.SFWLevels,
			`{"q":"a","limit":4,"filter":["nsfwLevel IN [1,2]"],"attributesToRetrieve":["id"],"sort":["metrics.thumbsUpCount:desc","id:desc"]}`},
		{"query=a&sort=Most%20Images", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"]}`},
		{"query=a%22b&cursor=40&limit=20&sort=Oldest&types=LORA&types=Checkpoint&baseModels=SDXL%201.0&baseModels=a%5C%22b", browsing.AllLevels,
			`{"q":"a\"b","offset":40,"limit":21,"filter":["nsfwLevel IN [1,2,4,8,16]","type IN [LORA,Checkpoint]","versions.baseModel IN [\"SDXL 1.0\", \"a\\\\\\\"b\"]"],"attributesToRetrieve":["id"],"sort":["createdAt:asc","id:desc"]}`},
		// A zero offset is `queryOffset || undefined`: left out.
		{"query=a&cursor=0&sort=Most%20Downloaded", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"],"sort":["metrics.downloadCount:desc","id:desc"]}`},
		{"query=a&sort=Most%20Discussed", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"],"sort":["metrics.commentCount:desc","id:desc"]}`},
		{"query=a&sort=Most%20Collected&sort=", browsing.PublicLevels, ""},
		{"query=a&sort=Most%20Collected", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"],"sort":["metrics.collectedCount:desc","id:desc"]}`},
		{"query=a&sort=Newest&sort=Hot", browsing.PublicLevels, ""},
		{"query=a&sort=Newest", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"],"sort":["createdAt:desc","id:desc"]}`},
		{"query=a&sort=Hot", browsing.PublicLevels,
			`{"q":"a","limit":101,"filter":["nsfwLevel IN [1]"],"attributesToRetrieve":["id"]}`},
	} {
		in, err := ParseList(c.query)
		if c.want == "" {
			if err == nil {
				t.Errorf("%s: parsed, want a fallback", c.query)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v (%s)", c.query, err, reason(err))
		}
		req := searchRequest(in, c.level)
		if req.Index != "models_v9" {
			t.Errorf("%s: index %q", c.query, req.Index)
		}
		body, err := req.Body()
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != c.want {
			t.Errorf("%s:\n got  %s\n want %s", c.query, body, c.want)
		}
	}
}

func TestLevelValues(t *testing.T) {
	for level, want := range map[int][]string{
		1: {"1"}, 3: {"1", "2"}, 31: {"1", "2", "4", "8", "16"}, 20: {"4", "16"}, 0: nil,
	} {
		if got := levelValues(level); !reflect.DeepEqual(got, want) {
			t.Errorf("%d: %v, want %v", level, got, want)
		}
	}
}

// The client calls the search backend as meilisearch-js does: POST `<host>/indexes/<uid>/search`
// (the host's own path kept, `http://` added when it has no protocol), the key as a bearer, the body
// of SearchRequest.Body; it reads each hit's integer id in order.
func TestMeiliClientSearch(t *testing.T) {
	var got struct {
		method, path, auth, ctype string
		body                      map[string]any
	}
	reply := `{"hits":[{"id":12},{"id":7},{"id":30}],"query":"x","processingTimeMs":1,"limit":3,"offset":0}`
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path, got.auth, got.ctype = r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		got.body = nil
		_ = json.Unmarshal(raw, &got.body)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://") + "/meili"
	c, err := NewMeiliClient(host, "secret-key", 0)
	if err != nil {
		t.Fatal(err)
	}
	req := SearchRequest{Index: ModelsSearchIndex, Query: "x", Offset: 5, Limit: 3, Filter: []string{"nsfwLevel IN [1]"}}
	ids, err := c.SearchModelIDs(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []int{12, 7, 30}) {
		t.Errorf("ids %v", ids)
	}
	if got.method != http.MethodPost || got.path != "/meili/indexes/models_v9/search" ||
		got.auth != "Bearer secret-key" || got.ctype != "application/json" {
		t.Errorf("request %+v", got)
	}
	wantBody := map[string]any{
		"q": "x", "offset": float64(5), "limit": float64(3), "filter": []any{"nsfwLevel IN [1]"},
		"attributesToRetrieve": []any{"id"},
	}
	if !reflect.DeepEqual(got.body, wantBody) {
		t.Errorf("body %v, want %v", got.body, wantBody)
	}

	// No key: no Authorization header (meilisearch-js sends none).
	nokey, _ := NewMeiliClient(srv.URL, "", 0)
	if _, err := nokey.SearchModelIDs(context.Background(), req); err != nil || got.auth != "" || got.path != "/indexes/models_v9/search" {
		t.Errorf("no key: %v auth %q path %q", err, got.auth, got.path)
	}

	// Every answer that is not a 2xx search response with integer ids is an error.
	for _, c2 := range []struct {
		status int
		reply  string
	}{
		{http.StatusServiceUnavailable, `{"hits":[]}`},
		{http.StatusBadRequest, `{"message":"bad filter"}`},
		{http.StatusOK, `{"message":"no hits"}`},
		{http.StatusOK, `not json`},
		{http.StatusOK, `{"hits":[{"id":"12"}]}`},
		{http.StatusOK, `{"hits":[{"id":1.5}]}`},
		{http.StatusOK, `{"hits":[{"name":"x"}]}`},
		{http.StatusOK, `{"hits":[{"id":0}]}`},
	} {
		status, reply = c2.status, c2.reply
		if ids, err := c.SearchModelIDs(context.Background(), req); err == nil {
			t.Errorf("%d %s: ids %v, want an error", c2.status, c2.reply, ids)
		}
	}
	// An empty hit list is an answer: no result.
	status, reply = http.StatusOK, `{"hits":[]}`
	if ids, err := c.SearchModelIDs(context.Background(), req); err != nil || len(ids) != 0 {
		t.Errorf("no hits: %v %v", ids, err)
	}

	if _, err := NewMeiliClient("  ", "k", 0); err == nil {
		t.Error("an empty host is refused")
	}
}

// fakeSearcher answers every search with its ids and records the requests.
type fakeSearcher struct {
	ids  []int
	err  error
	reqs []SearchRequest
}

func (f *fakeSearcher) SearchModelIDs(_ context.Context, req SearchRequest) ([]int, error) {
	f.reqs = append(f.reqs, req)
	return f.ids, f.err
}

// A text query is answered only with a search backend, and serving only with ServeQuery; a failed
// search falls back.
func TestServeListTextQueryGate(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		name    string
		search  *fakeSearcher
		serve   bool
		serving bool
		reason  string
	}{
		{"no search backend (sample)", nil, true, false, "v1-models-query"},
		{"no search backend (serving)", nil, true, true, "v1-models-query"},
		{"serving with the switch off", &fakeSearcher{}, false, true, "v1-models-query"},
		{"a failed search", &fakeSearcher{err: io.ErrUnexpectedEOF}, true, true, "v1-models-query-search-failed"},
		{"a sample with the switch off is computed", &fakeSearcher{}, false, false, ""},
		{"serving with the switch on", &fakeSearcher{}, true, true, ""},
	} {
		d := newTestWorld().deps(t)
		if c.search != nil {
			d.Search = c.search
		}
		d.Config.ServeQuery = c.serve
		ans, err := ServeList(ctx, d, nil, ListRequest{Query: "query=golden", Path: "/api/v1/models", Host: "site.example.test", Serving: c.serving})
		if reason(err) != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, reason(err), err, c.reason)
			continue
		}
		if c.reason == "" {
			if !ans.Trivial || len(c.search.reqs) != 1 {
				t.Errorf("%s: %+v, %d searches", c.name, ans, len(c.search.reqs))
			}
		}
		if c.search != nil && c.reason == "v1-models-query" && len(c.search.reqs) != 0 {
			t.Errorf("%s: searched %d times", c.name, len(c.search.reqs))
		}
	}
}

// The search's order is the answer's; a hit the statement did not return is left out, a row the
// search did not name too.
func TestInSearchOrder(t *testing.T) {
	mk := func(id int) *item { return &item{base: superjson.Object{{Key: "id", Val: int64(id)}}} }
	items := []*item{mk(1), mk(2), mk(3)}
	got := inSearchOrder([]int{3, 9, 1}, items)
	if len(got) != 2 || got[0] != items[2] || got[1] != items[0] {
		t.Errorf("order %v", got)
	}
}

// slowSearch is a search backend that answers no call before its client gives up (or release is
// closed), counting the calls that reached it.
type slowSearch struct {
	srv     *httptest.Server
	calls   atomic.Int64
	arrived chan struct{}
	release chan struct{}
}

func newSlowSearch(t *testing.T) *slowSearch {
	s := &slowSearch{arrived: make(chan struct{}, 64), release: make(chan struct{})}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		s.arrived <- struct{}{}
		select {
		case <-s.release:
			_, _ = io.WriteString(w, `{"hits":[]}`)
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	t.Cleanup(func() {
		select {
		case <-s.release:
		default:
			close(s.release)
		}
		s.srv.Close()
	})
	return s
}

// The search circuit (the Node app's `search` breaker, at its defaults): ten calls that run out the
// client's bound open it, and the next text query is handed back at once as `v1-models-query`, with
// no call made, where it would otherwise wait out the bound again and fall back as a failed search.
func TestMeiliClientCircuitOpensAndHandsBack(t *testing.T) {
	s := newSlowSearch(t)
	mcl, err := NewMeiliClient(s.srv.URL, "", 30*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	d := newTestWorld().deps(t)
	d.Search = mcl
	d.Config.ServeQuery = true
	serve := func() (time.Duration, string) {
		start := time.Now()
		_, err := ServeList(context.Background(), d, nil, ListRequest{Query: "query=golden", Path: "/api/v1/models", Host: "site.example.test", Serving: true})
		return time.Since(start), reason(err)
	}
	for i := range 10 {
		if _, r := serve(); r != "v1-models-query-search-failed" {
			t.Fatalf("call %d: %q, want v1-models-query-search-failed (a timed-out search)", i, r)
		}
	}
	if n := s.calls.Load(); n != 10 {
		t.Fatalf("%d calls reached the backend, want 10", n)
	}
	took, r := serve()
	if r != "v1-models-query" {
		t.Errorf("with the circuit open: %q, want v1-models-query", r)
	}
	if n := s.calls.Load(); n != 10 {
		t.Errorf("with the circuit open %d calls reached the backend, want 10 (none made)", n)
	}
	if took >= 30*time.Millisecond {
		t.Errorf("with the circuit open the hand-back took %v, at least the search bound", took)
	}
}

// The concurrency cap: with SearchConcurrency calls in flight, the next text query is handed back
// at once as `v1-models-query`, with no call made, where it would otherwise hold its serve slot for
// the whole search bound. A slot comes back when its call ends.
func TestMeiliClientConcurrencyCapHandsBack(t *testing.T) {
	s := newSlowSearch(t)
	mcl, err := NewMeiliClient(s.srv.URL, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	req := SearchRequest{Index: ModelsSearchIndex, Query: "x", Limit: 2}
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = mcl.SearchModelIDs(context.Background(), req)
		}()
	}
	for i := range 4 {
		select {
		case <-s.arrived:
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d of 4 calls reached the backend", i)
		}
	}
	d := newTestWorld().deps(t)
	d.Search = mcl
	d.Config.ServeQuery = true
	list := ListRequest{Query: "query=golden", Path: "/api/v1/models", Host: "site.example.test", Serving: true}
	start := time.Now()
	_, err = ServeList(context.Background(), d, nil, list)
	took := time.Since(start)
	if reason(err) != "v1-models-query" {
		t.Errorf("past the cap: %q (%v), want v1-models-query", reason(err), err)
	}
	if took >= time.Second {
		t.Errorf("past the cap the hand-back took %v", took)
	}
	if n := s.calls.Load(); n != 4 {
		t.Errorf("past the cap %d calls reached the backend, want 4", n)
	}
	close(s.release)
	wg.Wait()
	if ans, err := ServeList(context.Background(), d, nil, list); err != nil || !ans.Trivial {
		t.Errorf("after the calls ended: %+v %v (%s), want the empty page", ans, err, reason(err))
	}
	if n := s.calls.Load(); n != 5 {
		t.Errorf("after the calls ended %d calls reached the backend, want 5", n)
	}
}

// A slow search whose caller goes away (a gone client, the request budget, a shadow sample's bound)
// ends with its caller, gives its slot back and is not counted toward the circuit: more such calls
// than the trip threshold leave it closed and the cap free.
func TestMeiliClientCallerCancelIsNotAFailure(t *testing.T) {
	s := newSlowSearch(t)
	mcl, err := NewMeiliClient(s.srv.URL, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	req := SearchRequest{Index: ModelsSearchIndex, Query: "x", Limit: 2}
	for i := range DefaultCircuitTripThreshold + 2 {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		start := time.Now()
		_, err := mcl.SearchModelIDs(ctx, req)
		cancel()
		if err == nil || errors.Is(err, ErrSearchRejected) {
			t.Fatalf("call %d: %v, want the caller's cancellation", i, err)
		}
		if took := time.Since(start); took >= DefaultSearchTimeout {
			t.Fatalf("call %d took %v: it did not end with its caller", i, took)
		}
	}
	close(s.release)
	if _, err := mcl.SearchModelIDs(context.Background(), req); err != nil {
		t.Errorf("after %d cancelled calls: %v, want the call made", DefaultCircuitTripThreshold+2, err)
	}
	if n := s.calls.Load(); n != DefaultCircuitTripThreshold+3 {
		t.Errorf("%d calls reached the backend, want %d", n, DefaultCircuitTripThreshold+3)
	}
}

// The bound is MEILI_CALL_TIMEOUT_MS up to MaxSearchTimeout, and the transport keeps as many idle
// connections as calls may be in flight.
func TestMeiliClientTimeoutCapAndIdleConns(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{
		0: 2500 * time.Millisecond, 800 * time.Millisecond: 800 * time.Millisecond,
		10 * time.Second: 2500 * time.Millisecond,
	} {
		c, err := NewMeiliClient("search.example.test", "", in)
		if err != nil {
			t.Fatal(err)
		}
		if c.http.Timeout != want {
			t.Errorf("timeout %v: bound %v, want %v", in, c.http.Timeout, want)
		}
		if n := c.http.Transport.(*http.Transport).MaxIdleConnsPerHost; n != 4 {
			t.Errorf("MaxIdleConnsPerHost %d, want 4", n)
		}
	}
}

// The circuit's states, on a clock of its own: threshold counted failures within the window open it
// (older ones are forgotten); open, it rejects until the cooldown ends; then one trial is admitted
// while the others are rejected, and the trial's outcome closes or reopens it.
func TestSearchCircuitStates(t *testing.T) {
	c := &circuit{threshold: 3, window: 10 * time.Second, cooldown: 5 * time.Second}
	t0 := time.Unix(1_000_000, 0)
	fail := func(at time.Time) {
		ok, trial := c.admit(at)
		if !ok || trial {
			t.Fatalf("at %v: admitted %v trial %v, want a plain call", at.Sub(t0), ok, trial)
		}
		c.record(at, false, true)
	}
	fail(t0)
	fail(t0.Add(time.Second))
	// The first failure leaves the window before the third arrives: still closed.
	fail(t0.Add(11 * time.Second))
	if c.state != circuitClosed {
		t.Fatalf("state %v after failures spread past the window", c.state)
	}
	fail(t0.Add(12 * time.Second))
	if c.state != circuitClosed {
		t.Fatalf("state %v with 2 failures in the window, want closed", c.state)
	}
	fail(t0.Add(13 * time.Second))
	if c.state != circuitOpen {
		t.Fatalf("state %v after 3 failures in the window, want open", c.state)
	}
	if ok, _ := c.admit(t0.Add(17 * time.Second)); ok {
		t.Error("admitted inside the cooldown")
	}
	ok, trial := c.admit(t0.Add(18 * time.Second))
	if !ok || !trial {
		t.Fatalf("after the cooldown: admitted %v trial %v, want the trial", ok, trial)
	}
	if ok, _ := c.admit(t0.Add(18 * time.Second)); ok {
		t.Error("a second call admitted while the trial is in flight")
	}
	c.record(t0.Add(19*time.Second), true, true)
	if c.state != circuitOpen {
		t.Fatalf("state %v after a failed trial, want open", c.state)
	}
	if ok, _ := c.admit(t0.Add(23 * time.Second)); ok {
		t.Error("admitted inside the second cooldown")
	}
	ok, trial = c.admit(t0.Add(24 * time.Second))
	if !ok || !trial {
		t.Fatalf("after the second cooldown: admitted %v trial %v", ok, trial)
	}
	// A trial that could not be made gives the trial back.
	c.abandonTrial()
	ok, trial = c.admit(t0.Add(24 * time.Second))
	if !ok || !trial {
		t.Fatalf("after an abandoned trial: admitted %v trial %v", ok, trial)
	}
	c.record(t0.Add(25*time.Second), true, false)
	if c.state != circuitClosed || len(c.failures) != 0 {
		t.Fatalf("after a good trial: state %v, %d failures, want closed with none", c.state, len(c.failures))
	}
	if ok, trial := c.admit(t0.Add(25 * time.Second)); !ok || trial {
		t.Errorf("closed again: admitted %v trial %v", ok, trial)
	}
}

// Only a call that ran out its own bound counts toward the circuit.
func TestCountedFailure(t *testing.T) {
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	timeout := &url.Error{Op: "Post", URL: "u", Err: timeoutErr{}}
	for _, c := range []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"success", context.Background(), nil, false},
		{"own timeout", context.Background(), timeout, true},
		{"a timeout with the caller gone", gone, timeout, false},
		{"a fast error", context.Background(), errors.New("search: status 503"), false},
	} {
		if got := countedFailure(c.ctx, c.err); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string { return "timeout" }
func (timeoutErr) Timeout() bool { return true }
