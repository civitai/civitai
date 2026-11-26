package evalharness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// `feed-eval reconcile` (DESIGN.md §19.9) holds production's verdicts against the eval's: run nightly
// after `run`, it reads the last day's samples and the newest live run's results and reports where
// the two disagree. Production is the reference: a shape production mismatches on that the eval
// passes is a defect of the eval (its exemplar did not exercise what production did), never a reason
// to trust the eval over production.
//
// It writes no new column and no new table: its findings are one `runs` row of phase
// PhaseReconcile whose `settings` is the ReconcileSummary (counts, endpoints, signatures and opaque
// case ids only), and a blind spot's promotion is a `cases` re-insert under the §19.6 harness rule.

// PhaseReconcile is the `runs.phase` of a reconcile's summary row. run and publish select phase
// PhaseLive, so neither reads it as a run.
const PhaseReconcile = "reconcile"

// Finding classes (ReconcileSummary).
const (
	// ClassBlindSpot: production mismatched on a signature over the thresholds, and every eval
	// result for it in the newest run passed. Its mismatching cases are promoted.
	ClassBlindSpot = "blind-spot"
	// ClassCannotReproduce: a promoted case (origin prod-mismatch, pinned, promoted before the run
	// started) that passed in the newest run: the eval cannot reproduce what production saw (the
	// signature too coarse, the viewer substituted, time skew). For a human to resolve.
	ClassCannotReproduce = "cannot-reproduce"
	// ClassReverse: the eval found a bug on a signature production compared and matched every time
	// in the window: likely an artifact of the replay (the viewer substituted), for a human to check.
	ClassReverse = "reverse"
)

// Defaults of ReconcileConfig's zero fields.
const (
	DefaultReconcileWindow     = 24 * time.Hour
	DefaultMinMismatches       = 2
	DefaultMinMismatchShare    = 0.01
	DefaultPromotePerSignature = 3
	DefaultMaxPromotions       = 500
	// maxFindings bounds each class's list in the summary row (the counts are always whole).
	maxFindings = 200
	// maxMismatchCases bounds the mismatching case ids read per signature (the promotion candidates).
	maxMismatchCases = 64
	// idChunk bounds the ids one query parameter carries.
	idChunk = 500
)

// ReconcileConfig is one reconcile.
type ReconcileConfig struct {
	// Window is how far back from now the samples are read.
	Window time.Duration
	// A signature is over the thresholds when its compared samples (shadow and serve-parity, a match
	// or a mismatch result) in the window hold at least MinMismatches mismatches AND at least
	// MinMismatchShare of them are mismatches. Both must hold.
	MinMismatches    int
	MinMismatchShare float64
	// PromotePerSignature bounds a blind spot's promoted cases (those already promoted count);
	// MaxPromotions bounds one reconcile's new promotions.
	PromotePerSignature int
	MaxPromotions       int
	// DryRun computes the summary and writes nothing.
	DryRun bool
	Now    func() time.Time
	Log    io.Writer
}

