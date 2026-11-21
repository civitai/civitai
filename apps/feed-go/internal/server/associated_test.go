package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

const assocInput = `{"json":{"fromId":9001,"type":"Suggested","browsingLevel":1}}`

func postAssociated(t *testing.T, h http.Handler, node string) int {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{Input: assocInput, Headers: map[string]string{"host": "civitai.example"}, Node: json.RawMessage(node)})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+ProcedureAssociated, strings.NewReader(string(b))))
	return w.Code
}

// A model-associated sample reaches its compute through the internal route, is compared as a
// superjson envelope of an array, classified by card id, and counted under its own endpoint label.
func TestAssociatedShadowSample(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the gallery compute must not run for a model-associated sample")
		return nil, nil
	})
	var seen *http.Request
	s.computeAssociatedFn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = r
		return &computed{payload: []byte(`{"json":[{"id":5001,"name":"a"},{"id":5002,"name":"b"}]}`)}, nil
	}
	internal := InternalMux(s, okHandler(), false)
	result := func(r string) func() bool {
		return func() bool {
			v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAssociated, "result": r})
			return v == 1 && len(s.ShadowQueue) == 0
		}
	}
	if code := postAssociated(t, internal, `{"json":[{"id":5001,"name":"a"},{"id":5002,"name":"b"}]}`); code != http.StatusAccepted {
		t.Fatalf("code %d", code)
	}
	waitFor(t, "the match", result("match"))
	if seen == nil || seen.URL.Path != "/api/trpc/"+ProcedureAssociated || seen.URL.Query().Get("input") != assocInput || seen.Host != "civitai.example" {
		t.Fatalf("synthetic request = %+v", seen)
	}
	postAssociated(t, internal, `{"json":[{"id":5002,"name":"b"},{"id":5001,"name":"a"}]}`)
	waitFor(t, "the order diff", result("order"))
	postAssociated(t, internal, `{"json":[{"id":5001,"name":"a"}]}`)
	waitFor(t, "the membership diff", result("membership"))
	postAssociated(t, internal, `{"json":[{"id":5001,"name":"a"},{"id":5002,"name":"c"}]}`)
	waitFor(t, "the fields diff", result("fields"))
	if n, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointAssociated, "category": "*.name", "kind": "value"}); n < 1 {
		t.Fatalf("*.name diffs = %v", n)
	}
	if code := statusOf(PublicMux(s), "/api/trpc/"+ProcedureAssociated); code != http.StatusNotFound {
		t.Fatalf("public route for the procedure: %d, want 404 (shadow only)", code)
	}
}

// Without deps every sample is the `model-assoc-unconfigured` fallback (the real compute ran).
func TestAssociatedShadowWithoutDepsFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	s.ShadowAssociatedHandler(httptest.NewRecorder(), func() *http.Request {
		b, _ := json.Marshal(ShadowRequest{Input: assocInput, Node: json.RawMessage(`{"json":[]}`)})
		return httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(string(b)))
	}())
	waitFor(t, "the unsupported result", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAssociated, "result": "unsupported"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointAssociated, "mode": "shadow", "reason": "model-assoc-unconfigured"}); n != 1 {
		t.Fatalf("fallback = %v, want 1", n)
	}
}

// computeAssociated's own refusals, before any store is read.
func TestComputeAssociatedRefusals(t *testing.T) {
	s := &Server{Associated: &modelfeed.AssocDeps{}}
	req := func(method, input string, headers map[string]string) *http.Request {
		r, err := SyntheticAssociatedRequest(context.Background(), ShadowRequest{Input: input, Headers: headers})
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
		{req(http.MethodPost, assocInput, nil), "method"},
		{req(http.MethodGet, `nope`, nil), "input-envelope"},
		{req(http.MethodGet, `{"json":{"fromId":1}}`, nil), "input-invalid"},
		{req(http.MethodGet, assocInput, map[string]string{verifiedBotHeader: "googlebot"}), "verified-bot"},
	} {
		_, err := s.computeAssociated(context.Background(), c.r)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s %s: %q (%v), want %q", c.r.Method, c.r.URL.RawQuery, got, err, c.reason)
		}
	}
	if _, err := (&Server{}).computeAssociated(context.Background(), req(http.MethodGet, assocInput, nil)); fallback.Reason(err) != "model-assoc-unconfigured" {
		t.Fatalf("no deps: %v", err)
	}
}

// The whole compute over a source with no associations: an empty array, cacheable signed out (the
// public TTL), not for a session; a banned session falls back; the viewer and cap reach the handler.
func TestComputeAssociatedAnswerAndCachePolicy(t *testing.T) {
	var sourceArgs []any
	db := &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "Model" WHERE "id" = $1`, Rows: func(args []any) (*testkit.Rows, error) {
			sourceArgs = args
			return testkit.NewRows([]string{"poi", "userId"}, []any{true, 1001}), nil
		}},
		{Match: `FROM "ModelAssociations"`, Rows: func([]any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"toModelId", "toArticleId"}), nil
		}},
	}}
	s := &Server{Associated: &modelfeed.AssocDeps{Deps: &modelfeed.Deps{DB: db}, Promotions: feed.PromotionsOff}}
	run := func(user *auth.SessionUser) (*computed, error) {
		r, err := SyntheticAssociatedRequest(context.Background(), ShadowRequest{Input: assocInput, Headers: map[string]string{"host": "civitai.example"}})
		if err != nil {
			t.Fatal(err)
		}
		return s.computeAssociated(auth.WithResolved(context.Background(), user, nil), r)
	}
	// Signed out, the source is a POI model: hidden.
	if _, err := run(nil); fallback.Reason(err) != "model-assoc-source-hidden" {
		t.Fatalf("signed out, poi source: %v", err)
	}
	if len(sourceArgs) != 1 || sourceArgs[0] != 9001 {
		t.Fatalf("source read args %v", sourceArgs)
	}
	// Its owner: served, empty, no TTL for a session.
	c, err := run(&auth.SessionUser{ID: 1001})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if string(c.payload) != `{"json":[]}` || !c.trivial || c.ttl != nil {
		t.Fatalf("owner answer %s trivial=%v ttl=%v", c.payload, c.trivial, c.ttl)
	}
	c.release()
	// A moderator does not read the source; banned falls back.
	if c, err = run(&auth.SessionUser{ID: 1004, IsModerator: true}); err != nil {
		t.Fatalf("moderator: %v", err)
	}
	c.release()
	if _, err := run(&auth.SessionUser{ID: 1003, Banned: true}); fallback.Reason(err) != "model-assoc-banned-session" {
		t.Fatalf("banned: %v", err)
	}
	// Signed out over a source that is not POI: the public TTL.
	db.Routes[0].Rows = func([]any) (*testkit.Rows, error) {
		return testkit.NewRows([]string{"poi", "userId"}, []any{false, 1001}), nil
	}
	c, err = run(nil)
	if err != nil {
		t.Fatalf("signed out: %v", err)
	}
	if c.ttl == nil || *c.ttl != trpc.SignedOutTTL {
		t.Fatalf("signed out ttl %v, want the public TTL", c.ttl)
	}
	c.release()
}
