package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/content-policy-go/internal/metrics"
	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// fakeUsers answers from a map, or errs, or blocks until the context ends, or panics.
type fakeUsers struct {
	users map[int64]policy.User
	hit   bool
	err   error
	block bool
	panic bool
	calls int
}

func (f *fakeUsers) Lookup(ctx context.Context, id int64) (policy.User, bool, bool, error) {
	f.calls++
	if f.panic {
		panic("boom")
	}
	if f.block {
		<-ctx.Done()
		return policy.User{}, false, false, ctx.Err()
	}
	if f.err != nil {
		return policy.User{}, false, false, f.err
	}
	u, ok := f.users[id]
	return u, ok, f.hit, nil
}

var at0 = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

func newServer(t *testing.T, u *fakeUsers) (*Server, *prometheus.Registry) {
	t.Helper()
	restricted, err := policy.ParseRules("FR:2025-08-01", nil)
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := policy.ParseRules("GB:2025-07-24", nil)
	if err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	return &Server{
		Engine:        policy.NewEngine(restricted, blocked),
		Users:         u,
		Metrics:       metrics.New(reg),
		Gatherer:      reg,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		LookupTimeout: 20 * time.Millisecond,
		Ready:         func(context.Context) error { return nil },
		Now:           func() time.Time { return at0 },
	}, reg
}

func post(t *testing.T, s *Server, body string) (int, Response, http.Header) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/v1/decide", strings.NewReader(body)))
	var res Response
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("status %d body %q: %v", rec.Code, rec.Body.String(), err)
	}
	return rec.Code, res, rec.Header()
}

var fullUser = policy.User{ShowNsfw: true, BrowsingLevel: 31}

// isSFWFallback reports whether res is the SFW fallback with reason.
func isSFWFallback(res Response, reason string) bool {
	return res.Fallback && res.Reason == reason && slices.Equal(res.Ratings, []string{"g", "pg", "pg13"}) &&
		!res.UnknownRating && res.BrowsingLevel == 1 && res.RegionHold == policy.HoldRestricted
}

func TestDecideSignedIn(t *testing.T) {
	u := &fakeUsers{users: map[int64]policy.User{7: fullUser}}
	s, reg := newServer(t, u)
	code, res, h := post(t, s, `{"context":"registry-subscription","userId":7,"country":"NL","region":null}`)
	if code != http.StatusOK || res.Fallback || res.Reason != policy.ReasonUserSettings || res.BrowsingLevel != 31 ||
		!slices.Equal(res.Ratings, []string{"g", "pg", "pg13", "r", "x", "xxx"}) || !res.UnknownRating ||
		res.RegionHold != policy.HoldNone || res.Context != "registry-subscription" || res.PolicyVersion != s.Engine.PolicyVersion() {
		t.Fatalf("%d %+v", code, res)
	}
	if h.Get("Cache-Control") != "no-store" || h.Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", h)
	}
	if got := testutil.ToFloat64(s.Metrics.Decisions.WithLabelValues("registry-subscription", "user-settings", "none")); got != 1 {
		t.Fatalf("decisions counter = %v, want 1", got)
	}
	if got := testutil.ToFloat64(s.Metrics.Lookups.WithLabelValues("found")); got != 1 {
		t.Fatalf("lookups{found} = %v", got)
	}
	if n := testutil.CollectAndCount(reg, "content_policy_decision_duration_seconds"); n == 0 {
		t.Fatal("no duration series")
	}
}

// The edge values are judged as sent: a restricted region holds the user to SFW.
func TestDecideRestrictedRegion(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{users: map[int64]policy.User{7: fullUser}})
	_, res, _ := post(t, s, `{"context":"registry-subscription","userId":7,"country":"fr"}`)
	if res.RegionHold != policy.HoldRestricted || res.Reason != policy.ReasonRegionRestricted ||
		!slices.Equal(res.Ratings, []string{"g", "pg", "pg13"}) {
		t.Fatalf("%+v", res)
	}
	_, res, _ = post(t, s, `{"context":"site","userId":7,"country":"GB","host":"red"}`)
	if res.RegionHold != policy.HoldBlocked || len(res.Ratings) != 0 || res.BrowsingLevel != 0 || res.Fallback {
		t.Fatalf("a blocked region on the site is refused, got %+v", res)
	}
	_, res, _ = post(t, s, `{"context":"site","country":"NL","isUk":"1","host":"red"}`)
	if res.RegionHold != policy.HoldBlocked {
		t.Fatalf("x-isuk 1 is GB, got %+v", res)
	}
}

