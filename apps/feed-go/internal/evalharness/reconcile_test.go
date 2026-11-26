package evalharness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
)

// reconcileRun is the live run a reconcile test reads; it started at reconcileRunStart.
const reconcileRun = "live-20261126T030000Z-ab12cd"

var (
	reconcileRunStart = time.Date(2026, 11, 26, 3, 0, 0, 0, time.UTC)
	reconcileNow      = time.Date(2026, 11, 26, 9, 0, 0, 0, time.UTC)
)

// fakeCase is one case's state in the fake (the columns reconcile reads or the promotion sets).
type fakeCase struct {
	sig    uint64
	origin string
	pinned bool
	lastMS int64
}

// stateFakeCH is a ClickHouse that keeps `cases` and applies the promotion insert to it, so a second
// reconcile reads what the first wrote. Samples and results are fixed rows. It mimics the SQL
// reconcile sends (promoteSQL's guard and last_seen rule, promotedPassesSQL's join) in Go: the
// statements themselves are pinned by text and parameters, not executed here.
type stateFakeCH struct {
	mu       sync.Mutex
	cases    map[string]map[uint64]*fakeCase // endpoint -> id -> case
	samples  []map[string]any
	results  []map[string]any
	promotes []url.Values
	runRows  []string
	gets     []url.Values
}

func caseRow(sig uint64, origin string, pinned bool, last time.Time) *fakeCase {
	return &fakeCase{sig: sig, origin: origin, pinned: pinned, lastMS: last.UnixMilli()}
}

func parseIDs(t *testing.T, v string) []uint64 {
	t.Helper()
	v = strings.Trim(v, "[]")
	var out []uint64
	for _, p := range strings.Split(v, ",") {
		if p == "" {
			continue
		}
		id, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			t.Errorf("ids parameter %q", v)
			return nil
		}
		out = append(out, id)
	}
	return out
}

