package evalharness

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// Canaries: values the corpus holds that must never reach a page. The value-bearing ones (input,
// node body, search text, username, result class) are token-shaped (no space, nothing safeToken
// would redact), so their absence is the structural guard's (publish never selects those columns,
// and the report types have no field for them), not the redaction's. Each sits in a column a fake
// ClickHouse sends with EVERY row it answers, whatever was selected. The free-text columns publish
// does show (a reason, a category, a path, an account role) carry ones with spaces: redacted.
const (
	canaryInput    = "CANARYINPUT7731"
	canaryBody     = "CANARYNODEBODY8842"
	canarySearch   = "CANARYSEARCH9953"
	canaryUsername = "CANARYUSERNAME6624"
	canaryReason   = "CANARY REASON 5515"
	canaryCategory = "items.*.CANARY CATEGORY 4406"
	canaryPath     = "$.json.CANARY PATH 3397"
	canaryClass    = "CANARYCLASS2288"
	canaryRole     = "Bad Role CANARYROLE1179"
)

var canaries = []string{canaryInput, canaryBody, canarySearch, canaryUsername, "CANARY REASON", "CANARY CATEGORY", "CANARY PATH",
	canaryClass, "CANARYROLE1179", "CANARYSETTING1"}

// Token-shaped values in the shown columns: a reason, a diff category and a mask path ARE shown, by
// design. They are not request inputs: a reason is a fallback reason or the harness's own, a category
// and a path are answer key paths (opaque subtrees truncated). Pinned so the design is explicit.
const (
	tokReason   = "canaryTokReason9Q7z"
	tokCategory = "items.*.canaryTokCat4"
	tokPath     = "$.json.canaryTokPath5"
)

const (
	runNew = "live-20261126T030000Z-aa11bb"
	runOld = "live-20261125T030000Z-cc22dd"
)

// withCanaryColumns adds the value-bearing columns to a JSONEachRow row.
func withCanaryColumns(row map[string]any) string {
	row["request"] = `{"input":"{\"json\":{\"query\":\"` + canarySearch + `\",\"username\":\"` + canaryUsername + `\",\"x\":\"` + canaryInput + `\"}}"}`
	row["node_body"] = `{"json":{"items":[{"title":"` + canaryBody + `"}]}}`
	row["input"] = canaryInput
	row["username"] = canaryUsername
	b, _ := json.Marshal(row)
	return string(b) + "\n"
}