func TestDecideAnonymousNeedsNoLookup(t *testing.T) {
	u := &fakeUsers{err: errors.New("must not be called")}
	s, _ := newServer(t, u)
	code, res, _ := post(t, s, `{"context":"registry-subscription","country":"NL"}`)
	if code != http.StatusOK || res.Reason != policy.ReasonAnonymous || u.calls != 0 {
		t.Fatalf("%d %+v calls=%d", code, res, u.calls)
	}
	// The public API does not read the user, so its user id is never looked up.
	code, res, _ = post(t, s, `{"context":"public-api","userId":7,"country":"NL"}`)
	if code != http.StatusOK || res.Reason != policy.ReasonUnrestricted || res.BrowsingLevel != 31 || u.calls != 0 {
		t.Fatalf("%d %+v calls=%d", code, res, u.calls)
	}
}

func TestDecideUserNotFound(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{users: map[int64]policy.User{}})
	code, res, _ := post(t, s, `{"context":"site","userId":99,"country":"NL","host":"red"}`)
	if code != http.StatusOK || res.Reason != policy.ReasonUserUnavailable || res.BrowsingLevel != 1 ||
		!slices.Equal(res.Ratings, []string{"g", "pg", "pg13"}) || res.Fallback {
		t.Fatalf("%d %+v", code, res)
	}
	if got := testutil.ToFloat64(s.Metrics.Lookups.WithLabelValues("not_found")); got != 1 {
		t.Fatalf("lookups{not_found} = %v", got)
	}
}

func TestDecideCacheHitCounted(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{users: map[int64]policy.User{7: fullUser}, hit: true})
	post(t, s, `{"context":"site","userId":7,"country":"NL","host":"red"}`)
	if got := testutil.ToFloat64(s.Metrics.Lookups.WithLabelValues("cache_hit")); got != 1 {
		t.Fatalf("lookups{cache_hit} = %v", got)
	}
}

// 🔴 A database error never answers anything wider than SFW.
func TestDecideDBErrorFailsClosed(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{err: errors.New("connection refused")})
	code, res, _ := post(t, s, `{"context":"registry-subscription","userId":7,"country":"NL"}`)
	if code != http.StatusServiceUnavailable || !isSFWFallback(res, policy.ReasonError) {
		t.Fatalf("a database error must answer 503 with the SFW fallback (reason error), got %d %+v", code, res)
	}
	if testutil.ToFloat64(s.Metrics.DBErrors) != 1 || testutil.ToFloat64(s.Metrics.Lookups.WithLabelValues("error")) != 1 ||
		testutil.ToFloat64(s.Metrics.Decisions.WithLabelValues("registry-subscription", "error", "restricted")) != 1 {
		t.Fatal("the error must be counted as a db error, a lookup error and an error decision")
	}
}

// 🔴 A lookup that outlives LookupTimeout fails closed too, and is counted as a timeout.
func TestDecideTimeoutFailsClosed(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{block: true})
	start := time.Now()
	code, res, _ := post(t, s, `{"context":"site","userId":7,"country":"NL","host":"red"}`)
	if code != http.StatusServiceUnavailable || !isSFWFallback(res, policy.ReasonError) {
		t.Fatalf("got %d %+v", code, res)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the lookup was not bounded by LookupTimeout")
	}
	if testutil.ToFloat64(s.Metrics.Lookups.WithLabelValues("timeout")) != 1 || testutil.ToFloat64(s.Metrics.DBErrors) != 1 {
		t.Fatal("a timeout must be counted as one")
	}
}

// 🔴 A panic answers the SFW fallback with a 500, never an empty or wider answer.
func TestDecidePanicFailsClosed(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{panic: true})
	code, res, _ := post(t, s, `{"context":"site","userId":7,"country":"NL","host":"red"}`)
	if code != http.StatusInternalServerError || !isSFWFallback(res, policy.ReasonError) {
		t.Fatalf("got %d %+v", code, res)
	}
}

