package evalharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// What publish shows, and what it never can: its reads select only result and run columns that hold
// verdicts, reasons, categories, paths, ids and counts (never `cases.request`, `cases.node_body`, a
// sample's input or an account), and its pages are rendered from the Report types below, which have
// no field a request input or a response value could be put in. Every string that reaches a page is
// safeToken'd (a reason, a category, a path, the run id), an account role ([a-z][a-z0-9-]*), an
// account token's host (hostRE: the operator's accounts file, never a request) or a fixed state, or
// formatted here (numbers, times, hex ids). A token-shaped reason, category or path IS shown, by
// design: a reason is a fallback reason (Go's hand-back header, shape-checked by Score) or the
// harness's own, and a category or path is an answer's key path (opaque subtrees truncated), never a
// request input.

// RunFacts is what publish reads of one run.
type RunFacts struct {
	RunID      string
	Started    time.Time
	CorpusFrom time.Time
	CorpusTo   time.Time
	EndReason  string
	// Accounts are its settings' account notes (role, host, exp, state; never a token).
	Accounts []AccountNote
}

// ResultFacts is what publish reads of one results row.
type ResultFacts struct {
	CaseID         uint64
	Endpoint       string
	Sig            uint64
	Verdict        string
	Reason         string
	ResultClass    string
	DiffCategories []string
	UnstablePaths  []string
}

// Facts is everything a publish reads: the runs (newest first), each run's verdict counts per
// endpoint, the newest run's results, and the traffic weight of each (endpoint, signature) over the
// newest run's corpus window.
type Facts struct {
	Runs    []RunFacts
	Counts  map[string]map[string]map[string]int // run -> endpoint -> verdict -> n
	Latest  []ResultFacts
	Weights map[string]map[uint64]float64 // endpoint -> sig -> weight
	// Reconcile is the newest reconcile's summary row (nil: none).
	Reconcile *ReconcileFacts
}

// ReconcileFacts is what publish reads of the newest reconcile: its run id, when, and its summary
// (counts, endpoints, signatures and case ids: Aggregate re-checks each as it builds the rows).
type ReconcileFacts struct {
	RunID   string
	Started time.Time
	Summary ReconcileSummary
}

// VerdictTotal is one verdict's count and traffic-weighted share.
type VerdictTotal struct {
	Verdict     string
	N           int
	WeightedPct float64
}

// GapRow is one hand-back reason.
type GapRow struct {
	Reason     string
	N          int
	TrafficPct float64
	Examples   []string
}

// BugRow is one diff category of the bugs.
type BugRow struct {
	Category string
	N        int
	Examples []string
}

// ReasonRow is one reason's count and traffic share (not_replayable by reason).
type ReasonRow struct {
	Reason     string
	N          int
	TrafficPct float64
}

// AccountRow is one account token needing attention: its role, the host the token is for ("-": the
// default token), its exp, and the state.
type AccountRow struct {
	Role    string
	Host    string
	Expires string
	State   string
}

// UnstableRow is one proposed mask path.
type UnstableRow struct {
	Path string
	N    int
}

// TrendRow is one run's verdict counts.
type TrendRow struct {
	RunID   string
	Started string
	Counts  []int // in Verdicts order
}

// DisagreementRow is one prod/eval disagreement (DESIGN.md §19.9): its class, the signature, what
// production and the eval said of it, and opaque case ids.
type DisagreementRow struct {
	Class       string
	Sig         string
	Compared    int
	Mismatches  int
	EvalResults int
	CaseIDs     []string
}

// ReconcileHeader is the newest reconcile, as the index shows it.
type ReconcileHeader struct {
	RunID           string
	ReconciledRun   string
	Started         string
	BlindSpots      int
	Promoted        int
	CannotReproduce int
	Reverse         int
	// Stale: the reconcile read another run than the one published.
	Stale bool
}

// EndpointPage is one endpoint's page.
type EndpointPage struct {
	ID        string
	Endpoint  string
	RunID     string
	Started   string
	EndReason string
	Cases     int
	// CoveragePct is the traffic share of the signatures whose case exercised Go (pass, bug, gap,
	// error); not_replayable and infra_miss are shown apart (Totals, NotReplayable).
	CoveragePct   float64
	Totals        []VerdictTotal
	NotReplayable []ReasonRow
	Gaps          []GapRow
	Bugs          []BugRow
	Unstable      []UnstableRow
	Trend         []TrendRow
	Verdicts      []string
	// Disagreement is the newest reconcile's findings on this endpoint (nil: none, or no reconcile).
	Disagreement []DisagreementRow
}

