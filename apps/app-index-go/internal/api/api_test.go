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

func TestSearchPagesThroughResults(t *testing.T) {
	st := readyStore(t, app("a", "Apple", "onsite", "generation"), app("b", "Banana", "offsite", "chat"),
		app("c", "Cherry", "onsite", "generation"), app("d", "Date", "onsite", "game"), app("e", "Elder", "onsite", "generation"))
	s := newServer(t, st)
	var names []string
	q := url.Values{"kind": {"onsite"}, "sort": {"name"}, "limit": {"2"}}
	for range 10 {
		code, body := get(t, s.URL+"/search?"+q.Encode())
		if code != http.StatusOK {
			t.Fatalf("status %d %s", code, body)
		}
		var res struct {
			Results []map[string]string `json:"results"`
			Next    *string             `json:"next"`
		}
		if err := json.Unmarshal(body, &res); err != nil {
			t.Fatal(err)
		}
		for _, r := range res.Results {
			names = append(names, r["name"])
			for _, k := range []string{"urn", "slug", "name", "tagline", "kind", "category", "rating", "iconUrl", "creator"} {
				if _, ok := r[k]; !ok {
					t.Fatalf("result lacks %q: %v", k, r)
				}
			}
		}
		if res.Next == nil {
			break
		}
		q.Set("cursor", *res.Next)
	}
	if want := []string{"Apple", "Cherry", "Date", "Elder"}; !slices.Equal(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if got := testutil.ToFloat64(s.m.Searches.WithLabelValues("ok")); got != 2 {
		t.Fatalf("ok searches = %v", got)
	}
}

func TestSearchShape(t *testing.T) {
	s := newServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")))
	code, body := get(t, s.URL+"/search?q=app")
	if code != http.StatusOK {
		t.Fatal(code)
	}
	want := `{"results":[{"urn":"urn:apps.civitai.com:app/a","slug":"a","name":"Apple","tagline":"Apple tagline","kind":"onsite","category":"generation","rating":"pg","iconUrl":"https://cdn.invalid/a.png","creator":"maker"}],"next":null}`
	if strings.TrimSpace(string(body)) != want {
		t.Fatalf("body\n%s\nwant\n%s", body, want)
	}
	code, body = get(t, s.URL+"/search?q=zzz")
	if code != http.StatusOK || strings.TrimSpace(string(body)) != `{"results":[],"next":null}` {
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
		"kind=web", "sort=popular", "limit=0", "limit=51", "limit=x",
		"q=" + strings.Repeat("a", MaxQueryLen+1), "category=" + strings.Repeat("c", MaxFilterLen+1),
		"cursor=!!!", "cursor=" + strings.Repeat("A", 2000), "cursor=e30",
	} {
		if code, body := get(t, s.URL+"/search?"+q); code != http.StatusBadRequest {
			t.Errorf("%.40s: %d %s, want 400", q, code, body)
		}
	}
	if got := testutil.ToFloat64(s.m.Searches.WithLabelValues("bad_request")); got != 10 {
		t.Fatalf("bad_request = %v", got)
	}
}

func TestCursorIsBoundToItsQuery(t *testing.T) {
	q := store.Query{Text: "pixel art", Kind: "onsite", Sort: store.SortRelevance}
	k := store.Key{Rank: 0.0607927, Name: "pixel forge", URN: "urn:apps.civitai.com:app/pixel-forge"}
	c := EncodeCursor(q, k)
	if strings.Contains(c, "pixel") {
		t.Fatal("cursor is not opaque")
	}
	got, err := DecodeCursor(q, c)
	if err != nil || got != k {
		t.Fatalf("round trip = %+v %v", got, err)
	}
	// Same words, other spelling: same query.
	if _, err := DecodeCursor(store.Query{Text: "  PIXEL  art!", Kind: "onsite", Sort: store.SortRelevance}, c); err != nil {
		t.Fatalf("normalised query rejected: %v", err)
	}
	for _, other := range []store.Query{
		{Text: "pixel", Kind: "onsite", Sort: store.SortRelevance},
		{Text: "pixel art", Kind: "offsite", Sort: store.SortRelevance},
		{Text: "pixel art", Kind: "onsite", Category: "x", Sort: store.SortRelevance},
		{Text: "pixel art", Kind: "onsite", Sort: store.SortName},
	} {
		if _, err := DecodeCursor(other, c); err == nil {
			t.Errorf("cursor accepted for %+v", other)
		}
	}
}

func TestParseQueryDefaults(t *testing.T) {
	q, err := ParseQuery(url.Values{})
	if err != nil || q.Sort != store.SortName || q.Limit != DefaultLimit {
		t.Fatalf("no params: %+v %v", q, err)
	}
	q, err = ParseQuery(url.Values{"q": {"x"}})
	if err != nil || q.Sort != store.SortRelevance {
		t.Fatalf("with q: %+v %v", q, err)
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
