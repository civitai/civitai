package evalharness

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// fakeCH is a ClickHouse HTTP interface: GET answers rows(query) as JSONEachRow, POST records the
// insert's table query and body.
type fakeCH struct {
	mu      sync.Mutex
	gets    []url.Values
	inserts map[string][]string // INSERT query -> bodies
	posts   []url.Values
	rows    func(q url.Values) string
}

func newFakeCH(t *testing.T, rows func(q url.Values) string) (*fakeCH, *httptest.Server) {
	t.Helper()
	f := &fakeCH{inserts: map[string][]string{}, rows: rows}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "eval-user" || p != "eval-pass" {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			f.gets = append(f.gets, q)
			_, _ = io.WriteString(w, f.rows(q))
		case http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			f.posts = append(f.posts, q)
			f.inserts[q.Get("query")] = append(f.inserts[q.Get("query")], string(b))
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

// reads is the GET queries so far.
func (f *fakeCH) reads() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]url.Values(nil), f.gets...)
}

func TestCHStoreSelectCasesSendsParameters(t *testing.T) {
	f, srv := newFakeCH(t, func(url.Values) string {
		return `{"case_id":"18446744073709551557","request":"{\"input\":\"{\\\"json\\\":{\\\"limit\\\":20}}\",\"headers\":{\"host\":\"h.example\"},\"credential\":\"none\",\"viewer\":{\"class\":\"anon\",\"browsingLevel\":0,\"showNsfw\":false,\"hiddenPrefs\":false,\"self\":false}}","sig_text":"{\"v\":1}","sig":"12345","weight":12.5}` + "\n"
	})
	s, err := NewCHStore(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close(context.Background()) }()
	from := time.Date(2026, 10, 27, 4, 5, 6, 7_000_000, time.UTC)
	to := time.Date(2026, 11, 26, 4, 5, 6, 7_000_000, time.UTC)
	cases, err := s.SelectCases(context.Background(), evalcorpus.EndpointModelGetAll, from, to, "2026-11-26", 1499)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 1 {
		t.Fatalf("%d cases", len(cases))
	}
	c := cases[0]
	if c.ID != 18446744073709551557 || c.Sig != 12345 || c.Weight != 12.5 || c.Endpoint != "model-getall" ||
		c.Request.Input != `{"json":{"limit":20}}` || c.Request.Headers["host"] != "h.example" || c.Request.Viewer.Class != "anon" {
		t.Fatalf("case %+v", c)
	}
	gets := f.reads()
	if len(gets) != 1 {
		t.Fatalf("%d reads", len(gets))
	}
	q := gets[0]
	if q.Get("query") != chread.WireQuery(selectCasesSQL) {
		t.Fatalf("query text %q", q.Get("query"))
	}
	for _, v := range []string{"model-getall", "2026-11-26", "1499", "2026-10-27"} {
		if strings.Contains(q.Get("query"), v) {
			t.Errorf("the query text holds the value %q", v)
		}
	}
	wantParams := map[string]string{
		"param_endpoint": "model-getall", "param_day": "2026-11-26", "param_limit": "1499",
		"param_from": "2026-10-27 04:05:06.007", "param_to": "2026-11-26 04:05:06.007", "database": "evaldb",
		"param_promoted": "prod-mismatch",
	}
	for k, v := range wantParams {
		if q.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, q.Get(k), v)
		}
	}
	// Unqualified tables only: the database is the URL's.
	if strings.Contains(q.Get("query"), "evaldb") {
		t.Error("the query names the database")
	}
}