// IndexPage is the index: one line per endpoint, and the accounts needing attention.
type IndexPage struct {
	ID        string
	RunID     string
	Started   string
	EndReason string
	Endpoints []EndpointPage
	Verdicts  []string
	Accounts  []AccountRow
	// Reconcile is the newest reconcile (nil: none yet).
	Reconcile *ReconcileHeader
}

// Report is everything published.
type Report struct {
	Index     IndexPage
	Endpoints []EndpointPage
}

// maxExamples bounds the example case ids a row shows.
const maxExamples = 5

// PageIDRE is what HQ accepts as a page id.
var PageIDRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

// Aggregate builds the report of facts for endpoints, page ids prefix (the index) and prefix-<endpoint>.
func Aggregate(f Facts, endpoints []string, prefix string) (Report, error) {
	if len(f.Runs) == 0 {
		return Report{}, errors.New("no run to publish")
	}
	latest := f.Runs[0]
	idx := IndexPage{ID: prefix, RunID: safeToken(latest.RunID), Started: fmtTime(latest.Started),
		EndReason: safeToken(latest.EndReason), Verdicts: Verdicts}
	for _, n := range latest.Accounts {
		row := AccountRow{Role: Redacted, Host: "-", Expires: "-", State: Redacted}
		if roleRE.MatchString(n.Role) {
			row.Role = n.Role
		}
		if hostRE.MatchString(n.Host) {
			row.Host = n.Host
		} else if n.Host != "" {
			row.Host = Redacted
		}
		switch n.State {
		case AccountExpiring, AccountExpired, AccountNoExp:
			row.State = n.State
		}
		if t, err := time.Parse(time.RFC3339, n.Expires); err == nil {
			row.Expires = fmtTime(t)
		}
		idx.Accounts = append(idx.Accounts, row)
	}
	if !PageIDRE.MatchString(idx.ID) {
		return Report{}, fmt.Errorf("page id %q: want [a-z][a-z0-9-]{0,39}", idx.ID)
	}
	if rc := f.Reconcile; rc != nil {
		c := rc.Summary.Counts
		idx.Reconcile = &ReconcileHeader{RunID: safeToken(rc.RunID), ReconciledRun: safeToken(rc.Summary.ReconciledRun),
			Started: fmtTime(rc.Started), BlindSpots: c[ClassBlindSpot], Promoted: c["promoted"],
			CannotReproduce: c[ClassCannotReproduce], Reverse: c[ClassReverse], Stale: rc.Summary.ReconciledRun != latest.RunID}
	}
	rep := Report{}
	byEndpoint := map[string][]ResultFacts{}
	type key struct {
		endpoint string
		id       uint64
	}
	seen := map[key]bool{}
	for _, r := range f.Latest {
		k := key{r.Endpoint, r.CaseID}
		if seen[k] { // a retried insert's duplicate
			continue
		}
		seen[k] = true
		byEndpoint[r.Endpoint] = append(byEndpoint[r.Endpoint], r)
	}
	for _, e := range endpoints {
		p := EndpointPage{ID: prefix + "-" + e, Endpoint: safeToken(e), RunID: idx.RunID, Started: idx.Started,
			EndReason: idx.EndReason, Verdicts: Verdicts}
		if !PageIDRE.MatchString(p.ID) {
			return Report{}, fmt.Errorf("page id %q: want [a-z][a-z0-9-]{0,39}", p.ID)
		}
		weights := f.Weights[e]
		total := 0.0
		for _, w := range weights {
			total += w
		}
		pct := func(w float64) float64 {
			if total <= 0 {
				return 0
			}
			return 100 * w / total
		}
		rows := byEndpoint[e]
		sort.Slice(rows, func(i, j int) bool {
			wi, wj := weights[rows[i].Sig], weights[rows[j].Sig]
			if wi != wj {
				return wi > wj
			}
			return rows[i].CaseID < rows[j].CaseID
		})
		p.Cases = len(rows)
		counts, wsum := map[string]int{}, map[string]float64{}
		covered := map[uint64]bool{}
		gaps := map[string]*GapRow{}
		gapW := map[string]float64{}
		bugs := map[string]*BugRow{}
		unstable := map[string]int{}
		notReplayable := map[string]*ReasonRow{}
		nrW := map[string]float64{}
		for _, r := range rows {
			v := safeToken(r.Verdict)
			counts[v]++
			w := weights[r.Sig]
			wsum[v] += w
			switch r.Verdict {
			case VerdictPass, VerdictBug, VerdictGap, VerdictError:
				covered[r.Sig] = true // Go was exercised
			}
			switch r.Verdict {
			case VerdictNotReplayable:
				reason := safeToken(r.Reason)
				nr := notReplayable[reason]
				if nr == nil {
					nr = &ReasonRow{Reason: reason}
					notReplayable[reason] = nr
				}
				nr.N++
				nrW[reason] += w
			case VerdictGap:
				reason := safeToken(r.Reason)
				g := gaps[reason]
				if g == nil {
					g = &GapRow{Reason: reason}
					gaps[reason] = g
				}
				g.N++
				gapW[reason] += w
				if len(g.Examples) < maxExamples {
					g.Examples = append(g.Examples, HexID(r.CaseID))
				}
			case VerdictBug:
				cats := safeTokens(r.DiffCategories)
				if len(cats) == 0 {
					cats = []string{"none"}
				}
				for _, c := range cats {
					b := bugs[c]
					if b == nil {
						b = &BugRow{Category: c}
						bugs[c] = b
					}
					b.N++
					if len(b.Examples) < maxExamples {
						b.Examples = append(b.Examples, HexID(r.CaseID))
					}
				}
			case VerdictNodeUnstable:
				for _, path := range safeTokens(r.UnstablePaths) {
					unstable[path]++
				}
			}
		}
		cov := 0.0
		for s := range covered {
			cov += weights[s]
		}
		p.CoveragePct = pct(cov)
		for _, v := range Verdicts {
			p.Totals = append(p.Totals, VerdictTotal{Verdict: v, N: counts[v], WeightedPct: pct(wsum[v])})
		}
		for reason, nr := range notReplayable {
			nr.TrafficPct = pct(nrW[reason])
			p.NotReplayable = append(p.NotReplayable, *nr)
		}
		sort.Slice(p.NotReplayable, func(i, j int) bool {
			if p.NotReplayable[i].N != p.NotReplayable[j].N {
				return p.NotReplayable[i].N > p.NotReplayable[j].N
			}
			return p.NotReplayable[i].Reason < p.NotReplayable[j].Reason
		})
		for reason, g := range gaps {
			g.TrafficPct = pct(gapW[reason])
			p.Gaps = append(p.Gaps, *g)
		}
		sort.Slice(p.Gaps, func(i, j int) bool {
			if p.Gaps[i].TrafficPct != p.Gaps[j].TrafficPct {
				return p.Gaps[i].TrafficPct > p.Gaps[j].TrafficPct
			}
			return p.Gaps[i].Reason < p.Gaps[j].Reason
		})
		for _, b := range bugs {
			p.Bugs = append(p.Bugs, *b)
		}
		sort.Slice(p.Bugs, func(i, j int) bool {
			if p.Bugs[i].N != p.Bugs[j].N {
				return p.Bugs[i].N > p.Bugs[j].N
			}
			return p.Bugs[i].Category < p.Bugs[j].Category
		})
		for path, n := range unstable {
			p.Unstable = append(p.Unstable, UnstableRow{Path: path, N: n})
		}
		sort.Slice(p.Unstable, func(i, j int) bool {
			if p.Unstable[i].N != p.Unstable[j].N {
				return p.Unstable[i].N > p.Unstable[j].N
			}
			return p.Unstable[i].Path < p.Unstable[j].Path
		})
		if f.Reconcile != nil {
			p.Disagreement = disagreementRows(f.Reconcile.Summary, e)
		}
		// Oldest first.
		for i := len(f.Runs) - 1; i >= 0; i-- {
			run := f.Runs[i]
			t := TrendRow{RunID: safeToken(run.RunID), Started: fmtTime(run.Started)}
			for _, v := range Verdicts {
				t.Counts = append(t.Counts, f.Counts[run.RunID][e][v])
			}
			p.Trend = append(p.Trend, t)
		}
		rep.Endpoints = append(rep.Endpoints, p)
	}
	idx.Endpoints = rep.Endpoints
	rep.Index = idx
	return rep, nil
}