func (f *stateFakeCH) serve(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "eval-user" || p != "eval-pass" {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		text := q.Get("query")
		f.mu.Lock()
		defer f.mu.Unlock()
		if q.Get("database") != "evaldb" {
			t.Errorf("database %q", q.Get("database"))
		}
		var rows []map[string]any
		switch {
		case r.Method == http.MethodPost && strings.HasPrefix(text, "INSERT INTO cases ("):
			f.promotes = append(f.promotes, q)
			now, _ := strconv.ParseInt(q.Get("param_now_ms"), 10, 64)
			written := 0
			for _, id := range parseIDs(t, q.Get("param_ids")) {
				c := f.cases[q.Get("param_endpoint")][id]
				if c == nil || (c.pinned && c.origin == q.Get("param_origin")) {
					continue
				}
				c.origin, c.pinned, c.lastMS = q.Get("param_origin"), true, max(now, c.lastMS+1)
				written++
			}
			w.Header().Set("X-ClickHouse-Summary", fmt.Sprintf(`{"written_rows":"%d"}`, written))
			return
		case r.Method == http.MethodPost && text == "INSERT INTO runs FORMAT JSONEachRow":
			b, _ := io.ReadAll(r.Body)
			f.runRows = append(f.runRows, string(b))
			w.Header().Set("X-ClickHouse-Summary", `{"written_rows":"1"}`)
			return
		case r.Method == http.MethodPost:
			t.Errorf("unexpected write %q", text)
			http.Error(w, "no", http.StatusBadRequest)
			return
		}
		f.gets = append(f.gets, q)
		switch {
		case strings.Contains(text, "FROM runs"):
			if q.Get("param_phase") == PhaseLive {
				rows = []map[string]any{{"run_id": reconcileRun, "started_ms": reconcileRunStart.UnixMilli(), "from_ms": 1, "to_ms": 2, "settings": "{}"}}
			}
		case strings.Contains(text, "FROM samples"):
			rows = f.samples
		case strings.Contains(text, "INNER JOIN"):
			before, _ := strconv.ParseInt(q.Get("param_before_ms"), 10, 64)
			for _, res := range f.results {
				if res["verdict"] != q.Get("param_pass") {
					continue
				}
				id, _ := strconv.ParseUint(res["case_id"].(string), 10, 64)
				c := f.cases[res["endpoint"].(string)][id]
				if c != nil && c.pinned && c.origin == q.Get("param_origin") && c.lastMS < before {
					rows = append(rows, map[string]any{"case_id": res["case_id"], "endpoint": res["endpoint"], "sig": res["sig"]})
				}
			}
		case strings.Contains(text, "FROM results"):
			rows = f.results
		case strings.Contains(text, "FROM cases FINAL"):
			for _, id := range parseIDs(t, q.Get("param_ids")) {
				if c := f.cases[q.Get("param_endpoint")][id]; c != nil {
					pinned := 0
					if c.pinned {
						pinned = 1
					}
					rows = append(rows, map[string]any{"case_id": strconv.FormatUint(id, 10), "sig": strconv.FormatUint(c.sig, 10),
						"origin": c.origin, "pinned": pinned})
				}
			}
		default:
			t.Errorf("unexpected read %q", text)
		}
		for _, row := range rows {
			b, _ := json.Marshal(row)
			_, _ = w.Write(append(b, '\n'))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func stat(endpoint string, sig uint64, matches, mismatches int, cases ...uint64) map[string]any {
	ids := make([]string, 0, len(cases))
	for _, c := range cases {
		ids = append(ids, strconv.FormatUint(c, 10))
	}
	return map[string]any{"endpoint": endpoint, "sig": strconv.FormatUint(sig, 10), "matches": matches, "mismatches": mismatches,
		"mismatch_cases": ids}
}

func result(endpoint string, sig, id uint64, verdict string) map[string]any {
	return map[string]any{"case_id": strconv.FormatUint(id, 10), "endpoint": endpoint, "sig": strconv.FormatUint(sig, 10),
		"verdict": verdict, "reason": "", "result_class": "", "diff_categories": []string{}, "unstable_paths": []string{}}
}

// Signatures of the fixture, one per behaviour; case ids are distinct from every signature and count.
const (
	sigBlind      = 0xa1 // 3 of 100 mismatch, eval pass: a blind spot
	sigFewCount   = 0xa2 // 1 of 10 mismatch (10%, but under 2): under the thresholds
	sigFewShare   = 0xa3 // 2 of 1000 (0.2%, under 1%): under the thresholds
	sigEvalBug    = 0xa4 // prod mismatches, the eval found a bug too: agreement
	sigNotRun     = 0xa5 // over the thresholds, not in the run
	sigReverse    = 0xa6 // prod matched 50 times, the eval found a bug
	sigBugNoProd  = 0xa7 // the eval found a bug, no prod sample
	sigPromoted   = 0xa8 // blind spot whose case was promoted before the run, passed again
	sigMixedEval  = 0xa9 // prod mismatches, the eval has a pass and a bug: not all pass
	idBlind1      = 1101
	idBlind2      = 1102 // written by feed-go as prod-mismatch, unpinned: still a candidate
	idBlind3      = 1103
	idBlind4      = 1104 // over the per-signature cap
	idBlindGone   = 1199 // not in cases (expired)
	idPromotedOld = 1801 // promoted before the run started, passes: cannot reproduce
	idPromotedNew = 1802 // promoted after the run started, passes: not yet
	idReverseBug  = 1601
)

func reconcileFixture() *stateFakeCH {
	day := time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC)
	return &stateFakeCH{
		cases: map[string]map[uint64]*fakeCase{
			"as-posts": {
				idBlind1: caseRow(sigBlind, "sample", false, day), idBlind2: caseRow(sigBlind, "prod-mismatch", false, day),
				idBlind3: caseRow(sigBlind, "sample", false, day), idBlind4: caseRow(sigBlind, "sample", false, day),
				idPromotedOld: caseRow(sigPromoted, "prod-mismatch", true, reconcileRunStart.Add(-time.Hour)),
				idPromotedNew: caseRow(sigPromoted, "prod-mismatch", true, reconcileRunStart.Add(time.Hour)),
				7001:          caseRow(sigBlind, "sample", false, day), // the run's exemplar of sigBlind
				2001:          caseRow(sigFewCount, "prod-mismatch", false, day),
				3001:          caseRow(sigFewShare, "prod-mismatch", false, day),
				3002:          caseRow(sigFewShare, "prod-mismatch", false, day),
			},
		},
		samples: []map[string]any{
			stat("as-posts", sigBlind, 97, 3, idBlind4, idBlind2, idBlind1, idBlindGone, idBlind3),
			stat("as-posts", sigFewCount, 9, 1, 2001),
			stat("as-posts", sigFewShare, 998, 2, 3001, 3002),
			stat("as-posts", sigEvalBug, 5, 5, 4001),
			stat("infinite", sigNotRun, 0, 4, 5001),
			stat("as-posts", sigReverse, 50, 0),
			stat("as-posts", sigPromoted, 8, 2, idPromotedOld),
			stat("model-getall", sigMixedEval, 10, 10, 9001),
		},
		results: []map[string]any{
			result("as-posts", sigBlind, 7001, VerdictPass),
			result("as-posts", sigFewCount, 7002, VerdictPass),
			result("as-posts", sigFewShare, 7003, VerdictPass),
			result("as-posts", sigEvalBug, 7004, VerdictBug),
			result("as-posts", sigReverse, idReverseBug, VerdictBug),
			result("as-posts", sigBugNoProd, 7007, VerdictBug),
			result("as-posts", sigPromoted, idPromotedOld, VerdictPass),
			result("as-posts", sigPromoted, idPromotedNew, VerdictPass),
			result("model-getall", sigMixedEval, 7009, VerdictPass),
			result("model-getall", sigMixedEval, 7010, VerdictBug),
			// A retried insert's duplicate: counted once.
			result("as-posts", sigBlind, 7001, VerdictPass),
		},
	}
}

func reconcileStore(t *testing.T, f *stateFakeCH) *CHReconcileStore {
	t.Helper()
	srv := f.serve(t)
	s, err := NewCHReconcileStore(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func reconcileCfg() ReconcileConfig {
	return ReconcileConfig{Now: func() time.Time { return reconcileNow }}
}

func TestReconcileClassifiesEachDisagreement(t *testing.T) {
	f := reconcileFixture()
	sum, err := Reconcile(context.Background(), reconcileCfg(), reconcileStore(t, f))
	if err != nil {
		t.Fatal(err)
	}
	wantCounts := map[string]int{
		ClassBlindSpot: 2, ClassCannotReproduce: 1, ClassReverse: 1, "promoted": 3, "rows_written": 3, "already_promoted": 1,
		"candidate_missing": 1, "promotion_capped": 0, "mismatch_not_run": 1,
	}
	for k, v := range wantCounts {
		if sum.Counts[k] != v {
			t.Errorf("count %s = %d, want %d", k, sum.Counts[k], v)
		}
	}
	if len(sum.Counts) != len(wantCounts) {
		t.Errorf("counts %v", sum.Counts)
	}
	if sum.ReconciledRun != reconcileRun {
		t.Errorf("reconciled run %q", sum.ReconciledRun)
	}
	// Blind spots: sigBlind first (3 mismatches, before sigPromoted's 2). Its candidates in id order:
	// 1101, 1102 (feed-go's unpinned prod-mismatch row is not a promotion), 1103; 1104 over the cap
	// of 3; 1199 not in cases.
	wantBlind := []Finding{
		{Endpoint: "as-posts", Sig: "00000000000000a1", Compared: 100, Mismatches: 3, EvalResults: 1,
			CaseIDs: []string{HexID(idBlind1), HexID(idBlind2), HexID(idBlind3)}, Promoted: 3},
		{Endpoint: "as-posts", Sig: "00000000000000a8", Compared: 10, Mismatches: 2, EvalResults: 2,
			CaseIDs: []string{HexID(idPromotedOld)}, Promoted: 0},
	}
	if !findingsEqual(sum.BlindSpots, wantBlind) {
		t.Errorf("blind spots\n got %+v\nwant %+v", sum.BlindSpots, wantBlind)
	}
	wantCannot := []Finding{{Endpoint: "as-posts", Sig: "00000000000000a8", Compared: 10, Mismatches: 2, EvalResults: 2,
		CaseIDs: []string{HexID(idPromotedOld)}}}
	if !findingsEqual(sum.CannotReproduce, wantCannot) {
		t.Errorf("cannot reproduce\n got %+v\nwant %+v", sum.CannotReproduce, wantCannot)
	}
	wantReverse := []Finding{{Endpoint: "as-posts", Sig: "00000000000000a6", Compared: 50, Mismatches: 0, EvalResults: 1,
		CaseIDs: []string{HexID(idReverseBug)}}}
	if !findingsEqual(sum.Reverse, wantReverse) {
		t.Errorf("reverse\n got %+v\nwant %+v", sum.Reverse, wantReverse)
	}
	// The promotion: one insert, the three ids, the harness rule's clock, pinned.
	if len(f.promotes) != 1 {
		t.Fatalf("%d promotion inserts", len(f.promotes))
	}
	p := f.promotes[0]
	if p.Get("query") != promoteSQL || p.Get("param_endpoint") != "as-posts" || p.Get("param_ids") != "[1101,1102,1103]" ||
		p.Get("param_origin") != "prod-mismatch" || p.Get("param_now_ms") != strconv.FormatInt(reconcileNow.UnixMilli(), 10) ||
		p.Get("date_time_input_format") != "best_effort" {
		t.Errorf("promotion %v", p)
	}
	for _, id := range []uint64{idBlind1, idBlind2, idBlind3} {
		if c := f.cases["as-posts"][id]; !c.pinned || c.origin != "prod-mismatch" || c.lastMS != reconcileNow.UnixMilli() {
			t.Errorf("case %d after promotion: %+v", id, c)
		}
	}
	if c := f.cases["as-posts"][idBlind4]; c.pinned {
		t.Error("the case over the per-signature cap was promoted")
	}
	// The summary row.
	if len(f.runRows) != 1 {
		t.Fatalf("%d runs rows", len(f.runRows))
	}
	var row RunRow
	if err := json.Unmarshal([]byte(strings.TrimSpace(f.runRows[0])), &row); err != nil {
		t.Fatal(err)
	}
	if row.Phase != PhaseReconcile || !runIDRE.MatchString(row.RunID) || !strings.HasPrefix(row.RunID, "reconcile-20261126T090000Z-") ||
		row.CorpusFrom != "2026-11-25T09:00:00.000Z" || row.CorpusTo != "2026-11-26T09:00:00.000Z" || row.Started != "2026-11-26T09:00:00.000Z" {
		t.Errorf("runs row %+v", row)
	}
	var back ReconcileSummary
	if err := json.Unmarshal([]byte(row.Settings), &back); err != nil || back.Counts[ClassBlindSpot] != 2 || len(back.BlindSpots) != 2 {
		t.Errorf("settings %s (%v)", row.Settings, err)
	}
	// Every read carried its values as parameters, never in the text.
	for _, q := range f.gets {
		for _, v := range []string{reconcileRun, "as-posts", "prod-mismatch", "1101", "shadow"} {
			if strings.Contains(q.Get("query"), v) {
				t.Errorf("query text holds %q: %s", v, q.Get("query"))
			}
		}
		if q.Get("query") == chread.WireQuery(sampleStatsSQL) {
			if q.Get("param_sources") != "['shadow','serve-parity']" || q.Get("param_mismatch") != "['fields','order','membership']" ||
				q.Get("param_match") != "['match','match_empty','match_cached']" ||
				q.Get("param_from_ms") != strconv.FormatInt(reconcileNow.Add(-24*time.Hour).UnixMilli(), 10) {
				t.Errorf("samples parameters %v", q)
			}
		}
		if q.Get("query") == chread.WireQuery(promotedPassesSQL) && q.Get("param_before_ms") != strconv.FormatInt(reconcileRunStart.UnixMilli(), 10) {
			t.Errorf("promoted passes before %q, want the run's start", q.Get("param_before_ms"))
		}
	}
}

func findingsEqual(a, b []Finding) bool {
	return slices.EqualFunc(a, b, func(x, y Finding) bool {
		return x.Endpoint == y.Endpoint && x.Sig == y.Sig && x.Compared == y.Compared && x.Mismatches == y.Mismatches &&
			x.EvalResults == y.EvalResults && x.Promoted == y.Promoted && slices.Equal(x.CaseIDs, y.CaseIDs)
	})
}

// TestReconcileIsIdempotent: a second reconcile over the same samples and run promotes nothing again
// (no promotion insert at all), counts the earlier promotions as already promoted, and does not list
// them as cannot-reproduce (promoted after the run started).
func TestReconcileIsIdempotent(t *testing.T) {
	f := reconcileFixture()
	store := reconcileStore(t, f)
	if _, err := Reconcile(context.Background(), reconcileCfg(), store); err != nil {
		t.Fatal(err)
	}
	snapshot := map[uint64]fakeCase{}
	for id, c := range f.cases["as-posts"] {
		snapshot[id] = *c
	}
	cfg := reconcileCfg()
	cfg.Now = func() time.Time { return reconcileNow.Add(10 * time.Minute) }
	sum, err := Reconcile(context.Background(), cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.promotes) != 1 {
		t.Errorf("%d promotion inserts over two reconciles, want 1", len(f.promotes))
	}
	if sum.Counts["promoted"] != 0 || sum.Counts["rows_written"] != 0 || sum.Counts["already_promoted"] != 4 || sum.Counts[ClassCannotReproduce] != 1 {
		t.Errorf("second reconcile counts %v", sum.Counts)
	}
	for id, c := range f.cases["as-posts"] {
		if *c != snapshot[id] {
			t.Errorf("case %d changed by the second reconcile: %+v -> %+v", id, snapshot[id], *c)
		}
	}
	if sum.BlindSpots[0].Promoted != 0 || !slices.Equal(sum.BlindSpots[0].CaseIDs, []string{HexID(idBlind1), HexID(idBlind2), HexID(idBlind3)}) {
		t.Errorf("second reconcile blind spot %+v", sum.BlindSpots[0])
	}
}

// TestReconcileThresholdsAreBoth: each threshold alone flags the signature the other spares.
func TestReconcileThresholdsAreBoth(t *testing.T) {
	for _, c := range []struct {
		name         string
		minN         int
		minShare     float64
		wantBlind    []string
		wantPromoted int
	}{
		{"defaults", 0, 0, []string{"00000000000000a1", "00000000000000a8"}, 3},
		{"count 1: the 10% signature joins", 1, 0, []string{"00000000000000a1", "00000000000000a8", "00000000000000a2"}, 4},
		{"share 0.001: the 0.2% signature joins", 0, 0.001, []string{"00000000000000a1", "00000000000000a3", "00000000000000a8"}, 5},
		{"count 4: none", 4, 0, nil, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := reconcileFixture()
			cfg := reconcileCfg()
			cfg.MinMismatches, cfg.MinMismatchShare, cfg.DryRun = c.minN, c.minShare, true
			sum, err := Reconcile(context.Background(), cfg, reconcileStore(t, f))
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, 0, len(sum.BlindSpots))
			for _, b := range sum.BlindSpots {
				got = append(got, b.Sig)
			}
			if !slices.Equal(got, c.wantBlind) || sum.Counts["promoted"] != c.wantPromoted {
				t.Errorf("blind spots %v promoted %d, want %v and %d", got, sum.Counts["promoted"], c.wantBlind, c.wantPromoted)
			}
			if len(f.promotes) != 0 || len(f.runRows) != 0 {
				t.Error("a dry run wrote")
			}
		})
	}
}

func TestReconcileCapsPromotions(t *testing.T) {
	f := reconcileFixture()
	cfg := reconcileCfg()
	cfg.MaxPromotions = 2
	sum, err := Reconcile(context.Background(), cfg, reconcileStore(t, f))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Counts["promoted"] != 2 || sum.Counts["promotion_capped"] != 1 || f.promotes[0].Get("param_ids") != "[1101,1102]" {
		t.Errorf("counts %v ids %q", sum.Counts, f.promotes[0].Get("param_ids"))
	}
}

func TestReconcileNeedsALiveRun(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	s, err := NewCHReconcileStore(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Reconcile(context.Background(), reconcileCfg(), s); err == nil || !strings.Contains(err.Error(), "no live run") {
		t.Errorf("err %v", err)
	}
}

// TestCHExecReportsRefusalWithoutBody: a refused write names the status and the exception code, never
// the server's message (it can quote a row of the body).
func TestCHExecReportsRefusalWithoutBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("X-ClickHouse-Exception-Code", "27")
		http.Error(w, "Code: 27. Cannot parse input: CANARYROWVALUE", http.StatusBadRequest)
	}))
	defer srv.Close()
	e, err := NewCHExec(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.Exec(context.Background(), insertCasesSQL, nil, []byte(`{"request":"CANARYROWVALUE"}`))
	if err == nil || err.Error() != "clickhouse: write refused: http 400, code 27" {
		t.Errorf("err %v", err)
	}
}

