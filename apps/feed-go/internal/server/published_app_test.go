package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/appchip"
	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const pubAppInput = `{"json":{"id":8101}}`

func postPublishedApp(t *testing.T, h http.Handler, node string) int {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{Input: pubAppInput, Headers: map[string]string{"host": "civitai.example"}, Node: json.RawMessage(node)})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+ProcedurePublishedApp, strings.NewReader(string(b))))
	return w.Code
}

// An image-published-app sample reaches its own compute through the internal route, is compared as a
// superjson envelope of one value and counted under its own endpoint label: null against null is a
// match, null against Node's chip is `fields` (a root `type` difference). No public route.
func TestPublishedAppShadowSample(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the gallery compute must not run for an image-published-app sample")
		return nil, nil
	})
	s.computeAssociatedFn = func(context.Context, *http.Request) (*computed, error) {
		t.Error("the model-associated compute must not run for an image-published-app sample")
		return nil, nil
	}
	var seen *http.Request
	s.computePublishedAppFn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = r
		return &computed{payload: []byte(`{"json":null}`), viewerClass: appchip.ViewerAnon}, nil
	}
	internal := InternalMux(s, okHandler(), false)
	result := func(r string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "result": r})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	if code := postPublishedApp(t, internal, `{"json":null}`); code != http.StatusAccepted {
		t.Fatalf("code %d", code)
	}
	waitFor(t, "the match", result("match"))
	if seen == nil || seen.URL.Path != "/api/trpc/"+ProcedurePublishedApp || seen.URL.Query().Get("input") != pubAppInput || seen.Host != "civitai.example" {
		t.Fatalf("synthetic request = %+v", seen)
	}
	postPublishedApp(t, internal, `{"json":{"slug":"sketchpad","name":"Sketchpad","iconUrl":null}}`)
	waitFor(t, "the fields diff", result("fields"))
	if n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "category": "", "kind": "type"}); n != 1 {
		t.Fatalf("root type diffs = %v, want 1", n)
	}
	if code := statusOf(PublicMux(s), "/api/trpc/"+ProcedurePublishedApp); code != http.StatusNotFound {
		t.Fatalf("public route for the procedure: %d, want 404 (shadow only)", code)
	}
}

// classifyValue: match, else fields, whatever the item-order classifiers would read.
func TestClassifyValue(t *testing.T) {
	for _, c := range []struct{ g, n, want string }{
		{`{"json":null}`, `{"json":null}`, "match"},
		{`{"json":null}`, `{"json":{"slug":null,"name":"Sketchpad","iconUrl":null}}`, "fields"},
		{`{"json":{"slug":"a","name":"A","iconUrl":null}}`, `{"json":{"slug":"b","name":"A","iconUrl":null}}`, "fields"},
	} {
		s := newPhaseServer(prometheus.NewRegistry(), 1, nil)
		_, _, classify, ok := s.publishedAppRoute(EndpointPublishedApp)
		if !ok {
			t.Fatal("no route for the endpoint")
		}
		r, err := shadow.Compare([]byte(c.g), []byte(c.n))
		if err != nil {
			t.Fatal(err)
		}
		if got := classify(r, []byte(c.g), []byte(c.n)); got != c.want {
			t.Errorf("%s vs %s: %q, want %q", c.g, c.n, got, c.want)
		}
	}
	if _, _, _, ok := (&Server{}).publishedAppRoute(EndpointAssociated); ok {
		t.Fatal("the route answered another endpoint")
	}
}

// Without deps every sample is the `published-app-unconfigured` fallback (the real compute ran).
func TestPublishedAppShadowWithoutDepsFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	s.ShadowPublishedAppHandler(httptest.NewRecorder(), func() *http.Request {
		b, _ := json.Marshal(ShadowRequest{Input: pubAppInput, Node: json.RawMessage(`{"json":null}`)})
		return httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(string(b)))
	}())
	waitFor(t, "the unsupported result", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "result": "unsupported"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "mode": "shadow", "reason": "published-app-unconfigured"}); n != 1 {
		t.Fatalf("fallback = %v, want 1", n)
	}
}