// hexIDRE is a signature or case id as a summary writes it (HexID).
var hexIDRE = regexp.MustCompile(`^[0-9a-f]{16}$`)

// hexOrRedacted is s when it is a 16-hex-digit id, else Redacted.
func hexOrRedacted(s string) string {
	if hexIDRE.MatchString(s) {
		return s
	}
	return Redacted
}

// disagreementRows is endpoint's findings of a reconcile summary, classes in a fixed order: only a
// finding naming exactly endpoint, its ids re-checked (hexOrRedacted), at most maxExamples case ids
// a row. The summary is read back from a table, so nothing in it is trusted to be shaped as written.
func disagreementRows(s ReconcileSummary, endpoint string) []DisagreementRow {
	out := make([]DisagreementRow, 0, len(s.BlindSpots)+len(s.CannotReproduce)+len(s.Reverse))
	for _, cl := range []struct {
		class string
		list  []Finding
	}{{ClassBlindSpot, s.BlindSpots}, {ClassCannotReproduce, s.CannotReproduce}, {ClassReverse, s.Reverse}} {
		for _, f := range cl.list {
			if f.Endpoint != endpoint {
				continue
			}
			row := DisagreementRow{Class: cl.class, Sig: hexOrRedacted(f.Sig), Compared: f.Compared, Mismatches: f.Mismatches,
				EvalResults: f.EvalResults, CaseIDs: []string{}}
			for _, id := range f.CaseIDs {
				if len(row.CaseIDs) == maxExamples {
					break
				}
				row.CaseIDs = append(row.CaseIDs, hexOrRedacted(id))
			}
			out = append(out, row)
		}
	}
	return out
}

func fmtTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.UTC().Format("2006-01-02 15:04 UTC")
}

var pageFuncs = template.FuncMap{
	"pct":  func(f float64) string { return strconv.FormatFloat(f, 'f', 1, 64) + "%" },
	"join": func(s []string) string { return strings.Join(s, " ") },
}

const pageStyle = `<style>body{font-family:system-ui,sans-serif;margin:1.5rem;color:#1a1a1a}table{border-collapse:collapse;margin:.5rem 0 1.5rem}` +
	`th,td{border:1px solid #ccc;padding:.25rem .6rem;text-align:left;font-size:.9rem}th{background:#f3f3f3}` +
	`td.n{text-align:right;font-variant-numeric:tabular-nums}code{font-size:.85rem}.muted{color:#666}</style>`

var endpointTmpl = template.Must(template.New("endpoint").Funcs(pageFuncs).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>feed-eval: {{.Endpoint}}</title>` + pageStyle + `</head><body>
<h1>feed-eval: {{.Endpoint}}</h1>
<p class="muted">run <code>{{.RunID}}</code>, started {{.Started}}, ended: {{.EndReason}}. {{.Cases}} cases; coverage {{pct .CoveragePct}} of traffic (signatures whose case exercised Go: pass, bug, gap, error; weighted).</p>
<h2>Verdicts</h2>
<table><tr><th>verdict</th><th>cases</th><th>traffic-weighted</th></tr>
{{range .Totals}}<tr><td>{{.Verdict}}</td><td class="n">{{.N}}</td><td class="n">{{pct .WeightedPct}}</td></tr>
{{end}}</table>
<h2>Not replayable by reason</h2>
{{if .NotReplayable}}<table><tr><th>reason</th><th>cases</th><th>traffic</th></tr>
{{range .NotReplayable}}<tr><td><code>{{.Reason}}</code></td><td class="n">{{.N}}</td><td class="n">{{pct .TrafficPct}}</td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
<h2>Gaps (hand-backs) by reason</h2>
{{if .Gaps}}<table><tr><th>reason</th><th>cases</th><th>traffic</th><th>example case ids</th></tr>
{{range .Gaps}}<tr><td><code>{{.Reason}}</code></td><td class="n">{{.N}}</td><td class="n">{{pct .TrafficPct}}</td><td><code>{{join .Examples}}</code></td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
<h2>Bugs by diff category</h2>
{{if .Bugs}}<table><tr><th>category</th><th>cases</th><th>example case ids</th></tr>
{{range .Bugs}}<tr><td><code>{{.Category}}</code></td><td class="n">{{.N}}</td><td><code>{{join .Examples}}</code></td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
<h2>Node unstable: proposed masks</h2>
{{if .Unstable}}<table><tr><th>path</th><th>cases</th></tr>
{{range .Unstable}}<tr><td><code>{{.Path}}</code></td><td class="n">{{.N}}</td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
<h2>Prod/eval disagreement</h2>
<p class="muted">From the newest reconcile: blind-spot (production mismatched, the eval passed; its cases promoted), cannot-reproduce (a promoted case that still passes), reverse (the eval found a bug, production matched).</p>
{{if .Disagreement}}<table><tr><th>class</th><th>signature</th><th>prod compared</th><th>prod mismatches</th><th>eval results</th><th>case ids</th></tr>
{{range .Disagreement}}<tr><td>{{.Class}}</td><td><code>{{.Sig}}</code></td><td class="n">{{.Compared}}</td><td class="n">{{.Mismatches}}</td><td class="n">{{.EvalResults}}</td><td><code>{{join .CaseIDs}}</code></td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
<h2>Trend</h2>
<table><tr><th>run</th><th>started</th>{{range .Verdicts}}<th>{{.}}</th>{{end}}</tr>
{{range .Trend}}<tr><td><code>{{.RunID}}</code></td><td>{{.Started}}</td>{{range .Counts}}<td class="n">{{.}}</td>{{end}}</tr>
{{end}}</table>
</body></html>
`))

var indexTmpl = template.Must(template.New("index").Funcs(pageFuncs).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>feed-eval</title>` + pageStyle + `</head><body>
<h1>feed-eval: production-derived evals</h1>
<p class="muted">run <code>{{.RunID}}</code>, started {{.Started}}, ended: {{.EndReason}}. Node is the oracle; a gap is a request Go hands back.</p>
<table><tr><th>endpoint</th><th>page</th><th>cases</th><th>coverage</th>{{range .Verdicts}}<th>{{.}}</th>{{end}}</tr>
{{range .Endpoints}}<tr><td>{{.Endpoint}}</td><td><code>{{.ID}}</code></td><td class="n">{{.Cases}}</td><td class="n">{{pct .CoveragePct}}</td>{{range .Totals}}<td class="n">{{.N}}</td>{{end}}</tr>
{{end}}</table>
<h2>Prod/eval disagreement</h2>
{{with .Reconcile}}<p class="muted">reconcile <code>{{.RunID}}</code> of run <code>{{.ReconciledRun}}</code>, {{.Started}}{{if .Stale}} (not the run shown above){{end}}.</p>
<table><tr><th>blind spots</th><th>cases promoted</th><th>cannot reproduce</th><th>reverse</th></tr>
<tr><td class="n">{{.BlindSpots}}</td><td class="n">{{.Promoted}}</td><td class="n">{{.CannotReproduce}}</td><td class="n">{{.Reverse}}</td></tr></table>{{else}}<p class="muted">no reconcile yet</p>{{end}}
<h2>Eval accounts needing attention</h2>
{{if .Accounts}}<table><tr><th>role</th><th>site</th><th>session expires</th><th>state</th></tr>
{{range .Accounts}}<tr><td>{{.Role}}</td><td>{{.Host}}</td><td>{{.Expires}}</td><td>{{.State}}</td></tr>
{{end}}</table>{{else}}<p class="muted">none</p>{{end}}
</body></html>
`))