// TestInsertCasesBatches: rows go insertBatch at a time, each acknowledged, the written counts
// summed; the first refusal ends it with what was written before it.
func TestInsertCasesBatches(t *testing.T) {
	var (
		mu     sync.Mutex
		counts []int
	)
	refuseAfter := 2
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Get("query") != insertCasesSQL || r.Method != http.MethodPost {
			t.Errorf("%s %q", r.Method, r.URL.Query().Get("query"))
		}
		if len(counts) == refuseAfter {
			w.Header().Set("X-ClickHouse-Exception-Code", "not-a-number")
			http.Error(w, "refused", http.StatusServiceUnavailable)
			return
		}
		n := strings.Count(string(b), "\n")
		counts = append(counts, n)
		w.Header().Set("X-ClickHouse-Summary", fmt.Sprintf(`{"written_rows":"%d"}`, n))
	}))
	defer srv.Close()
	e, err := NewCHExec(CHConfig{URL: srv.URL + "/evaldb", Username: "eval-user", Password: "eval-pass"})
	if err != nil {
		t.Fatal(err)
	}
	rows := make([]evalcapture.CaseRow, 1001)
	for i := range rows {
		rows[i] = evalcapture.CaseRow{CaseID: uint64(i + 1), NodeHeaders: map[string]string{}} //nolint:gosec // G115: i is a small index
	}
	mu.Lock()
	refuseAfter = 99
	mu.Unlock()
	n, err := InsertCases(context.Background(), e, rows)
	if err != nil || n != 1001 || !slices.Equal(counts, []int{500, 500, 1}) {
		t.Fatalf("written %d, err %v, batches %v; want 1001 in [500 500 1]", n, err, counts)
	}
	mu.Lock()
	counts, refuseAfter = nil, 1
	mu.Unlock()
	n, err = InsertCases(context.Background(), e, rows)
	if err == nil || err.Error() != "clickhouse: write refused: http 503, code ?" || n != 500 {
		t.Errorf("refused second batch: written %d, err %v", n, err)
	}
}