// computePublishedApp's own refusals, before any store is read.
func TestComputePublishedAppRefusals(t *testing.T) {
	db := &testkit.DB{}
	s := &Server{PublishedApp: &appchip.Deps{DB: db}, Resolver: &auth.Resolver{}}
	req := func(method, input string, headers map[string]string) *http.Request {
		r, err := SyntheticPublishedAppRequest(context.Background(), ShadowRequest{Input: input, Headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		r.Method = method
		return r
	}
	for _, c := range []struct {
		r      *http.Request
		reason string
	}{
		{req(http.MethodPost, pubAppInput, nil), "method"},
		{req(http.MethodGet, `nope`, nil), "input-envelope"},
		{req(http.MethodGet, `{"json":{}}`, nil), "input-invalid"},
		{req(http.MethodGet, `{"json":{"id":8101,"postId":1}}`, nil), "input-unknown-key"},
		{req(http.MethodGet, pubAppInput, map[string]string{verifiedBotHeader: "googlebot"}), "verified-bot"},
		// The sampler forwards an API credential only as the literal `present`.
		{req(http.MethodGet, pubAppInput, map[string]string{"authorization": "present"}), "bearer-token"},
	} {
		_, err := s.computePublishedApp(context.Background(), c.r)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s %s %v: %q (%v), want %q", c.r.Method, c.r.URL.RawQuery, c.r.Header, got, err, c.reason)
		}
	}
	if len(db.Calls) != 0 {
		t.Fatalf("a refused request read the database: %v", db.Calls)
	}
	if _, err := (&Server{}).computePublishedApp(context.Background(), req(http.MethodGet, pubAppInput, nil)); fallback.Reason(err) != "published-app-unconfigured" {
		t.Fatalf("no deps: %v", err)
	}
}

// The whole compute: null, cacheable signed out (the public TTL), not for a session; written as
// superjson for a sample, and as devalue for a marked public request only where the answer is not
// edge-cacheable (computed.encode); a banned session falls back.
func TestComputePublishedAppAnswerAndCachePolicy(t *testing.T) {
	db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "Image" WHERE "id" = $1`, Rows: func([]any) (*testkit.Rows, error) {
		return testkit.NewRows([]string{"userId", "marker"}, []any{1001, nil}), nil
	}}}}
	s := &Server{PublishedApp: &appchip.Deps{DB: db}}
	run := func(ctx context.Context, user *auth.SessionUser) (*computed, error) {
		r, err := SyntheticPublishedAppRequest(ctx, ShadowRequest{Input: pubAppInput, Headers: map[string]string{"host": "civitai.example"}})
		if err != nil {
			t.Fatal(err)
		}
		return s.computePublishedApp(auth.WithResolved(ctx, user, nil), r)
	}
	c, err := run(context.Background(), nil)
	if err != nil {
		t.Fatalf("signed out: %v", err)
	}
	if string(c.payload) != `{"json":null}` || c.ttl == nil || *c.ttl != trpc.SignedOutTTL || c.viewerClass != "anon" || c.trivial || c.devalue {
		t.Fatalf("signed out: %s ttl=%v class=%q trivial=%v devalue=%v", c.payload, c.ttl, c.viewerClass, c.trivial, c.devalue)
	}
	c.release()
	c, err = run(context.Background(), &auth.SessionUser{ID: 1001})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if string(c.payload) != `{"json":null}` || c.ttl != nil || c.viewerClass != "owner" {
		t.Fatalf("owner: %s ttl=%v class=%q", c.payload, c.ttl, c.viewerClass)
	}
	c.release()
	// A request marked for devalue: the session's answer is devalue, the signed-out one stays superjson.
	c, err = run(trpc.WithDevalueWrite(context.Background()), &auth.SessionUser{ID: 1002})
	if err != nil {
		t.Fatalf("devalue, user: %v", err)
	}
	if !c.devalue || string(c.payload) != `"[null]"` || c.viewerClass != "user" {
		t.Fatalf("devalue, user: %s devalue=%v class=%q", c.payload, c.devalue, c.viewerClass)
	}
	c.release()
	c, err = run(trpc.WithDevalueWrite(context.Background()), nil)
	if err != nil {
		t.Fatalf("devalue, signed out: %v", err)
	}
	if c.devalue || string(c.payload) != `{"json":null}` {
		t.Fatalf("devalue, signed out: %s devalue=%v", c.payload, c.devalue)
	}
	c.release()
	if _, err := run(context.Background(), &auth.SessionUser{ID: 1003, Banned: true}); fallback.Reason(err) != "published-app-banned-session" {
		t.Fatalf("banned: %v", err)
	}
	// A moderator's class, from the session.
	if c, err = run(context.Background(), &auth.SessionUser{ID: 1004, IsModerator: true}); err != nil || c.viewerClass != "moderator" {
		t.Fatalf("moderator: %v %+v", err, c)
	}
	c.release()
}

// Each compared image-published-app sample is also counted under its viewer class; the classes start
// at 0.
func TestPublishedAppViewerClassCounted(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 2, nil)
	for _, v := range []string{"anon", "user", "owner", "moderator"} {
		if n, found := metricValue(t, reg, "feed_go_shadow_compare_viewer_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "viewer": v, "result": "match"}); !found || n != 0 {
			t.Fatalf("viewer %s: %v found=%v, want a 0 series", v, n, found)
		}
	}
	class := "owner"
	s.computePublishedAppFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"json":null}`), viewerClass: class}, nil
	}
	internal := InternalMux(s, okHandler(), false)
	postPublishedApp(t, internal, `{"json":null}`)
	waitFor(t, "the owner match", func() bool {
		n, _ := metricValue(t, reg, "feed_go_shadow_compare_viewer_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "viewer": "owner", "result": "match"})
		return n == 1 && len(s.ShadowQueue) == 0
	})
	class = "user"
	postPublishedApp(t, internal, `{"json":{"slug":null,"name":"Sketchpad","iconUrl":null}}`)
	waitFor(t, "the user fields", func() bool {
		n, _ := metricValue(t, reg, "feed_go_shadow_compare_viewer_total", map[string]string{"feed_endpoint": EndpointPublishedApp, "viewer": "user", "result": "fields"})
		return n == 1 && len(s.ShadowQueue) == 0
	})
}