// 🔴 Every malformed request answers 400 with the SFW fallback (reason invalid-input).
func TestDecideInvalidInput(t *testing.T) {
	long := strings.Repeat("A", MaxFieldLen+1)
	for name, body := range map[string]string{
		"empty":            ``,
		"not json":         `context=site`,
		"array":            `[]`,
		"unknown field":    `{"context":"site","viewer":"me"}`,
		"no context":       `{"country":"NL"}`,
		"unknown context":  `{"context":"feed"}`,
		"userId zero":      `{"context":"site","userId":0}`,
		"userId negative":  `{"context":"site","userId":-4}`,
		"userId too big":   `{"context":"site","userId":2147483648}`,
		"userId float":     `{"context":"site","userId":1.5}`,
		"userId string":    `{"context":"site","userId":"7"}`,
		"country too long": `{"context":"site","country":"` + long + `"}`,
		"region too long":  `{"context":"site","region":"` + long + `"}`,
		"isUk too long":    `{"context":"site","isUk":"` + long + `"}`,
		"host too long":    `{"context":"site","host":"` + long + `"}`,
		"country number":   `{"context":"site","country":44}`,
		"trailing data":    `{"context":"site"} {"context":"site"}`,
		"too large":        `{"context":"site","country":"` + strings.Repeat(" ", MaxBodyBytes) + `"}`,
	} {
		s, _ := newServer(t, &fakeUsers{})
		code, res, _ := post(t, s, body)
		if code != http.StatusBadRequest || !isSFWFallback(res, policy.ReasonInvalidInput) || res.Error == "" {
			t.Errorf("%s: got %d %+v, want 400 with the SFW fallback", name, code, res)
		}
	}
}

// 🔴 A request that leaves out an input its context requires is never decided as the site would
// decide it (the widest answer): it gets the SFW fallback, 422, reason missing-input. Each context ×
// missing host / missing country, with a full mature user, so a decision would carry r, x and xxx.
func TestDecideMissingInputFailsClosed(t *testing.T) {
	cases := []struct {
		name, body string
		fallback   bool
	}{
		{"site, no host", `{"context":"site","userId":7,"country":"NL"}`, true},
		{"site, empty host", `{"context":"site","userId":7,"country":"NL","host":""}`, true},
		{"site, no country", `{"context":"site","userId":7,"host":"red"}`, true},
		{"site, empty country", `{"context":"site","userId":7,"country":"","host":"red"}`, true},
		{"site, neither", `{"context":"site","userId":7}`, true},
		{"public-api, no country", `{"context":"public-api"}`, true},
		{"public-api, empty country", `{"context":"public-api","country":""}`, true},
		// The registry ignores the host, and holds a request with no country: a decision, not a fallback.
		{"registry, no country", `{"context":"registry-subscription","userId":7}`, false},
	}
	for _, c := range cases {
		u := &fakeUsers{users: map[int64]policy.User{7: fullUser}}
		s, _ := newServer(t, u)
		code, res, _ := post(t, s, c.body)
		if slices.Contains(res.Ratings, "r") || slices.Contains(res.Ratings, "x") || slices.Contains(res.Ratings, "xxx") || res.UnknownRating {
			t.Errorf("%s: got a mature answer %+v", c.name, res)
		}
		if c.fallback && (code != http.StatusUnprocessableEntity || !isSFWFallback(res, policy.ReasonMissingInput) || u.calls != 0) {
			t.Errorf("%s: got %d %+v (lookups %d), want 422 with the SFW fallback (reason missing-input) and no lookup", c.name, code, res, u.calls)
		}
		if !c.fallback && (code != http.StatusOK || res.Fallback || res.RegionHold != policy.HoldRestricted) {
			t.Errorf("%s: got %d %+v, want a held decision", c.name, code, res)
		}
	}
	// Positive controls: with every required input present each context decides (mature for this user).
	for _, body := range []string{
		`{"context":"site","userId":7,"country":"NL","host":"red"}`,
		`{"context":"site","userId":7,"isUk":"0","country":"NL","host":"red"}`,
		`{"context":"public-api","country":"NL"}`,
		`{"context":"registry-subscription","userId":7,"country":"NL"}`,
	} {
		s, _ := newServer(t, &fakeUsers{users: map[int64]policy.User{7: fullUser}})
		code, res, _ := post(t, s, body)
		if code != http.StatusOK || res.Fallback || !slices.Contains(res.Ratings, "r") {
			t.Errorf("%s: got %d %+v, want a mature decision", body, code, res)
		}
	}
	// x-isuk names GB, so a site request with no country header still has one (and is refused as blocked).
	s, _ := newServer(t, &fakeUsers{users: map[int64]policy.User{7: fullUser}})
	if code, res, _ := post(t, s, `{"context":"site","userId":7,"isUk":"1","host":"red"}`); code != http.StatusOK || res.RegionHold != policy.HoldBlocked {
		t.Errorf("x-isuk 1 with no country: got %d %+v, want a decision refusing GB", code, res)
	}
}

