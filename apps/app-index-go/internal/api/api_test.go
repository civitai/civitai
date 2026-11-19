package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func app(slug, name, kind, category string) store.App {
	body, _ := json.Marshal(map[string]any{"slug": slug, "name": name, "kind": kind, "contentRating": "pg",
		"category": category, "tagline": name + " tagline", "iconUrl": "https://cdn.invalid/" + slug + ".png", "creator": "maker"})
	a, err := store.AppFromEntity("urn:apps.civitai.com:app/"+slug, "r", body)
	if err != nil {
		panic(err)
	}
	return a
}

type testServer struct {
	*httptest.Server
	m *metrics.Metrics
}

func newServer(t *testing.T, st store.Store) testServer {
	t.Helper()
	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	s := httptest.NewServer((&Server{Store: st, Metrics: m, Gatherer: reg, Log: slog.New(slog.DiscardHandler)}).Handler())
	t.Cleanup(s.Close)
	return testServer{s, m}
}

func readyStore(t *testing.T, apps ...store.App) *store.Memory {
	t.Helper()
	ctx := t.Context()
	st := store.NewMemory()
	g, err := st.NewBuilding(ctx, "s", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range apps {
		if err := st.Apply(ctx, g.ID, store.Change{Kind: store.ChangeUpsert, App: a}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.Live(ctx, g.ID, "L"); err != nil {
		t.Fatal(err)
	}
	return st
}

func get(t *testing.T, u string) (int, []byte) {
	t.Helper()
	res, err := http.Get(u) //nolint:noctx,gosec // test: u is the test server URL
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

func TestSearchFiltersAndLimit(t *testing.T) {
	st := readyStore(t, app("a", "Apple", "onsite", "generation"), app("b", "Banana", "offsite", "chat"),
		app("c", "Cherry", "onsite", "generation"), app("d", "Date", "onsite", "game"), app("e", "Elder", "onsite", "generation"))
	s := newServer(t, st)
	names := func(q url.Values) []string {
		code, body := get(t, s.URL+"/search?"+q.Encode())
		if code != http.StatusOK {
			t.Fatalf("status %d %s", code, body)
		}
		var res struct {
			Results []map[string]string `json:"results"`
		}
		if err := json.Unmarshal(body, &res); err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(res.Results))
		for _, r := range res.Results {
			out = append(out, r["name"])
			for _, k := range []string{"urn", "slug", "name", "tagline", "kind", "category", "rating", "iconUrl", "creator"} {
				if _, ok := r[k]; !ok {
					t.Fatalf("result lacks %q: %v", k, r)
				}
			}
		}
		return out
	}
	if got := names(url.Values{"kind": {"onsite"}}); !slices.Equal(got, []string{"Apple", "Cherry", "Date", "Elder"}) {
		t.Fatalf("onsite = %v", got)
	}
	if got := names(url.Values{"kind": {"onsite"}, "limit": {"2"}}); !slices.Equal(got, []string{"Apple", "Cherry"}) {
		t.Fatalf("onsite limit 2 = %v", got)
	}
	if got := names(url.Values{"category": {"generation"}, "q": {"el"}}); !slices.Equal(got, []string{"Elder"}) {
		t.Fatalf("generation q=el = %v", got)
	}
	if got := testutil.ToFloat64(s.m.Searches.WithLabelValues("ok")); got != 3 {
		t.Fatalf("ok searches = %v", got)
	}
}

func TestSearchShape(t *testing.T) {
	s := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	code, body := get(t, s.URL+"/search?q=app")
	if code != http.StatusOK {
		t.Fatal(code)
	}
	want := `{"results":[{"urn":"urn:apps.civitai.com:app/a","slug":"a","name":"Apple","tagline":"Apple tagline","kind":"onsite","category":"generation","rating":"pg","iconUrl":"https://cdn.invalid/a.png","creator":"maker"}]}`
	if strings.TrimSpace(string(body)) != want {
		t.Fatalf("body\n%s\nwant\n%s", body, want)
	}
	code, body = get(t, s.URL+"/search?q=zzz")
	if code != http.StatusOK || strings.TrimSpace(string(body)) != `{"results":[]}` {
		t.Fatalf("no match: %d %s", code, body)
	}
}

func TestSearchNotReady(t *testing.T) {
	s := newServer(t, store.NewMemory())
	if code, _ := get(t, s.URL+"/search?q=a"); code != http.StatusServiceUnavailable {
		t.Fatalf("search = %d, want 503", code)
	}
	if code, _ := get(t, s.URL+"/readyz"); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503", code)
	}
	if code, _ := get(t, s.URL+"/healthz"); code != http.StatusOK {
		t.Fatalf("healthz = %d", code)
	}
	if got := testutil.ToFloat64(s.m.Searches.WithLabelValues("not_ready")); got != 1 {
		t.Fatalf("not_ready = %v", got)
	}
}

func TestReadyz(t *testing.T) {
	s := newServer(t, readyStore(t))
	code, body := get(t, s.URL+"/readyz")
	if code != http.StatusOK || !strings.Contains(string(body), `"generation":1`) {
		t.Fatalf("ready store: %d %s", code, body)
	}
	if testutil.ToFloat64(s.m.Ready) != 1 {
		t.Fatal("ready gauge not set")
	}
	s = newServer(t, brokenState{store.NewMemory()})
	if code, body := get(t, s.URL+"/readyz"); code != http.StatusServiceUnavailable || !strings.Contains(string(body), `"store"`) {
		t.Fatalf("store error: %d %s", code, body)
	}
}

type brokenState struct{ store.Store }

func (brokenState) State(context.Context) (store.State, error) {
	return store.State{}, errors.New("db down")
}

// slowStore answers only when its context ends.
type slowStore struct{ store.Store }

func (slowStore) Search(ctx context.Context, _ store.Query) (store.Page, error) {
	<-ctx.Done()
	return store.Page{}, ctx.Err()
}

func TestSearchTimeout(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	srv := httptest.NewServer((&Server{Store: slowStore{store.NewMemory()}, Metrics: m, Gatherer: reg,
		Log: slog.New(slog.DiscardHandler), SearchTimeout: 20 * time.Millisecond}).Handler())
	defer srv.Close()
	start := time.Now()
	code, _ := get(t, srv.URL+"/search?q=a")
	if code != http.StatusInternalServerError || time.Since(start) > 5*time.Second {
		t.Fatalf("status %d after %s", code, time.Since(start))
	}
	if testutil.ToFloat64(m.Searches.WithLabelValues("error")) != 1 {
		t.Fatal("timeout not counted as error")
	}
}

type failingStore struct{ store.Store }

func (failingStore) Search(context.Context, store.Query) (store.Page, error) {
	return store.Page{}, errors.New("db down at db.invalid:5432")
}

func TestSearchStoreErrorHidesDetail(t *testing.T) {
	s := newServer(t, failingStore{store.NewMemory()})
	code, body := get(t, s.URL+"/search")
	if code != http.StatusInternalServerError || strings.Contains(string(body), "invalid") {
		t.Fatalf("%d %s", code, body)
	}
}

func TestSearchRejectsBadParameters(t *testing.T) {
	s := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	for _, q := range []string{
		"kind=web", "limit=0", "limit=51", "limit=x",
		"q=" + strings.Repeat("a", MaxQueryLen+1), "category=" + strings.Repeat("c", MaxFilterLen+1),
	} {
		if code, body := get(t, s.URL+"/search?"+q); code != http.StatusBadRequest {
			t.Errorf("%.40s: %d %s, want 400", q, code, body)
		}
	}
	if got := testutil.ToFloat64(s.m.Searches.WithLabelValues("bad_request")); got != 6 {
		t.Fatalf("bad_request = %v", got)
	}
}

func TestParseQueryDefaults(t *testing.T) {
	q, err := ParseQuery(url.Values{})
	if err != nil || q.Limit != DefaultLimit || q.Text != "" {
		t.Fatalf("no params: %+v %v", q, err)
	}
	q, err = ParseQuery(url.Values{"q": {"x"}, "limit": {"7"}, "kind": {"offsite"}, "category": {"game"}})
	if err != nil || q != (store.Query{Text: "x", Limit: 7, Kind: "offsite", Category: "game"}) {
		t.Fatalf("with params: %+v %v", q, err)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	s := newServer(t, readyStore(t))
	code, body := get(t, s.URL+"/metrics")
	if code != http.StatusOK {
		t.Fatal(code)
	}
	text := string(body)
	for _, name := range []string{"app_index_events_applied_total", "app_index_generation", "app_index_ready",
		"app_index_reconnects_total", "app_index_rebuilds_total", "app_index_search_requests_total",
		"app_index_search_duration_seconds", "app_index_last_event_age_seconds"} {
		if !strings.Contains(text, "\n"+name) && !strings.HasPrefix(text, name) {
			t.Errorf("missing %s", name)
		}
	}
	if strings.Contains(text, `endpoint="`) {
		t.Error("a series carries an `endpoint` label")
	}
}

// /search allows any origin on every status it answers, so an app iframe can read its errors too;
// the operational routes never do.
func TestSearchCORS(t *testing.T) {
	ready := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	notReady := newServer(t, store.NewMemory())
	failing := newServer(t, failingStore{store.NewMemory()})
	cors := func(u string) (int, string) {
		t.Helper()
		res, err := http.Get(u) //nolint:noctx,gosec // test: u is the test server URL
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode, res.Header.Get("Access-Control-Allow-Origin")
	}
	for _, c := range []struct {
		url  string
		code int
	}{
		{ready.URL + "/search?q=app", http.StatusOK},
		{ready.URL + "/search?kind=web", http.StatusBadRequest},
		{notReady.URL + "/search?q=a", http.StatusServiceUnavailable},
		{failing.URL + "/search", http.StatusInternalServerError},
	} {
		if code, h := cors(c.url); code != c.code || h != "*" {
			t.Errorf("%s: %d %q, want %d \"*\"", c.url, code, h, c.code)
		}
	}
	for _, path := range []string{"/metrics", "/readyz", "/healthz"} {
		if code, h := cors(ready.URL + path); code != http.StatusOK || h != "" {
			t.Errorf("%s: %d Access-Control-Allow-Origin %q, want 200 and none", path, code, h)
		}
	}
}

func headers(t *testing.T, method, u string) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, u, nil) //nolint:noctx // test: u is the test server URL
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, b
}

// Only a 200 from /search may be cached (a shared cache then absorbs repeated searches); errors
// and every other route are no-store, so a cache never holds a 503 or a stale readiness answer.
func TestSearchCacheControl(t *testing.T) {
	ready := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	notReady := newServer(t, store.NewMemory())
	failing := newServer(t, failingStore{store.NewMemory()})
	for _, c := range []struct {
		url  string
		code int
		want string
	}{
		{ready.URL + "/search?q=app", http.StatusOK, "public, max-age=30"},
		{ready.URL + "/search?q=zzz", http.StatusOK, "public, max-age=30"},
		{ready.URL + "/search?kind=web", http.StatusBadRequest, "no-store"},
		{failing.URL + "/search", http.StatusInternalServerError, "no-store"},
		{notReady.URL + "/search?q=a", http.StatusServiceUnavailable, "no-store"},
		{ready.URL + "/metrics", http.StatusOK, "no-store"},
		{ready.URL + "/readyz", http.StatusOK, "no-store"},
		{ready.URL + "/healthz", http.StatusOK, "no-store"},
	} {
		code, h, _ := headers(t, http.MethodGet, c.url)
		if code != c.code || h.Get("Cache-Control") != c.want {
			t.Errorf("%s: %d Cache-Control %q, want %d %q", c.url, code, h.Get("Cache-Control"), c.code, c.want)
		}
	}
}

// A browser preflight of /search gets a 204 that allows a GET from any origin; no other route
// answers one.
func TestSearchPreflight(t *testing.T) {
	s := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	code, h, body := headers(t, http.MethodOptions, s.URL+"/search")
	if code != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("OPTIONS /search: %d %q, want 204 and no body", code, body)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Methods": "GET",
		"Access-Control-Max-Age":       "86400",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("OPTIONS /search %s = %q, want %q", k, got, want)
		}
	}
	for _, path := range []string{"/metrics", "/readyz", "/healthz"} {
		code, h, _ := headers(t, http.MethodOptions, s.URL+path)
		if code == http.StatusNoContent || h.Get("Access-Control-Allow-Origin") != "" ||
			h.Get("Access-Control-Allow-Methods") != "" {
			t.Errorf("OPTIONS %s: %d %v, want no preflight answer", path, code, h)
		}
	}
}