func (c *ReconcileConfig) defaults() {
	if c.Window <= 0 {
		c.Window = DefaultReconcileWindow
	}
	if c.MinMismatches <= 0 {
		c.MinMismatches = DefaultMinMismatches
	}
	if c.MinMismatchShare <= 0 {
		c.MinMismatchShare = DefaultMinMismatchShare
	}
	if c.PromotePerSignature <= 0 {
		c.PromotePerSignature = DefaultPromotePerSignature
	}
	if c.MaxPromotions <= 0 {
		c.MaxPromotions = DefaultMaxPromotions
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Log == nil {
		c.Log = io.Discard
	}
}

// Finding is one disagreement: an endpoint, a signature, what production and the eval said of it,
// and opaque case ids. No input value, no answer.
type Finding struct {
	Endpoint string `json:"endpoint"`
	// Sig is the signature as 16 lowercase hex digits.
	Sig string `json:"sig"`
	// Compared and Mismatches are production's compared samples of the signature in the window, and
	// how many mismatched.
	Compared   int `json:"compared"`
	Mismatches int `json:"mismatches"`
	// EvalResults is the signature's results in the reconciled run.
	EvalResults int `json:"eval_results"`
	// CaseIDs (16 hex digits): a blind spot's promoted cases (this reconcile's and earlier ones'), a
	// cannot-reproduce finding's case, a reverse finding's bug cases.
	CaseIDs []string `json:"case_ids"`
	// Promoted is how many of CaseIDs this reconcile promoted (blind spots).
	Promoted int `json:"promoted"`
}

// ReconcileSummary is a reconcile's `runs.settings`.
type ReconcileSummary struct {
	// ReconciledRun is the live run whose results were read.
	ReconciledRun       string  `json:"reconciled_run"`
	WindowHours         float64 `json:"window_hours"`
	MinMismatches       int     `json:"min_mismatches"`
	MinMismatchShare    float64 `json:"min_mismatch_share"`
	PromotePerSignature int     `json:"promote_per_signature"`
	MaxPromotions       int     `json:"max_promotions"`
	// Counts: one per class (the whole count, the lists below are capped), plus `promoted` (cases
	// promoted now), `rows_written` (what ClickHouse reported for them), `already_promoted`,
	// `candidate_missing` (a mismatching sample's case not in `cases`: expired or not yet merged),
	// `promotion_capped` (candidates left by MaxPromotions) and `mismatch_not_run` (a signature over
	// the thresholds the run had no result for).
	Counts          map[string]int `json:"counts"`
	BlindSpots      []Finding      `json:"blind_spots"`
	CannotReproduce []Finding      `json:"cannot_reproduce"`
	Reverse         []Finding      `json:"reverse"`
	DryRun          bool           `json:"dry_run"`
	EndReason       string         `json:"end_reason"`
}

// SigStats is one signature's production samples in the window (sources shadow and serve-parity).
type SigStats struct {
	Endpoint            string
	Sig                 uint64
	Matches, Mismatches int
	// MismatchCases are the admitted cases (case_id ≠ 0) of its mismatching samples, at most
	// maxMismatchCases.
	MismatchCases []uint64
}

// CaseMeta is what reconcile reads of a case (never its request or answer).
type CaseMeta struct {
	Sig    uint64
	Origin string
	Pinned bool
}

// ReconcileStore is what a reconcile reads and writes.
type ReconcileStore interface {
	// LatestRun is the newest run of phase.
	LatestRun(ctx context.Context, phase string) (RunFacts, error)
	SampleStats(ctx context.Context, from, to time.Time) ([]SigStats, error)
	RunResults(ctx context.Context, runID string) ([]ResultFacts, error)
	// PromotedPasses are the run's passing results whose case is promoted (origin prod-mismatch,
	// pinned) with a last_seen before `before` (promoted before the run started).
	PromotedPasses(ctx context.Context, runID string, before time.Time) ([]ResultFacts, error)
	// CaseMeta is endpoint's cases among ids (absent: not in `cases`).
	CaseMeta(ctx context.Context, endpoint string, ids []uint64) (map[uint64]CaseMeta, error)
	// Promote re-inserts endpoint's cases among ids that are not promoted yet, as promoted, under the
	// harness rule (DESIGN.md §19.6), and returns the rows written.
	Promote(ctx context.Context, endpoint string, ids []uint64, now time.Time) (uint64, error)
	// AddRun writes the summary row.
	AddRun(ctx context.Context, r RunRow) error
}

// sigKey is one (endpoint, signature).
type sigKey struct {
	endpoint string
	sig      uint64
}

// sigResults is one signature's results in the reconciled run.
type sigResults struct {
	n       int
	allPass bool
	bugs    []uint64
}

// Reconcile is one reconcile: it reads, classifies, promotes the blind spots' cases and writes the
// summary row (DryRun: neither), and returns the summary.
func Reconcile(ctx context.Context, cfg ReconcileConfig, store ReconcileStore) (ReconcileSummary, error) {
	cfg.defaults()
	now := cfg.Now().UTC()
	sum := ReconcileSummary{WindowHours: cfg.Window.Hours(), MinMismatches: cfg.MinMismatches,
		MinMismatchShare: cfg.MinMismatchShare, PromotePerSignature: cfg.PromotePerSignature, MaxPromotions: cfg.MaxPromotions,
		DryRun: cfg.DryRun, Counts: map[string]int{}, BlindSpots: []Finding{}, CannotReproduce: []Finding{}, Reverse: []Finding{}}
	for _, k := range []string{ClassBlindSpot, ClassCannotReproduce, ClassReverse, "promoted", "rows_written", "already_promoted",
		"candidate_missing", "promotion_capped", "mismatch_not_run"} {
		sum.Counts[k] = 0
	}
	run, err := store.LatestRun(ctx, PhaseLive)
	if err != nil {
		return sum, err
	}
	sum.ReconciledRun = run.RunID
	from := now.Add(-cfg.Window)
	stats, err := store.SampleStats(ctx, from, now)
	if err != nil {
		return sum, fmt.Errorf("read samples: %w", err)
	}
	results, err := store.RunResults(ctx, run.RunID)
	if err != nil {
		return sum, fmt.Errorf("read results: %w", err)
	}
	bySig := map[sigKey]*sigResults{}
	type caseKey struct {
		endpoint string
		id       uint64
	}
	seen := map[caseKey]bool{}
	for _, r := range results {
		if seen[caseKey{r.Endpoint, r.CaseID}] { // a retried insert's duplicate
			continue
		}
		seen[caseKey{r.Endpoint, r.CaseID}] = true
		k := sigKey{r.Endpoint, r.Sig}
		sr := bySig[k]
		if sr == nil {
			sr = &sigResults{allPass: true}
			bySig[k] = sr
		}
		sr.n++
		if r.Verdict != VerdictPass {
			sr.allPass = false
		}
		if r.Verdict == VerdictBug {
			sr.bugs = append(sr.bugs, r.CaseID)
		}
	}

	// Blind spots and reverse findings, from the samples.
	type blind struct {
		f          Finding
		sig        uint64
		candidates []uint64
	}
	blinds := make([]*blind, 0, len(stats))
	for _, s := range stats {
		compared := s.Matches + s.Mismatches
		if compared == 0 {
			continue
		}
		sr := bySig[sigKey{s.Endpoint, s.Sig}]
		f := Finding{Endpoint: s.Endpoint, Sig: HexID(s.Sig), Compared: compared, Mismatches: s.Mismatches, CaseIDs: []string{}}
		if sr != nil {
			f.EvalResults = sr.n
		}
		over := s.Mismatches >= cfg.MinMismatches && float64(s.Mismatches)/float64(compared) >= cfg.MinMismatchShare
		switch {
		case over && sr == nil:
			sum.Counts["mismatch_not_run"]++
		case over && sr.allPass:
			ids := slices.Clone(s.MismatchCases)
			slices.Sort(ids)
			blinds = append(blinds, &blind{f: f, sig: s.Sig, candidates: slices.Compact(ids)})
		case s.Mismatches == 0 && sr != nil && len(sr.bugs) > 0:
			bugs := slices.Clone(sr.bugs)
			slices.Sort(bugs)
			for _, id := range bugs {
				f.CaseIDs = append(f.CaseIDs, HexID(id))
			}
			sum.Counts[ClassReverse]++
			sum.Reverse = append(sum.Reverse, f)
		}
	}
	sort.Slice(blinds, func(i, j int) bool { return findingLess(blinds[i].f, blinds[j].f) })

	// Promotion: per blind spot, its mismatching cases not promoted yet, up to PromotePerSignature
	// with the already promoted counted, and MaxPromotions in all.
	byEndpoint := map[string][]*blind{}
	for _, b := range blinds {
		byEndpoint[b.f.Endpoint] = append(byEndpoint[b.f.Endpoint], b)
	}
	toPromote := map[string][]uint64{}
	budget := cfg.MaxPromotions
	for _, e := range sortedEndpoints(byEndpoint) {
		ids := make([]uint64, 0, maxMismatchCases*len(byEndpoint[e]))
		for _, b := range byEndpoint[e] {
			ids = append(ids, b.candidates...)
		}
		meta := map[uint64]CaseMeta{}
		for _, chunk := range chunks(ids, idChunk) {
			m, err := store.CaseMeta(ctx, e, chunk)
			if err != nil {
				return sum, fmt.Errorf("read cases: %w", err)
			}
			for id, cm := range m {
				meta[id] = cm
			}
		}
		for _, b := range byEndpoint[e] {
			fresh := make([]uint64, 0, len(b.candidates))
			already := 0
			for _, id := range b.candidates {
				cm, ok := meta[id]
				switch {
				case !ok || cm.Sig != b.sig:
					sum.Counts["candidate_missing"]++
				case cm.Pinned && cm.Origin == evalcapture.OriginMismatch:
					already++
					b.f.CaseIDs = append(b.f.CaseIDs, HexID(id))
				default:
					fresh = append(fresh, id)
				}
			}
			sum.Counts["already_promoted"] += already
			take := max(0, cfg.PromotePerSignature-already)
			take = min(take, len(fresh))
			if take > budget {
				sum.Counts["promotion_capped"] += take - budget
				take = budget
			}
			budget -= take
			for _, id := range fresh[:take] {
				b.f.CaseIDs = append(b.f.CaseIDs, HexID(id))
				toPromote[e] = append(toPromote[e], id)
			}
			b.f.Promoted = take
			sum.Counts["promoted"] += take
			sum.Counts[ClassBlindSpot]++
			sum.BlindSpots = append(sum.BlindSpots, b.f)
		}
	}

	// Cannot reproduce: promoted before the run started, passed in it.
	passes, err := store.PromotedPasses(ctx, run.RunID, run.Started)
	if err != nil {
		return sum, fmt.Errorf("read promoted passes: %w", err)
	}
	statsBySig := map[sigKey]SigStats{}
	for _, s := range stats {
		statsBySig[sigKey{s.Endpoint, s.Sig}] = s
	}
	seenPass := map[caseKey]bool{}
	for _, p := range passes {
		if seenPass[caseKey{p.Endpoint, p.CaseID}] {
			continue
		}
		seenPass[caseKey{p.Endpoint, p.CaseID}] = true
		s := statsBySig[sigKey{p.Endpoint, p.Sig}]
		f := Finding{Endpoint: p.Endpoint, Sig: HexID(p.Sig), Compared: s.Matches + s.Mismatches, Mismatches: s.Mismatches,
			CaseIDs: []string{HexID(p.CaseID)}}
		if sr := bySig[sigKey{p.Endpoint, p.Sig}]; sr != nil {
			f.EvalResults = sr.n
		}
		sum.Counts[ClassCannotReproduce]++
		sum.CannotReproduce = append(sum.CannotReproduce, f)
	}
	for _, list := range []*[]Finding{&sum.BlindSpots, &sum.CannotReproduce, &sum.Reverse} {
		sort.SliceStable(*list, func(i, j int) bool { return findingLess((*list)[i], (*list)[j]) })
		if len(*list) > maxFindings {
			*list = (*list)[:maxFindings]
		}
	}
	sum.EndReason = EndDone
	_, _ = fmt.Fprintf(cfg.Log, "feed-eval reconcile of %s: %d blind spots (%d cases promoted), %d cannot reproduce, %d reverse\n",
		run.RunID, sum.Counts[ClassBlindSpot], sum.Counts["promoted"], sum.Counts[ClassCannotReproduce], sum.Counts[ClassReverse])
	if cfg.DryRun {
		return sum, nil
	}
	for _, e := range sortedEndpoints(toPromote) {
		for _, chunk := range chunks(toPromote[e], idChunk) {
			n, err := store.Promote(ctx, e, chunk, now)
			if err != nil {
				return sum, fmt.Errorf("promote %s cases: %w", e, err)
			}
			sum.Counts["rows_written"] += int(n) //nolint:gosec // G115: at most idChunk rows
		}
	}
	sj, err := json.Marshal(sum)
	if err != nil {
		return sum, err
	}
	id, err := NewRunID(PhaseReconcile, now)
	if err != nil {
		return sum, err
	}
	row := RunRow{RunID: id, Phase: PhaseReconcile, CorpusFrom: rowTime(from), CorpusTo: rowTime(now), Settings: string(sj),
		Started: rowTime(now), Finished: rowTime(cfg.Now())}
	if err := store.AddRun(ctx, row); err != nil {
		return sum, fmt.Errorf("write the summary row: %w", err)
	}
	return sum, nil
}

// findingLess orders findings by mismatches (most first), then endpoint, then signature.
func findingLess(a, b Finding) bool {
	if a.Mismatches != b.Mismatches {
		return a.Mismatches > b.Mismatches
	}
	if a.Endpoint != b.Endpoint {
		return a.Endpoint < b.Endpoint
	}
	if a.Sig != b.Sig {
		return a.Sig < b.Sig
	}
	return strings.Join(a.CaseIDs, ",") < strings.Join(b.CaseIDs, ",")
}

func sortedEndpoints[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func chunks(ids []uint64, n int) [][]uint64 {
	var out [][]uint64
	for len(ids) > 0 {
		k := min(n, len(ids))
		out = append(out, ids[:k])
		ids = ids[k:]
	}
	return out
}

// CHReconcileStore is the ClickHouse ReconcileStore: reads through chread (the harness login), writes
// through CHExec (acknowledged, or the reconcile fails).
type CHReconcileStore struct {
	read *chread.Client
	exec *CHExec
}

// NewCHReconcileStore is the reader and the writer over cfg.
func NewCHReconcileStore(cfg CHConfig) (*CHReconcileStore, error) {
	read, err := NewCHReader(cfg)
	if err != nil {
		return nil, err
	}
	exec, err := NewCHExec(cfg)
	if err != nil {
		return nil, err
	}
	return &CHReconcileStore{read: read, exec: exec}, nil
}

const (
	sampleStatsSQL = `SELECT endpoint, toString(sig) AS sig,
  countIf(prod_result IN {match:Array(String)}) AS matches,
  countIf(prod_result IN {mismatch:Array(String)}) AS mismatches,
  arrayMap(x -> toString(x), groupUniqArrayIf(64)(case_id, prod_result IN {mismatch:Array(String)} AND case_id != 0)) AS mismatch_cases
FROM samples
WHERE ts >= fromUnixTimestamp64Milli({from_ms:Int64}) AND ts < fromUnixTimestamp64Milli({to_ms:Int64})
  AND source IN {sources:Array(String)}
GROUP BY endpoint, sig
HAVING matches + mismatches > 0`
	caseMetaSQL = `SELECT toString(case_id) AS case_id, toString(sig) AS sig, origin, pinned
FROM cases FINAL
WHERE endpoint = {endpoint:String} AND case_id IN {ids:Array(UInt64)}`
	// promoteSQL copies each case server-side (request and answer byte for byte, never read here)
	// with origin prod-mismatch, pinned 1, its first_seen, and last_seen the later of now and its own
	// + 1 ms: the §19.6 harness rule, so no feed-go copy can outrank it. A case already promoted is
	// not re-inserted, so a second reconcile writes nothing for it.
	promoteSQL = `INSERT INTO cases (case_id, endpoint, sig, sig_text, origin, request, node_body, node_headers, prod_result, pinned, first_seen, last_seen)
SELECT case_id, endpoint, sig, sig_text, {origin:String}, request, node_body, node_headers, prod_result, 1, first_seen,
  greatest(fromUnixTimestamp64Milli({now_ms:Int64}), last_seen + toIntervalMillisecond(1))
FROM cases FINAL
WHERE endpoint = {endpoint:String} AND case_id IN {ids:Array(UInt64)} AND NOT (pinned = 1 AND origin = {origin:String})`
	promotedPassesSQL = `SELECT toString(r.case_id) AS case_id, r.endpoint AS endpoint, toString(r.sig) AS sig
FROM results AS r
INNER JOIN (
  SELECT case_id, endpoint
  FROM cases FINAL
  WHERE origin = {origin:String} AND pinned = 1 AND last_seen < fromUnixTimestamp64Milli({before_ms:Int64})
) AS c ON r.case_id = c.case_id AND r.endpoint = c.endpoint
WHERE r.run_id = {run:String} AND r.verdict = {pass:String}`
	insertRunSQL = `INSERT INTO runs FORMAT JSONEachRow`
)

// chArray is a ClickHouse Array(String) query parameter of fixed tokens (no quote can be in one).
func chArray(list []string) string {
	q := make([]string, 0, len(list))
	for _, s := range list {
		q = append(q, "'"+s+"'")
	}
	return "[" + strings.Join(q, ",") + "]"
}

// chIDs is a ClickHouse Array(UInt64) query parameter.
func chIDs(ids []uint64) string {
	q := make([]string, 0, len(ids))
	for _, id := range ids {
		q = append(q, strconv.FormatUint(id, 10))
	}
	return "[" + strings.Join(q, ",") + "]"
}

// LatestRun implements ReconcileStore.
func (s *CHReconcileStore) LatestRun(ctx context.Context, phase string) (RunFacts, error) {
	rows, err := s.read.Query(ctx, runsSQL, []chread.Setting{param("phase", phase), param("n", "1")})
	if err != nil {
		return RunFacts{}, fmt.Errorf("read runs: %w", err)
	}
	for _, r := range rows {
		if id := str(r["run_id"]); runIDRE.MatchString(id) && strings.HasPrefix(id, phase+"-") {
			return RunFacts{RunID: id, Started: msTime(r["started_ms"]), CorpusFrom: msTime(r["from_ms"]), CorpusTo: msTime(r["to_ms"])}, nil
		}
	}
	return RunFacts{}, fmt.Errorf("no %s run to reconcile", phase)
}

// SampleStats implements ReconcileStore: shadow and serve-parity samples only (the sources with a
// production comparison), match and mismatch results only.
func (s *CHReconcileStore) SampleStats(ctx context.Context, from, to time.Time) ([]SigStats, error) {
	rows, err := s.read.Query(ctx, sampleStatsSQL, []chread.Setting{
		param("match", chArray(evalcapture.MatchResults)), param("mismatch", chArray(evalcapture.MismatchResults)),
		param("sources", chArray([]string{evalcapture.SourceShadow, evalcapture.SourceServeParity})),
		param("from_ms", strconv.FormatInt(from.UnixMilli(), 10)), param("to_ms", strconv.FormatInt(to.UnixMilli(), 10)),
	})
	if err != nil {
		return nil, err
	}
	out := make([]SigStats, 0, len(rows))
	for _, r := range rows {
		sig, err := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err != nil {
			continue
		}
		st := SigStats{Endpoint: str(r["endpoint"]), Sig: sig, Matches: int(num(r["matches"])), Mismatches: int(num(r["mismatches"]))}
		if !slices.Contains(evalcorpus.Endpoints, st.Endpoint) {
			continue
		}
		for _, c := range strs(r["mismatch_cases"]) {
			if id, err := strconv.ParseUint(c, 10, 64); err == nil && id != 0 && len(st.MismatchCases) < maxMismatchCases {
				st.MismatchCases = append(st.MismatchCases, id)
			}
		}
		out = append(out, st)
	}
	return out, nil
}

// RunResults implements ReconcileStore.
func (s *CHReconcileStore) RunResults(ctx context.Context, runID string) ([]ResultFacts, error) {
	rows, err := s.read.Query(ctx, latestSQL, []chread.Setting{param("run", runID)})
	if err != nil {
		return nil, err
	}
	out := make([]ResultFacts, 0, len(rows))
	for _, r := range rows {
		id, err1 := strconv.ParseUint(str(r["case_id"]), 10, 64)
		sig, err2 := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, ResultFacts{CaseID: id, Endpoint: str(r["endpoint"]), Sig: sig, Verdict: str(r["verdict"])})
	}
	return out, nil
}

// PromotedPasses implements ReconcileStore.
func (s *CHReconcileStore) PromotedPasses(ctx context.Context, runID string, before time.Time) ([]ResultFacts, error) {
	rows, err := s.read.Query(ctx, promotedPassesSQL, []chread.Setting{param("origin", evalcapture.OriginMismatch),
		param("before_ms", strconv.FormatInt(before.UnixMilli(), 10)), param("run", runID), param("pass", VerdictPass)})
	if err != nil {
		return nil, err
	}
	out := make([]ResultFacts, 0, len(rows))
	for _, r := range rows {
		id, err1 := strconv.ParseUint(str(r["case_id"]), 10, 64)
		sig, err2 := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, ResultFacts{CaseID: id, Endpoint: str(r["endpoint"]), Sig: sig, Verdict: VerdictPass})
	}
	return out, nil
}