// Page is one HQ page: the PUT body.
type Page struct {
	Title   string   `json:"title"`
	HTML    string   `json:"html"`
	Summary string   `json:"summary"`
	Viewers []string `json:"viewers,omitempty"`
}

// Render is the report's pages, by page id (the index first).
func Render(rep Report, viewers []string) ([]string, map[string]Page, error) {
	ids := []string{rep.Index.ID}
	pages := map[string]Page{}
	var buf bytes.Buffer
	if err := indexTmpl.Execute(&buf, rep.Index); err != nil {
		return nil, nil, err
	}
	sums := make([]string, 0, len(rep.Endpoints))
	for _, p := range rep.Endpoints {
		sums = append(sums, summary(p))
	}
	pages[rep.Index.ID] = Page{Title: "feed-eval", HTML: buf.String(), Summary: strings.Join(sums, "; "), Viewers: viewers}
	for _, p := range rep.Endpoints {
		buf.Reset()
		if err := endpointTmpl.Execute(&buf, p); err != nil {
			return nil, nil, err
		}
		ids = append(ids, p.ID)
		pages[p.ID] = Page{Title: "feed-eval: " + p.Endpoint, HTML: buf.String(), Summary: summary(p), Viewers: viewers}
	}
	return ids, pages, nil
}