func TestDecideInvalidContextLabel(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	post(t, s, `{"context":"anything-at-all"}`)
	if got := testutil.ToFloat64(s.Metrics.Decisions.WithLabelValues(metrics.InvalidContext, "invalid-input", "restricted")); got != 1 {
		t.Fatalf("an unknown context must be counted under context=invalid, got %v", got)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/v1/decide?context=site", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /v1/decide = %d, want 405", rec.Code)
	}
}

func TestHealthAndReady(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	get := func(path string) (int, string) {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
		return rec.Code, rec.Body.String()
	}
	if code, body := get("/healthz"); code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("/healthz %d %s", code, body)
	}
	if code, body := get("/readyz"); code != 200 || !strings.Contains(body, s.Engine.PolicyVersion()) {
		t.Fatalf("/readyz %d %s", code, body)
	}
	s.Ready = func(context.Context) error { return errors.New("down") }
	if code, body := get("/readyz"); code != 503 || !strings.Contains(body, `"ready":false`) {
		t.Fatalf("/readyz with the database down: %d %s", code, body)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	s.Metrics.Info.WithLabelValues(s.Engine.PolicyVersion()).Set(1)
	post(t, s, `{"context":"public-api","country":"NL"}`)
	rec := httptest.NewRecorder()
	s.MetricsHandler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics on the metrics listener = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`content_policy_decisions_total{context="public-api",reason="unrestricted",region_hold="none"} 1`,
		`content_policy_decisions_total{context="registry-subscription",reason="error",region_hold="restricted"} 0`,
		`content_policy_user_lookups_total{result="timeout"} 0`,
		`content_policy_db_errors_total 0`,
		`content_policy_info{policy_version="` + s.Engine.PolicyVersion() + `"} 1`,
		`content_policy_decision_duration_seconds_count{context="public-api"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics lacks %s", want)
		}
	}
	if strings.Contains(body, `endpoint="`) {
		t.Error("a series carries a label named endpoint")
	}
}

// /metrics is served only on the metrics listener, so a network policy can admit Prometheus there
// without admitting it to /v1/decide (which has no authentication of its own).
func TestMetricsNotOnTheAPIListener(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "content_policy_") {
		t.Fatalf("GET /metrics on the API listener = %d %q, want 404 and no series", rec.Code, rec.Body.String())
	}
}

// The metrics listener serves /metrics and nothing else: no decision, no probes.
func TestOnlyMetricsOnTheMetricsListener(t *testing.T) {
	s, _ := newServer(t, &fakeUsers{})
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/decide", `{"context":"public-api","country":"NL"}`},
		{http.MethodGet, "/healthz", ""},
		{http.MethodGet, "/readyz", ""},
		{http.MethodGet, "/", ""},
	} {
		rec := httptest.NewRecorder()
		s.MetricsHandler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, strings.NewReader(tc.body)))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s on the metrics listener = %d, want 404", tc.method, tc.path, rec.Code)
		}
	}
	if got := testutil.ToFloat64(s.Metrics.Decisions.WithLabelValues("public-api", "unrestricted", "none")); got != 0 {
		t.Fatalf("a decision was made through the metrics listener (%v)", got)
	}
	rec := httptest.NewRecorder()
	s.MetricsHandler().ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/metrics", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /metrics = %d, want 405", rec.Code)
	}
}

func FuzzDecodeRequest(f *testing.F) {
	f.Add(`{"context":"site","userId":7,"country":"GB","region":"ENG","isUk":"1","host":"red"}`)
	f.Add(`{"context":"registry-subscription"}`)
	f.Add(`{"context":"public-api","userId":-1}`)
	f.Add(`{}`)
	f.Fuzz(func(t *testing.T, body string) {
		req, err := DecodeRequest(strings.NewReader(body))
		if err != nil {
			return
		}
		if _, ok := policy.Contexts[req.Context]; !ok {
			t.Fatalf("accepted context %q", req.Context)
		}
		if req.UserID != nil && (*req.UserID < 1 || *req.UserID > MaxUserID) {
			t.Fatalf("accepted userId %d", *req.UserID)
		}
		for _, v := range []*string{req.Country, req.Region, req.IsUK, req.Host} {
			if v != nil && len(*v) > MaxFieldLen {
				t.Fatalf("accepted a %d-byte field", len(*v))
			}
		}
	})
}