func TestCHStoreWritesRowsWithTheSchemaColumns(t *testing.T) {
	f, srv := newFakeCH(t, func(url.Values) string { return "" })
	s, err := NewCHStore(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass", FlushInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !s.AddResult(ResultRow{RunID: "live-20261126T040000Z-a1b2c3", CaseID: 18446744073709551557, Endpoint: "as-posts", Sig: 12345,
		Verdict: "bug", ResultClass: "fields", DiffCategories: []string{"items.*.name"}, UnstablePaths: []string{},
		ViewerUsed: "member-default", NodeStatus: 200, GoStatus: 201, NodeMS: 12.5, GoMS: 3.25, TS: "2026-11-26T04:00:01.000Z"}) {
		t.Fatal("result not queued")
	}
	if !s.AddRun(RunRow{RunID: "live-20261126T040000Z-a1b2c3", Phase: "live", NodeImage: "ni", GoImage: "gi", SnapshotID: "sn",
		CorpusFrom: "2026-10-27T04:00:00.000Z", CorpusTo: "2026-11-26T04:00:00.000Z", Settings: `{"end_reason":"done"}`,
		Started: "2026-11-26T04:00:00.000Z", Finished: "2026-11-26T05:00:00.000Z"}) {
		t.Fatal("run not queued")
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	wantResult := `{"run_id":"live-20261126T040000Z-a1b2c3","case_id":18446744073709551557,"endpoint":"as-posts","sig":12345,` +
		`"verdict":"bug","reason":"","result_class":"fields","diff_categories":["items.*.name"],"unstable_paths":[],` +
		`"viewer_used":"member-default","node_status":200,"go_status":201,"node_ms":12.5,"go_ms":3.25,"ts":"2026-11-26T04:00:01.000Z"}`
	wantRun := `{"run_id":"live-20261126T040000Z-a1b2c3","phase":"live","node_image":"ni","go_image":"gi","snapshot_id":"sn",` +
		`"corpus_from":"2026-10-27T04:00:00.000Z","corpus_to":"2026-11-26T04:00:00.000Z","settings":"{\"end_reason\":\"done\"}",` +
		`"started":"2026-11-26T04:00:00.000Z","finished":"2026-11-26T05:00:00.000Z"}`
	if got := strings.TrimSpace(strings.Join(f.inserts["INSERT INTO results FORMAT JSONEachRow"], "")); got != wantResult {
		t.Errorf("results row:\n got %s\nwant %s", got, wantResult)
	}
	if got := strings.TrimSpace(strings.Join(f.inserts["INSERT INTO runs FORMAT JSONEachRow"], "")); got != wantRun {
		t.Errorf("runs row:\n got %s\nwant %s", got, wantRun)
	}
	if len(f.inserts) != 2 {
		t.Errorf("inserts into %d tables, want 2 (results, runs; never cases)", len(f.inserts))
	}
	for _, q := range f.posts {
		if q.Get("database") != "evaldb" || q.Get("date_time_input_format") != "best_effort" {
			t.Errorf("insert params %v", q)
		}
	}
}

func TestCHConfigRequiresAllThree(t *testing.T) {
	for _, c := range []CHConfig{
		{URL: "http://h.example/db", Username: "u"},
		{URL: "http://h.example/db", Password: "p"},
		{Username: "u", Password: "p"},
	} {
		if _, err := NewCHStore(c); err == nil {
			t.Errorf("%+v: no error", c)
		}
	}
	if _, err := NewCHStore(CHConfig{URL: "http://h.example/", Username: "u", Password: "p"}); err == nil {
		t.Error("a URL without a database path must be refused")
	}
}

// TestCHStoreCloseReportsLostRows: a ClickHouse that refuses the inserts (4xx) makes Close an error
// naming how many rows of each table were lost; one that takes them is no error.
func TestCHStoreCloseReportsLostRows(t *testing.T) {
	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		http.Error(w, "Code: 60. Unknown table", http.StatusNotFound)
	}))
	defer refuse.Close()
	s, err := NewCHStore(CHConfig{URL: refuse.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		s.AddResult(ResultRow{RunID: "r", CaseID: uint64(i + 1), DiffCategories: []string{}, UnstablePaths: []string{}})
	}
	s.AddRun(RunRow{RunID: "r"})
	err = s.Close(context.Background())
	if err == nil || !strings.Contains(err.Error(), "3 of 3 results rows and 1 of 1 runs rows were not written") {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(err.Error(), "eval-pass") {
		t.Fatal("the error holds the password")
	}
	_, srv := newFakeCH(t, func(url.Values) string { return "" })
	ok, err := NewCHStore(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	ok.AddRun(RunRow{RunID: "r"})
	if err := ok.Close(context.Background()); err != nil {
		t.Fatalf("accepted inserts: %v", err)
	}
}