func publishFakeCH(t *testing.T) (*fakeCH, *chread.Client) {
	t.Helper()
	f, srv := newFakeCH(t, func(q url.Values) string {
		text := q.Get("query")
		var rows []map[string]any
		switch {
		case strings.Contains(text, "FROM runs"):
			rows = []map[string]any{
				{"run_id": runNew, "started_ms": 1764126000000, "from_ms": 1761534000000, "to_ms": 1764126000000,
					"settings": `{"end_reason":"window-closed","note":"CANARYSETTING1","accounts":[` +
						`{"role":"member-mature","expires":"2026-11-29T05:00:00Z","state":"expiring"},` +
						`{"role":"` + canaryRole + `","expires":"x","state":"weird"}]}`},
				{"run_id": runOld, "started_ms": 1764039600000, "from_ms": 1761447600000, "to_ms": 1764039600000, "settings": `{"end_reason":"done"}`},
				{"run_id": "not a run id " + canaryInput, "started_ms": 1, "settings": "{}"},
			}
		case strings.Contains(text, "count()"):
			rows = []map[string]any{
				{"run_id": runNew, "endpoint": "as-posts", "verdict": "pass", "n": 2},
				{"run_id": runNew, "endpoint": "as-posts", "verdict": "gap", "n": 2},
				{"run_id": runOld, "endpoint": "as-posts", "verdict": "pass", "n": 7},
			}
		case strings.Contains(text, "FROM results"):
			rows = []map[string]any{
				{"case_id": "4096", "endpoint": "as-posts", "sig": "11", "verdict": "pass", "reason": "", "result_class": "match", "diff_categories": []string{}, "unstable_paths": []string{}},
				{"case_id": "4097", "endpoint": "as-posts", "sig": "12", "verdict": "gap", "reason": "model-getall-off", "result_class": "", "diff_categories": []string{}, "unstable_paths": []string{}},
				{"case_id": "4098", "endpoint": "as-posts", "sig": "13", "verdict": "gap", "reason": canaryReason, "result_class": "", "diff_categories": []string{}, "unstable_paths": []string{}},
				{"case_id": "4099", "endpoint": "as-posts", "sig": "14", "verdict": "bug", "reason": "", "result_class": canaryClass, "diff_categories": []string{"items.*.stats.likeCount", canaryCategory, tokCategory}, "unstable_paths": []string{}},
				{"case_id": "4100", "endpoint": "as-posts", "sig": "15", "verdict": "node_unstable", "reason": "body", "result_class": "fields", "diff_categories": []string{}, "unstable_paths": []string{"$.json.items[*].stats.viewCount", canaryPath, tokPath}},
				{"case_id": "4101", "endpoint": "as-posts", "sig": "99", "verdict": "not_replayable", "reason": "viewer:moderator", "result_class": "", "diff_categories": []string{}, "unstable_paths": []string{}},
				{"case_id": "4102", "endpoint": "infinite", "sig": "21", "verdict": "gap", "reason": tokReason, "result_class": "", "diff_categories": []string{}, "unstable_paths": []string{}},
				// A retried insert's duplicate: counted once.
				{"case_id": "4096", "endpoint": "as-posts", "sig": "11", "verdict": "pass", "reason": "", "result_class": "match", "diff_categories": []string{}, "unstable_paths": []string{}},
			}
		case strings.Contains(text, "FROM samples"):
			rows = []map[string]any{
				{"endpoint": "as-posts", "sig": "11", "w": 50}, {"endpoint": "as-posts", "sig": "12", "w": 20},
				{"endpoint": "as-posts", "sig": "13", "w": 5}, {"endpoint": "as-posts", "sig": "14", "w": 5},
				{"endpoint": "as-posts", "sig": "15", "w": 10}, {"endpoint": "as-posts", "sig": "99", "w": 10},
				{"endpoint": "infinite", "sig": "21", "w": 3},
			}
		}
		var out strings.Builder
		for _, r := range rows {
			out.WriteString(withCanaryColumns(r))
		}
		return out.String()
	})
	read, err := NewCHReader(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	return f, read
}

func TestPublishNeverShowsAnInputValue(t *testing.T) {
	f, read := publishFakeCH(t)
	dir := t.TempDir()
	ids, err := Publish(context.Background(), PublishConfig{Prefix: "feed-eval", DryRunDir: dir}, read)
	if err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"feed-eval", "feed-eval-as-posts", "feed-eval-infinite", "feed-eval-model-getall", "feed-eval-v1-models-id"}
	if !slices.Equal(ids, wantIDs) {
		t.Fatalf("ids %v", ids)
	}
	var all strings.Builder
	for _, id := range ids {
		b, err := os.ReadFile(filepath.Join(dir, id+".html")) //nolint:gosec // G304: the test's own temp dir
		if err != nil {
			t.Fatal(err)
		}
		all.Write(b)
	}
	out := all.String()
	for _, c := range canaries {
		if strings.Contains(out, c) {
			t.Errorf("a page holds %q", c)
		}
	}
	// Positive control: what the pages must show did reach them (so the absence above is not a
	// renderer that shows nothing).
	page, _ := os.ReadFile(filepath.Join(dir, "feed-eval-as-posts.html")) //nolint:gosec // G304: the test's own temp dir
	for _, want := range []string{
		"model-getall-off", Redacted, "items.*.stats.likeCount", "$.json.items[*].stats.viewCount",
		"0000000000001001", // case 4097, a gap example
		"0000000000001003", // case 4099, a bug example
		runNew, runOld, "window-closed",
		"80.0%",                     // coverage: sigs 11-14, whose cases exercised Go (80 of 100); 15 is node_unstable, 99 not_replayable
		"20.0%",                     // the model-getall-off gap's traffic
		"viewer:moderator", "10.0%", // not_replayable by reason, and its traffic
		tokCategory, tokPath, // shown by design (see tokReason)
	} {
		if !strings.Contains(string(page), want) {
			t.Errorf("the as-posts page lacks %q", want)
		}
	}
	infinite, _ := os.ReadFile(filepath.Join(dir, "feed-eval-infinite.html")) //nolint:gosec // G304: the test's own temp dir
	if !strings.Contains(string(infinite), tokReason) {
		t.Error("a token-shaped gap reason is shown by design; the infinite page lacks it")
	}
	index, _ := os.ReadFile(filepath.Join(dir, "feed-eval.html")) //nolint:gosec // G304: the test's own temp dir
	for _, want := range []string{"member-mature", "2026-11-29 05:00 UTC", "expiring", Redacted} {
		if !strings.Contains(string(index), want) {
			t.Errorf("the index lacks %q (account notes)", want)
		}
	}
	// Every read carried its values as parameters.
	gets := f.reads()
	for _, q := range gets {
		text := q.Get("query")
		for _, v := range []string{runNew, runOld, "'live'", "1761534000000"} {
			if strings.Contains(text, v) {
				t.Errorf("query text holds %q: %s", v, text)
			}
		}
	}
	if got := paramOf(gets, "param_run"); got != runNew {
		t.Errorf("param_run %q", got)
	}
	if got := paramOf(gets, "param_runs"); got != "['"+runNew+"','"+runOld+"']" {
		t.Errorf("param_runs %q", got)
	}
	if got := paramOf(gets, "param_from_ms"); got != "1761534000000" {
		t.Errorf("param_from_ms %q", got)
	}
}

