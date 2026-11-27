package evalcapture

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/chwrite"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// All values are synthetic.

// sink records the rows it is handed; refuse makes Add report a full queue.
type sink struct {
	mu     sync.Mutex
	rows   []any
	refuse bool
}

func (s *sink) Add(row any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refuse {
		return false
	}
	s.rows = append(s.rows, row)
	return true
}

func (s *sink) samples() []SampleRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SampleRow, 0, len(s.rows))
	for _, r := range s.rows {
		out = append(out, r.(SampleRow))
	}
	return out
}

func (s *sink) cases() []CaseRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CaseRow, 0, len(s.rows))
	for _, r := range s.rows {
		out = append(out, r.(CaseRow))
	}
	return out
}

// clock is a settable Now.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

var day1 = time.Date(2026, 6, 15, 13, 45, 6, 789_000_000, time.UTC)

func newRecorder(cfg Config) (*Recorder, *sink, *sink, *clock) {
	samples, cases := &sink{}, &sink{}
	clk := &clock{t: day1}
	cfg.Samples, cfg.Cases, cfg.Now = samples, cases, clk.now
	cfg.HostColors = browsing.HostColors{"green": {"green.example.test"}, "blue": {"blue.example.test"}}
	cfg.GoVersion = "1.2.3"
	return New(cfg), samples, cases, clk
}

// browserHeaders are the headers a signed-in browser request arrives with (as evalcorpus's strip tests
// build them), secret marking every value that must not be stored.
func browserHeaders(secret string) map[string]string {
	return map[string]string{
		"Host":                 "blue.example.test",
		"Cookie":               "theme=dark; __Secure-civ-token=" + secret + "; ref=" + secret,
		"Authorization":        "Bearer " + secret,
		"X-Feed-Go-Credential": "key:" + secret,
		"User-Agent":           "Mozilla/5.0 " + secret,
		"X-Forwarded-For":      "198.51.100.7, " + secret,
		"CF-Connecting-IP":     secret,
		"Referer":              "https://blue.example.test/user/" + secret,
		"CF-IPCountry":         "US",
	}
}

func infinite(input string, headers map[string]string) evalcorpus.Request {
	return evalcorpus.Request{Endpoint: evalcorpus.EndpointInfinite, Input: input, Headers: headers}
}