func TestNewCHExecRefusesABadConfig(t *testing.T) {
	for _, c := range []CHConfig{
		{URL: "http://h.example/db", Username: "u"},
		{URL: "ftp://h.example/db", Username: "u", Password: "p"},
		{URL: "http://h.example/", Username: "u", Password: "p"},
	} {
		if _, err := NewCHExec(c); err == nil {
			t.Errorf("%+v: no error", c)
		}
	}
	// A transport error carries no URL (it holds the query's parameters).
	e, err := NewCHExec(CHConfig{URL: "http://127.0.0.1:1/evaldb", Username: "u", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.Exec(context.Background(), insertCasesSQL, []chread.Setting{param("ids", "[424242]")}, nil)
	if err == nil || strings.Contains(err.Error(), "424242") {
		t.Errorf("transport error %v", err)
	}
}

// failingStore fails at one step; every other step answers what the fixture would, minimally.
type failingStore struct {
	failAt string
	stats  []SigStats
}

func (s failingStore) fail(step string) error {
	if s.failAt == step {
		return fmt.Errorf("%s failed", step)
	}
	return nil
}

func (s failingStore) LatestRun(context.Context, string) (RunFacts, error) {
	return RunFacts{RunID: reconcileRun, Started: reconcileRunStart}, s.fail("run")
}

func (s failingStore) SampleStats(context.Context, time.Time, time.Time) ([]SigStats, error) {
	return s.stats, s.fail("samples")
}

func (s failingStore) RunResults(context.Context, string) ([]ResultFacts, error) {
	return []ResultFacts{{CaseID: 7001, Endpoint: "as-posts", Sig: sigBlind, Verdict: VerdictPass}}, s.fail("results")
}

func (s failingStore) PromotedPasses(context.Context, string, time.Time) ([]ResultFacts, error) {
	return nil, s.fail("passes")
}

func (s failingStore) CaseMeta(_ context.Context, _ string, ids []uint64) (map[uint64]CaseMeta, error) {
	out := map[uint64]CaseMeta{}
	for _, id := range ids {
		out[id] = CaseMeta{Sig: sigBlind, Origin: "sample"}
	}
	return out, s.fail("meta")
}

func (s failingStore) Promote(_ context.Context, _ string, ids []uint64, _ time.Time) (uint64, error) {
	return uint64(len(ids)), s.fail("promote")
}

func (s failingStore) AddRun(context.Context, RunRow) error { return s.fail("addrun") }

// TestReconcileFailsAtEachStep: a store error at any step fails the reconcile naming the step, and
// a failure before the summary row writes no summary row.
func TestReconcileFailsAtEachStep(t *testing.T) {
	stats := []SigStats{{Endpoint: "as-posts", Sig: sigBlind, Matches: 7, Mismatches: 3, MismatchCases: []uint64{1101}}}
	for _, step := range []string{"run", "samples", "results", "meta", "passes", "promote", "addrun"} {
		_, err := Reconcile(context.Background(), reconcileCfg(), failingStore{failAt: step, stats: stats})
		if err == nil || !strings.Contains(err.Error(), step+" failed") {
			t.Errorf("%s: err %v", step, err)
		}
	}
	sum, err := Reconcile(context.Background(), reconcileCfg(), failingStore{stats: stats})
	if err != nil || sum.Counts["promoted"] != 1 || sum.Counts["rows_written"] != 1 {
		t.Errorf("no failure: %v %v", sum.Counts, err)
	}
}