// CaseMeta implements ReconcileStore.
func (s *CHReconcileStore) CaseMeta(ctx context.Context, endpoint string, ids []uint64) (map[uint64]CaseMeta, error) {
	out := map[uint64]CaseMeta{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.read.Query(ctx, caseMetaSQL, []chread.Setting{param("endpoint", endpoint), param("ids", chIDs(ids))})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		id, err1 := strconv.ParseUint(str(r["case_id"]), 10, 64)
		sig, err2 := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[id] = CaseMeta{Sig: sig, Origin: str(r["origin"]), Pinned: num(r["pinned"]) == 1}
	}
	return out, nil
}

// Promote implements ReconcileStore.
func (s *CHReconcileStore) Promote(ctx context.Context, endpoint string, ids []uint64, now time.Time) (uint64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	return s.exec.Exec(ctx, promoteSQL, []chread.Setting{param("origin", evalcapture.OriginMismatch),
		param("now_ms", strconv.FormatInt(now.UnixMilli(), 10)), param("endpoint", endpoint), param("ids", chIDs(ids))}, nil)
}

// AddRun implements ReconcileStore.
func (s *CHReconcileStore) AddRun(ctx context.Context, r RunRow) error {
	body, err := jsonEachRow([]RunRow{r})
	if err != nil {
		return err
	}
	_, err = s.exec.Exec(ctx, insertRunSQL, nil, body)
	return err
}