func limitInput(id int) string {
	return `{"json":{"limit":20,"postId":` + itoa(id) + `,"sort":"Newest"}}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

var anonViewer = evalcorpus.Viewer{Class: evalcorpus.ViewerAnon}

func anonSample(id int, result string) Sample {
	return Sample{
		Source: SourceShadow, Request: infinite(limitInput(id), map[string]string{"host": "green.example.test"}),
		Viewer: anonViewer, ViewerKnown: true, Weight: 4, ProdResult: result,
		NodeBody: []byte(`{"json":{"items":[{"id":` + itoa(id) + `}]}}`), NodeHeaders: map[string]string{"cache-control": "public, max-age=60"},
	}
}

// A capture writes one sample row and, admitted, one case row: the columns as the store contract
// names them, the case's version at the start of its UTC day, pinned 0, the case id in the sample.
func TestRecordWritesRows(t *testing.T) {
	r, samples, cases, _ := newRecorder(Config{})
	s := anonSample(7, "fields")
	s.DiffCategories = []string{"items.id", "header:etag", "items.id"}
	s.HeaderResult = "mismatch"
	if got := r.Record(s); got != OutcomeWritten {
		t.Fatalf("outcome %q, want written", got)
	}
	ss, cs := samples.samples(), cases.cases()
	if len(ss) != 1 || len(cs) != 1 {
		t.Fatalf("rows: %d samples, %d cases, want 1 and 1", len(ss), len(cs))
	}
	sr, cr := ss[0], cs[0]
	if sr.TS != "2026-06-15T13:45:06.789Z" || sr.Endpoint != "infinite" || sr.Source != "shadow" || sr.ViewerClass != "anon" ||
		sr.HostClass != "green" || sr.Weight != 4 || sr.ProdResult != "fields" || sr.HeaderResult != "mismatch" || sr.GoVersion != "1.2.3" {
		t.Errorf("sample row %+v", sr)
	}
	if strings.Join(sr.DiffCategories, ",") != "header:etag,items.id" {
		t.Errorf("diff categories %v, want sorted and unique", sr.DiffCategories)
	}
	if sr.CaseID == 0 || sr.CaseID != cr.CaseID || sr.Sig != cr.Sig || sr.SigText != cr.SigText {
		t.Errorf("sample (case %d sig %d) and case (case %d sig %d) disagree", sr.CaseID, sr.Sig, cr.CaseID, cr.Sig)
	}
	if cr.FirstSeen != "2026-06-15T00:00:00.000Z" || cr.LastSeen != "2026-06-15T00:00:00.000Z" || cr.Pinned != 0 {
		t.Errorf("case version: first %s last %s pinned %d, want the day's start twice and 0", cr.FirstSeen, cr.LastSeen, cr.Pinned)
	}
	if cr.Origin != OriginMismatch || cr.ProdResult != "fields" {
		t.Errorf("case origin %q result %q", cr.Origin, cr.ProdResult)
	}
	var req StoredRequest
	if err := json.Unmarshal([]byte(cr.Request), &req); err != nil {
		t.Fatal(err)
	}
	if req.Input != limitInput(7) || req.Viewer.Class != "anon" || req.Credential != "none" {
		t.Errorf("stored request %+v", req)
	}
	if cr.NodeBody != string(s.NodeBody) || cr.NodeHeaders["cache-control"] != "public, max-age=60" {
		t.Errorf("anon node answer not kept: %q %v", cr.NodeBody, cr.NodeHeaders)
	}
	// The JSON the writer sends: the store's column names, nothing else.
	b, _ := json.Marshal(cr)
	var cols map[string]any
	_ = json.Unmarshal(b, &cols)
	for _, c := range []string{"case_id", "endpoint", "sig", "sig_text", "origin", "request", "node_body", "node_headers", "prod_result", "pinned", "first_seen", "last_seen"} {
		if _, ok := cols[c]; !ok {
			t.Errorf("case row has no %s", c)
		}
	}
	if len(cols) != 12 {
		t.Errorf("case row has %d columns, want 12: %s", len(cols), b)
	}
	b, _ = json.Marshal(sr)
	cols = nil
	_ = json.Unmarshal(b, &cols)
	if len(cols) != 14 {
		t.Errorf("sample row has %d columns, want 14: %s", len(cols), b)
	}
}

// The case id: the same request on the same day is the same id (so another pod's copy collapses);
// the next day it is another id (never a re-insert of a case the harness may have pinned); never 0.
func TestCaseIDByDayAndRequest(t *testing.T) {
	a := CaseID("2026-06-15", "infinite", "00000000000000aa", []byte(`{"input":"x"}`))
	if a == 0 {
		t.Fatal("zero case id")
	}
	if b := CaseID("2026-06-15", "infinite", "00000000000000aa", []byte(`{"input":"x"}`)); b != a {
		t.Errorf("same request, same day: %d != %d", b, a)
	}
	for _, other := range []uint64{
		CaseID("2026-06-16", "infinite", "00000000000000aa", []byte(`{"input":"x"}`)),
		CaseID("2026-06-15", "as-posts", "00000000000000aa", []byte(`{"input":"x"}`)),
		CaseID("2026-06-15", "infinite", "00000000000000ab", []byte(`{"input":"x"}`)),
		CaseID("2026-06-15", "infinite", "00000000000000aa", []byte(`{"input":"y"}`)),
		// The parts are length-prefixed: moving a boundary is another id.
		CaseID("2026-06-15i", "nfinite", "00000000000000aa", []byte(`{"input":"x"}`)),
	} {
		if other == a {
			t.Errorf("a different day, endpoint, signature or request kept id %d", a)
		}
	}

	r, _, cases, clk := newRecorder(Config{})
	r.Record(anonSample(1, "match"))
	clk.set(day1.Add(24 * time.Hour))
	r.Record(anonSample(1, "match"))
	cs := cases.cases()
	if len(cs) != 2 || cs[0].CaseID == cs[1].CaseID || cs[1].FirstSeen != "2026-06-16T00:00:00.000Z" {
		t.Fatalf("the same request on two days: %+v", cs)
	}
}

// Credentials, the client address and the user agent never reach a row; Node's answer is kept only
// for a request with no session user and no credential.
func TestRecordStripsAndKeepsNodeAnswerForSignedOutOnly(t *testing.T) {
	const secret = "s3cr3t-Value-0001"
	user := evalcorpus.Viewer{Class: evalcorpus.ViewerUser, UserID: 987654321, Username: "SomeViewerName"}
	cases := []struct {
		name     string
		viewer   evalcorpus.Viewer
		headers  map[string]string
		keepBody bool
	}{
		{"signed in", user, browserHeaders(secret), false},
		{"anon with credentials", anonViewer, browserHeaders(secret), false},
		{"anon, no credential", anonViewer, map[string]string{"Host": "blue.example.test", "User-Agent": "UA " + secret}, true},
		{"crawler, no credential", evalcorpus.Viewer{Class: evalcorpus.ViewerCrawler}, map[string]string{"host": "blue.example.test"}, true},
		{"banned, no credential", evalcorpus.Viewer{Class: evalcorpus.ViewerBanned}, map[string]string{"host": "blue.example.test"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, samples, casesSink, _ := newRecorder(Config{})
			input := `{"json":{"limit":20,"userId":987654321,"token":"` + secret + `","username":"someviewername"}}`
			got := r.Record(Sample{
				Source: SourceServeParity, Request: infinite(input, c.headers), Viewer: c.viewer, ViewerKnown: true,
				ProdResult: "fields", DiffCategories: []string{"items.user"},
				NodeBody: []byte(`{"json":{"secret":"` + secret + `"}}`), NodeHeaders: map[string]string{"x-node": secret},
			})
			if got != OutcomeWritten {
				t.Fatalf("outcome %q", got)
			}
			all, _ := json.Marshal([]any{samples.rows, casesSink.rows})
			cr := casesSink.cases()[0]
			if c.keepBody {
				if cr.NodeBody == "" || cr.NodeHeaders["x-node"] != secret {
					t.Errorf("signed-out answer not kept: %q %v", cr.NodeBody, cr.NodeHeaders)
				}
				// Only the answer may hold the marker (it stands in for page content here).
				all, _ = json.Marshal([]any{samples.rows, cr.Request})
			} else if cr.NodeBody != "" || len(cr.NodeHeaders) != 0 {
				t.Errorf("Node answer kept for %s: %q %v", c.name, cr.NodeBody, cr.NodeHeaders)
			}
			if strings.Contains(string(all), secret) || strings.Contains(string(all), "198.51.100.7") {
				t.Errorf("a row holds a credential or the client address: %s", all)
			}
			if c.viewer.Class == evalcorpus.ViewerUser && (strings.Contains(string(all), "987654321") || strings.Contains(strings.ToLower(string(all)), "someviewername")) {
				t.Errorf("a row holds the viewer's id or name: %s", all)
			}
			// A signed-in mismatch keeps its differing paths' categories in the sample.
			if ss := samples.samples(); len(ss[0].DiffCategories) != 1 || ss[0].DiffCategories[0] != "items.user" {
				t.Errorf("diff categories %v", ss[0].DiffCategories)
			}
		})
	}
}

// K exemplars per (endpoint, signature, outcome class) per day: requests differing only in an id share
// a signature, so the fourth is deduped (its sample still written, with case id 0); another class has
// its own K; the identical request is admitted once; the next day starts over.
func TestRecordExemplarsPerShapeAndClass(t *testing.T) {
	r, samples, cases, clk := newRecorder(Config{})
	want := []string{OutcomeWritten, OutcomeWritten, OutcomeWritten, OutcomeDeduped}
	for i, w := range want {
		if got := r.Record(anonSample(100+i, "match")); got != w {
			t.Errorf("request %d: %q, want %q", i, got, w)
		}
	}
	if got := r.Record(anonSample(200, "unsupported")); got != OutcomeWritten {
		t.Errorf("another class: %q, want written", got)
	}
	if got := r.Record(anonSample(200, "deadline")); got != OutcomeDeduped {
		t.Errorf("the identical request again (same class handback): %q, want deduped", got)
	}
	if n := len(cases.rows); n != 4 {
		t.Errorf("%d case rows, want 4", n)
	}
	ss := samples.samples()
	if len(ss) != 6 || ss[3].CaseID != 0 || ss[5].CaseID != 0 || ss[0].CaseID == 0 {
		t.Errorf("sample rows: %d, case ids %v %v %v", len(ss), ss[0].CaseID, ss[3].CaseID, ss[5].CaseID)
	}
	clk.set(day1.Add(11 * time.Hour)) // past midnight UTC
	if got := r.Record(anonSample(103, "match")); got != OutcomeWritten {
		t.Errorf("next day: %q, want written", got)
	}
}

// Mismatches: besides an exemplar slot, a diff category still under its daily budget (per endpoint);
// a mismatch with several categories gets in on any one of them.
func TestRecordMismatchBudgetPerCategory(t *testing.T) {
	r, _, _, _ := newRecorder(Config{Exemplars: 100, MismatchesPerCategory: 2})
	mis := func(id int, cats ...string) string {
		s := anonSample(id, "fields")
		s.DiffCategories = cats
		return r.Record(s)
	}
	got := []string{mis(1, "a"), mis(2, "a"), mis(3, "a"), mis(4, "a", "b"), mis(5, "b"), mis(6, "b"), mis(7), mis(8), mis(9)}
	want := []string{OutcomeWritten, OutcomeWritten, OutcomeDeduped, OutcomeWritten, OutcomeWritten, OutcomeDeduped, OutcomeWritten, OutcomeWritten, OutcomeDeduped}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("outcomes\n %v\nwant\n %v", got, want)
	}
	// A match is not held to the mismatch budget.
	if o := r.Record(anonSample(10, "match")); o != OutcomeWritten {
		t.Errorf("match after the budget: %q", o)
	}
	// Another endpoint has its own budget.
	s := anonSample(11, "fields")
	s.Request.Endpoint = evalcorpus.EndpointModelGetAll
	s.Request.Input = `{"json":{"limit":20,"sort":"Newest"}}`
	s.DiffCategories = []string{"a"}
	if o := r.Record(s); o != OutcomeWritten {
		t.Errorf("another endpoint: %q", o)
	}
}

// The per-endpoint daily cap counts admitted cases only, per endpoint.
func TestRecordEndpointDailyCap(t *testing.T) {
	r, _, _, _ := newRecorder(Config{EndpointDailyCap: 2})
	got := []string{r.Record(anonSample(1, "match")), r.Record(anonSample(2, "fields")), r.Record(anonSample(3, "unsupported"))}
	if strings.Join(got, ",") != "written,written,deduped" {
		t.Errorf("outcomes %v", got)
	}
	s := anonSample(4, "match")
	s.Request = evalcorpus.Request{Endpoint: evalcorpus.EndpointV1ModelsID, Path: "/api/v1/models/4", Headers: map[string]string{"host": "green.example.test"}}
	if o := r.Record(s); o != OutcomeWritten {
		t.Errorf("another endpoint: %q", o)
	}
}

// A full queue drops (never waits): a refused case hands its admission back, so the next request of
// the shape is admitted; a refused sample row is dropped too.
func TestRecordFullQueueDrops(t *testing.T) {
	r, samples, cases, _ := newRecorder(Config{Exemplars: 1})
	cases.refuse = true
	if o := r.Record(anonSample(1, "match")); o != OutcomeDropped {
		t.Errorf("case refused: %q, want dropped", o)
	}
	// Its sample is still written, naming no case: no sample points at a case that was never queued.
	if ss := samples.samples(); len(ss) != 1 || ss[0].CaseID != 0 {
		t.Fatalf("samples after a refused case: %+v, want one with case id 0", ss)
	}
	cases.refuse = false
	if o := r.Record(anonSample(2, "match")); o != OutcomeWritten {
		t.Errorf("after a refused case the slot is free again: %q", o)
	}
	samples.refuse = true
	if o := r.Record(anonSample(3, "match")); o != OutcomeDropped {
		t.Errorf("sample refused (not admitted): %q, want dropped", o)
	}
	if o := r.Record(anonSample(4, "fields")); o != OutcomeDropped {
		t.Errorf("sample refused (admitted): %q, want dropped", o)
	}
}

// Over a real writer whose ClickHouse never answers: Record returns at once whatever the queue holds,
// and once the queue is full it drops.
func TestRecordNeverBlocksOnTheWriter(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(block)
	mk := func(table string) *chwrite.Writer {
		w, err := chwrite.New(chwrite.Config{URL: srv.URL + "/db", Table: table, QueueSize: 2, BatchRows: 1, RequestTimeout: 30 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		return w
	}
	samples, cases := mk(SamplesTable), mk(CasesTable)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		_ = samples.Close(ctx)
		_ = cases.Close(ctx)
	}()
	r := New(Config{Samples: samples, Cases: cases, Exemplars: 1000})
	start := time.Now()
	dropped := 0
	for i := 0; i < 50; i++ {
		if r.Record(anonSample(i, "match")) == OutcomeDropped {
			dropped++
		}
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("50 records took %v with ClickHouse not answering", d)
	}
	if dropped == 0 {
		t.Error("no capture dropped with a full queue")
	}
}

// Nothing is written for an endpoint outside the first wave (outcome "", nothing to count), a viewer
// that could not be resolved (unresolved, whatever its error) or a request that builds no case
// (invalid): neither is a lost row, so neither is dropped.
func TestRecordUnsupportedUnknownViewerAndInvalid(t *testing.T) {
	r, samples, cases, _ := newRecorder(Config{})
	s := anonSample(1, "match")
	s.Request.Endpoint = "v1-images"
	if o := r.Record(s); o != "" {
		t.Errorf("unsupported endpoint: %q, want \"\"", o)
	}
	for _, viewerErr := range []error{nil, fallback.New("bearer-token"), errors.New("boom")} {
		s = anonSample(2, "match")
		s.ViewerKnown, s.ViewerErr = false, viewerErr
		if o := r.Record(s); o != "unresolved" {
			t.Errorf("unknown viewer (err %v): %q, want unresolved", viewerErr, o)
		}
	}
	// A credential class Capture does not know builds no case.
	s = anonSample(3, "match")
	s.Request.CredentialClass = "cookie"
	if o := r.Record(s); o != "invalid" {
		t.Errorf("unknown credential class: %q, want invalid", o)
	}
	if len(samples.rows)+len(cases.rows) != 0 {
		t.Errorf("rows written: %d %d", len(samples.rows), len(cases.rows))
	}
	// The same recorder still writes a capturable request: the two above took no admission slot.
	if o := r.Record(anonSample(3, "match")); o != "written" {
		t.Errorf("after them: %q, want written", o)
	}
}

// The outcomes, in order, and the closed set of unresolved reasons, as the metrics read them.
func TestOutcomesAndUnresolvedReasons(t *testing.T) {
	if got := strings.Join(Outcomes, ","); got != "written,deduped,unresolved,invalid,dropped" {
		t.Errorf("Outcomes %s", got)
	}
	if got := strings.Join(UnresolvedReasons, ","); got != "bearer-token,session-cache-miss,session-cache-cleared,session-id-mismatch,other" {
		t.Errorf("UnresolvedReasons %s", got)
	}
}

// UnresolvedReason reads the viewer resolve's fallback reason: every bearer-* one is bearer-token,
// the three session-cache ones are themselves (a detail does not change it), anything else other.
func TestUnresolvedReason(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{fallback.New("bearer-token"), "bearer-token"},
		{fallback.New("bearer-key-cache-miss"), "bearer-token"},
		{fallback.Wrap("bearer-key-cache-miss", errors.New("redis down")), "bearer-token"},
		{fmt.Errorf("resolve: %w", fallback.New("bearer-malformed")), "bearer-token"},
		{fallback.New("session-cache-miss"), "session-cache-miss"},
		{fallback.New("session-cache-cleared"), "session-cache-cleared"},
		{fallback.Newf("session-id-mismatch", "%s", "41"), "session-id-mismatch"},
		{fallback.New("v1-models-block-token"), "other"},
		{fallback.New("session-cache-missing"), "other"},
		{errors.New("session-cache-miss"), "other"},
		{nil, "other"},
	}
	for _, c := range cases {
		if got := UnresolvedReason(c.err); got != c.want {
			t.Errorf("UnresolvedReason(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestOutcomeClass(t *testing.T) {
	for in, want := range map[string]string{
		"match": "match", "match_empty": "match", "match_cached": "match", "fields": "mismatch", "order": "mismatch",
		"membership": "mismatch", "served": "served", "handback": "handback", "unsupported": "handback", "deadline": "handback",
		"go_error": "error", "bad_request": "error", "error": "error", "corpus-only": "corpus-only",
	} {
		if got := OutcomeClass(in); got != want {
			t.Errorf("OutcomeClass(%q) = %q, want %q", in, got, want)
		}
	}
}

// NewWriters: the database is the URL's path (required), the inserts go to samples and cases, with
// date_time_input_format=best_effort and the login as basic auth.
func TestNewWriters(t *testing.T) {
	if _, _, err := NewWriters(WriterConfig{URL: "https://store.example.test:8443"}); err == nil {
		t.Error("a URL without a database path was accepted")
	}
	type seen struct{ query, db, setting, user string }
	got := make(chan seen, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		u, _, _ := r.BasicAuth()
		q := r.URL.Query()
		got <- seen{q.Get("query"), q.Get("database"), q.Get("date_time_input_format"), u}
	}))
	defer srv.Close()
	samples, cases, err := NewWriters(WriterConfig{URL: srv.URL + "/evaldb", Username: "w", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	samples.Add(SampleRow{Endpoint: "infinite"})
	cases.Add(CaseRow{Endpoint: "infinite"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = samples.Close(ctx)
	_ = cases.Close(ctx)
	queries := map[string]bool{}
	for i := 0; i < 2; i++ {
		s := <-got
		queries[s.query] = true
		if s.db != "evaldb" || s.setting != "best_effort" || s.user != "w" {
			t.Errorf("insert %+v", s)
		}
	}
	if !queries["INSERT INTO samples FORMAT JSONEachRow"] || !queries["INSERT INTO cases FORMAT JSONEachRow"] {
		t.Errorf("queries %v", queries)
	}
}

// A case never stores search text (model.getAll's `query`): it is replaced by SearchPlaceholder in the
// stored request and nowhere else in any row, other keys kept; two searches differing only in text
// share a signature and, once redacted, are the same case (the second is deduped). An empty query and
// an input without one are stored as they are.
func TestRecordRedactsSearchText(t *testing.T) {
	r, samples, cases, _ := newRecorder(Config{})
	user := evalcorpus.Viewer{Class: evalcorpus.ViewerUser, UserID: 5}
	search := func(q string) Sample {
		return Sample{
			Source: SourceServe, ViewerKnown: true, Viewer: user, ProdResult: ResultServed,
			Request: evalcorpus.Request{Endpoint: evalcorpus.EndpointModelGetAll, Headers: map[string]string{"host": "green.example.test"},
				Input: `{"json":{"limit":20,"query":` + q + `,"sort":"Newest"}}`},
		}
	}
	for _, c := range []struct{ q, want string }{
		{`"private words typed"`, OutcomeWritten}, {`"other typed words"`, OutcomeDeduped}, {`""`, OutcomeWritten},
	} {
		if o := r.Record(search(c.q)); o != c.want {
			t.Fatalf("query %s: %q, want %q", c.q, o, c.want)
		}
	}
	all, _ := json.Marshal([]any{samples.rows, cases.rows})
	if strings.Contains(string(all), "typed") {
		t.Errorf("search text stored: %s", all)
	}
	cs := cases.cases()
	inputs := make([]string, 0, len(cs))
	for _, c := range cs {
		var req StoredRequest
		_ = json.Unmarshal([]byte(c.Request), &req)
		inputs = append(inputs, req.Input)
	}
	want := []string{
		`{"json":{"limit":20,"query":"$search","sort":"Newest"}}`,
		`{"json":{"limit":20,"query":"","sort":"Newest"}}`,
	}
	if len(inputs) != len(want) {
		t.Fatalf("stored inputs %v, want %v", inputs, want)
	}
	for i := range want {
		if inputs[i] != want[i] {
			t.Errorf("stored input %d = %s, want %s", i, inputs[i], want[i])
		}
	}
	if ss := samples.samples(); len(ss) != 3 || ss[0].Sig != ss[1].Sig || ss[1].CaseID != 0 {
		t.Errorf("samples %+v: want 3, the two searches sharing a signature, the second not admitted", ss)
	}
	for in, want := range map[string]string{
		"":                     "",
		`{"json":{"limit":5}}`: `{"json":{"limit":5}}`,
		`{"json":null}`:        `{"json":null}`,
		`not json`:             "",
		`{"json":{"query":7}}`: `{"json":{"query":7}}`,
	} {
		if got := redactSearchText(in); got != want {
			t.Errorf("redactSearchText(%q) = %q, want %q", in, got, want)
		}
	}
}

// A batch ClickHouse refuses reaches WriterConfig.Dropped with its table and chwrite's reason.
func TestNewWritersDroppedCarriesTheTable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()
	var mu sync.Mutex
	got := map[string]int{}
	samples, cases, err := NewWriters(WriterConfig{URL: srv.URL + "/evaldb", Dropped: func(table string, n int, reason string) {
		mu.Lock()
		defer mu.Unlock()
		got[table+"/"+reason] += n
	}})
	if err != nil {
		t.Fatal(err)
	}
	samples.Add(SampleRow{Endpoint: "infinite"})
	cases.Add(CaseRow{Endpoint: "infinite"})
	cases.Add(CaseRow{Endpoint: "as-posts"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = samples.Close(ctx)
	_ = cases.Close(ctx)
	mu.Lock()
	defer mu.Unlock()
	if got["samples/http_4xx"] != 1 || got["cases/http_4xx"] != 2 || len(got) != 2 {
		t.Errorf("dropped %v, want samples/http_4xx 1 and cases/http_4xx 2", got)
	}
}