func paramOf(gets []url.Values, name string) string {
	for _, q := range gets {
		if v := q.Get(name); v != "" {
			return v
		}
	}
	return ""
}

// TestReportTypesHoldNoValueField: the report a page is rendered from has only the fields below. A
// field added to it (one a request input or a response value could be put in) fails here until it
// is reviewed and listed.
func TestReportTypesHoldNoValueField(t *testing.T) {
	want := map[string][]string{
		"EndpointPage": {"ID", "Endpoint", "RunID", "Started", "EndReason", "Cases", "CoveragePct", "Totals", "NotReplayable", "Gaps", "Bugs", "Unstable", "Trend", "Verdicts"},
		"IndexPage":    {"ID", "RunID", "Started", "EndReason", "Endpoints", "Verdicts", "Accounts"},
		"ReasonRow":    {"Reason", "N", "TrafficPct"},
		"AccountRow":   {"Role", "Expires", "State"},
		"AccountNote":  {"Role", "Expires", "State"},
		"VerdictTotal": {"Verdict", "N", "WeightedPct"},
		"GapRow":       {"Reason", "N", "TrafficPct", "Examples"},
		"BugRow":       {"Category", "N", "Examples"},
		"UnstableRow":  {"Path", "N"},
		"TrendRow":     {"RunID", "Started", "Counts"},
		"ResultFacts":  {"CaseID", "Endpoint", "Sig", "Verdict", "Reason", "ResultClass", "DiffCategories", "UnstablePaths"},
		"RunFacts":     {"RunID", "Started", "CorpusFrom", "CorpusTo", "EndReason", "Accounts"},
	}
	got := map[string][]string{
		"EndpointPage": fieldNames(EndpointPage{}), "IndexPage": fieldNames(IndexPage{}), "VerdictTotal": fieldNames(VerdictTotal{}),
		"GapRow": fieldNames(GapRow{}), "BugRow": fieldNames(BugRow{}), "UnstableRow": fieldNames(UnstableRow{}),
		"TrendRow": fieldNames(TrendRow{}), "ResultFacts": fieldNames(ResultFacts{}), "RunFacts": fieldNames(RunFacts{}),
		"ReasonRow": fieldNames(ReasonRow{}), "AccountRow": fieldNames(AccountRow{}), "AccountNote": fieldNames(AccountNote{}),
	}
	for k, w := range want {
		if !slices.Equal(got[k], w) {
			t.Errorf("%s fields %v, want %v", k, got[k], w)
		}
	}
}