func summary(p EndpointPage) string {
	parts := make([]string, 0, len(p.Totals))
	for _, t := range p.Totals {
		if t.N > 0 {
			parts = append(parts, strconv.Itoa(t.N)+" "+t.Verdict)
		}
	}
	return p.Endpoint + ": " + strings.Join(parts, ", ") + ", coverage " + strconv.FormatFloat(p.CoveragePct, 'f', 1, 64) + "%"
}

// HQClient PUTs pages to the HQ pages API.
type HQClient struct {
	BaseURL, Token string
	HTTP           *http.Client
}

// Put creates or replaces page id: PUT {BaseURL}/api/v1/pages/{id}, bearer token, JSON body.
func (c *HQClient) Put(ctx context.Context, id string, p Page) error {
	if !PageIDRE.MatchString(id) {
		return fmt.Errorf("page id %q: want [a-z][a-z0-9-]{0,39}", id)
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + "/api/v1/pages/" + id)
	if err != nil {
		return errors.New("hq url: not a URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("hq put %s: %w", id, redactURL(err))
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("hq put %s: http %d", id, resp.StatusCode)
	}
	return nil
}

// PublishConfig is one publish.
type PublishConfig struct {
	// Phase is the runs published (PhaseLive); Runs how many (the newest and up to Runs-1 before it).
	Phase string
	Runs  int
	// Endpoints get a page each (nil: evalcorpus.Endpoints).
	Endpoints []string
	// Prefix is the index's page id and the endpoint pages' prefix.
	Prefix  string
	Viewers []string
	// DryRunDir, when set, receives <id>.html files instead of any PUT.
	DryRunDir string
	HQ        *HQClient
}

// Publish reads the facts, renders the pages and PUTs them (or writes them to DryRunDir). It returns
// the page ids written.
func Publish(ctx context.Context, cfg PublishConfig, read *chread.Client) ([]string, error) {
	if cfg.Phase == "" {
		cfg.Phase = PhaseLive
	}
	if cfg.Runs <= 0 {
		cfg.Runs = 31
	}
	if cfg.Endpoints == nil {
		cfg.Endpoints = evalcorpus.Endpoints
	}
	if cfg.DryRunDir == "" && cfg.HQ == nil {
		return nil, errors.New("publish: give --dry-run <dir> or HQ_URL and a token")
	}
	facts, err := ReadFacts(ctx, read, cfg.Phase, cfg.Runs)
	if err != nil {
		return nil, err
	}
	rep, err := Aggregate(facts, cfg.Endpoints, cfg.Prefix)
	if err != nil {
		return nil, err
	}
	ids, pages, err := Render(rep, cfg.Viewers)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		p := pages[id]
		if cfg.DryRunDir != "" {
			if err := os.WriteFile(filepath.Join(cfg.DryRunDir, id+".html"), []byte(p.HTML), 0o600); err != nil {
				return nil, err
			}
			continue
		}
		if err := cfg.HQ.Put(ctx, id, p); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

var runIDRE = regexp.MustCompile(`^[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$`)

const (
	runsSQL = `SELECT run_id, toUnixTimestamp64Milli(started) AS started_ms, toUnixTimestamp64Milli(corpus_from) AS from_ms,
  toUnixTimestamp64Milli(corpus_to) AS to_ms, settings
FROM runs
WHERE phase = {phase:String}
ORDER BY started DESC
LIMIT {n:UInt32}`
	countsSQL = `SELECT run_id, endpoint, verdict, count() AS n
FROM results
WHERE run_id IN {runs:Array(String)}
GROUP BY run_id, endpoint, verdict`
	latestSQL = `SELECT toString(case_id) AS case_id, endpoint, toString(sig) AS sig, verdict, reason, result_class,
  diff_categories, unstable_paths
FROM results
WHERE run_id = {run:String}`
	weightsSQL = `SELECT endpoint, toString(sig) AS sig, sum(weight) AS w
FROM samples
WHERE ts >= fromUnixTimestamp64Milli({from_ms:Int64}) AND ts < fromUnixTimestamp64Milli({to_ms:Int64})
GROUP BY endpoint, sig`
)

// ReadFacts reads what a publish shows: the newest n runs of phase, their counts, the newest run's
// results and the traffic weights over its corpus window. Every value is a query parameter.
func ReadFacts(ctx context.Context, read *chread.Client, phase string, n int) (Facts, error) {
	f := Facts{Counts: map[string]map[string]map[string]int{}, Weights: map[string]map[uint64]float64{}}
	rows, err := read.Query(ctx, runsSQL, []chread.Setting{param("phase", phase), param("n", strconv.Itoa(n))})
	if err != nil {
		return f, fmt.Errorf("read runs: %w", err)
	}
	var fromMS, toMS int64
	for _, r := range rows {
		id := str(r["run_id"])
		if !runIDRE.MatchString(id) {
			continue
		}
		var s struct {
			EndReason string        `json:"end_reason"`
			Accounts  []AccountNote `json:"accounts"`
		}
		_ = json.Unmarshal([]byte(str(r["settings"])), &s)
		rf := RunFacts{RunID: id, Started: msTime(r["started_ms"]), CorpusFrom: msTime(r["from_ms"]), CorpusTo: msTime(r["to_ms"]),
			EndReason: s.EndReason, Accounts: s.Accounts}
		if len(f.Runs) == 0 { // the newest run's window
			fromMS, toMS = rf.CorpusFrom.UnixMilli(), rf.CorpusTo.UnixMilli()
		}
		f.Runs = append(f.Runs, rf)
	}
	if len(f.Runs) == 0 {
		return f, fmt.Errorf("no %s run to publish", phase)
	}
	rows, err = read.Query(ctx, runsSQL, []chread.Setting{param("phase", PhaseReconcile), param("n", "1")})
	if err != nil {
		return f, fmt.Errorf("read reconcile: %w", err)
	}
	for _, r := range rows {
		id := str(r["run_id"])
		var s ReconcileSummary
		if !runIDRE.MatchString(id) || !strings.HasPrefix(id, PhaseReconcile+"-") || json.Unmarshal([]byte(str(r["settings"])), &s) != nil {
			continue
		}
		f.Reconcile = &ReconcileFacts{RunID: id, Started: msTime(r["started_ms"]), Summary: s}
		break
	}
	ids := make([]string, 0, len(f.Runs))
	for _, r := range f.Runs {
		ids = append(ids, "'"+r.RunID+"'") // runIDRE: no quote or backslash can be in one
	}
	rows, err = read.Query(ctx, countsSQL, []chread.Setting{param("runs", "["+strings.Join(ids, ",")+"]")})
	if err != nil {
		return f, fmt.Errorf("read counts: %w", err)
	}
	for _, r := range rows {
		run, e, v := str(r["run_id"]), str(r["endpoint"]), str(r["verdict"])
		if f.Counts[run] == nil {
			f.Counts[run] = map[string]map[string]int{}
		}
		if f.Counts[run][e] == nil {
			f.Counts[run][e] = map[string]int{}
		}
		f.Counts[run][e][v] += int(num(r["n"]))
	}
	rows, err = read.Query(ctx, latestSQL, []chread.Setting{param("run", f.Runs[0].RunID)})
	if err != nil {
		return f, fmt.Errorf("read results: %w", err)
	}
	for _, r := range rows {
		id, err1 := strconv.ParseUint(str(r["case_id"]), 10, 64)
		sig, err2 := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		f.Latest = append(f.Latest, ResultFacts{CaseID: id, Endpoint: str(r["endpoint"]), Sig: sig, Verdict: str(r["verdict"]),
			Reason: str(r["reason"]), ResultClass: str(r["result_class"]), DiffCategories: strs(r["diff_categories"]),
			UnstablePaths: strs(r["unstable_paths"])})
	}
	rows, err = read.Query(ctx, weightsSQL, []chread.Setting{param("from_ms", strconv.FormatInt(fromMS, 10)),
		param("to_ms", strconv.FormatInt(toMS, 10))})
	if err != nil {
		return f, fmt.Errorf("read weights: %w", err)
	}
	for _, r := range rows {
		sig, err := strconv.ParseUint(str(r["sig"]), 10, 64)
		if err != nil {
			continue
		}
		e := str(r["endpoint"])
		if f.Weights[e] == nil {
			f.Weights[e] = map[uint64]float64{}
		}
		f.Weights[e][sig] += num(r["w"])
	}
	return f, nil
}

func msTime(v any) time.Time {
	ms := int64(num(v))
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

// strs is a JSONEachRow Array(String) column.
func strs(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, e := range list {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return slices.Clip(out)
}