func TestPublishPutsToHQ(t *testing.T) {
	_, read := publishFakeCH(t)
	type put struct {
		method, path, auth, ctype string
		body                      map[string]any
	}
	var (
		mu       sync.Mutex
		received []put
	)
	hq := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		mu.Lock()
		received = append(received, put{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), body})
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer hq.Close()
	cfg := PublishConfig{Prefix: "evalpages", Endpoints: []string{evalcorpus.EndpointAsPosts},
		HQ: &HQClient{BaseURL: hq.URL + "/", Token: "hq-token-5150"}} //nolint:gosec // G101: a test token for a test server
	if _, err := Publish(context.Background(), cfg, read); err != nil {
		t.Fatal(err)
	}
	getPuts := func() []put {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(received)
	}
	if len(getPuts()) != 2 {
		t.Fatalf("%d puts", len(getPuts()))
	}
	puts := getPuts()
	for i, wantPath := range []string{"/api/v1/pages/evalpages", "/api/v1/pages/evalpages-as-posts"} {
		p := puts[i]
		if p.method != http.MethodPut || p.path != wantPath || p.auth != "Bearer hq-token-5150" || p.ctype != "application/json" {
			t.Errorf("put %d: %+v", i, p)
		}
		keys := make([]string, 0, len(p.body))
		for k := range p.body {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		if !slices.Equal(keys, []string{"html", "summary", "title"}) {
			t.Errorf("put %d keys %v (no viewers unless given)", i, keys)
		}
	}
	if s, _ := puts[1].body["summary"].(string); s != "as-posts: 1 pass, 1 bug, 2 gap, 1 node_unstable, 1 not_replayable, coverage 80.0%" {
		t.Errorf("summary %q", s)
	}
	// Viewers, when given, are sent.
	mu.Lock()
	received = nil
	mu.Unlock()
	cfg.Viewers = []string{"team-a", "team-b"}
	if _, err := Publish(context.Background(), cfg, read); err != nil {
		t.Fatal(err)
	}
	puts = getPuts()
	if v, _ := puts[0].body["viewers"].([]any); len(v) != 2 || v[0] != "team-a" || v[1] != "team-b" {
		t.Errorf("viewers %v", puts[0].body["viewers"])
	}
	// An HQ refusal is an error.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer bad.Close()
	cfg.HQ = &HQClient{BaseURL: bad.URL, Token: "t"}
	if _, err := Publish(context.Background(), cfg, read); err == nil || !strings.Contains(err.Error(), "http 403") {
		t.Errorf("refused put: %v", err)
	}
}

func TestPageIDsAreValidated(t *testing.T) {
	f := Facts{Runs: []RunFacts{{RunID: runNew}}}
	for _, prefix := range []string{"Feed-eval", "feed_eval", "9feed", strings.Repeat("a", 30)} {
		if _, err := Aggregate(f, []string{evalcorpus.EndpointV1ModelsID}, prefix); err == nil {
			t.Errorf("prefix %q: no error", prefix)
		}
	}
	if _, err := Aggregate(f, []string{evalcorpus.EndpointV1ModelsID}, strings.Repeat("a", 26)); err != nil {
		t.Errorf("a 39-character id is valid: %v", err)
	}
	if err := (&HQClient{BaseURL: "http://h.example"}).Put(context.Background(), "Bad Id", Page{}); err == nil {
		t.Error("Put with an invalid id")
	}
}

// fieldNames is a struct's field names, in order.
func fieldNames(v any) []string {
	t := reflect.TypeOf(v)
	out := make([]string, 0, t.NumField())
	for i := range t.NumField() {
		out = append(out, t.Field(i).Name)
	}
	return out
}
