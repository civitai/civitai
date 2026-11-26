package evalharness

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// Defaults of RunConfig's zero fields.
const (
	DefaultLookback       = 30 * 24 * time.Hour
	DefaultPerEndpointCap = 1500
	DefaultCallTimeout    = 30 * time.Second
	DefaultRPS            = 3.0
	DefaultBurst          = 3
	DefaultConcurrency    = 2
	DefaultHealthInterval = 30 * time.Second
	DefaultMaxPause       = 30 * time.Minute
	DefaultMaxCases       = 10000
	DefaultMaxDuration    = 5 * time.Hour
)

// callsPerCase is a sandwich's calls (N1, G, N2): a case takes them from the bucket at once, so its
// three calls go back to back.
const callsPerCase = 3

// maxAnswerBody bounds one answer's body.
const maxAnswerBody = 32 << 20

// End reasons (the `end_reason` of runs.settings).
const (
	EndDone        = "done"          // every selected case ran
	EndWindow      = "window-closed" // the run window closed
	EndMaxCases    = "max-cases"
	EndMaxDuration = "max-duration"
	EndCanceled    = "canceled"
	// EndHealth is the prefix of a run ended by a pause longer than MaxPause: "health:<check>:<why>".
	EndHealth = "health"
)

// RunConfig is one live run.
type RunConfig struct {
	// NodeURL and GoURL are the two implementations' base URLs (the job's localhost sidecars).
	NodeURL, GoURL string
	// Endpoints run (nil: evalcorpus.Endpoints).
	Endpoints []string
	// Lookback is how far back samples weigh signatures; PerEndpointCap the signatures run per
	// endpoint.
	Lookback       time.Duration
	PerEndpointCap int
	// CallTimeout bounds one call.
	CallTimeout time.Duration
	// RPS and Burst pace every outbound call; Concurrency is the cases in flight.
	RPS         float64
	Burst       int
	Concurrency int
	// Window is when the run may start and schedule cases; ForceWindow ignores it entirely.
	Window      Window
	ForceWindow bool
	// Health pauses the run while a check fails (nil: no guard; AllowNoHealth must then be set).
	Health         *Health
	AllowNoHealth  bool
	HealthInterval time.Duration
	// MaxPause ends a run paused longer than this.
	MaxPause time.Duration
	// MaxCases and MaxDuration are the run's budget.
	MaxCases    int
	MaxDuration time.Duration
	// NodeImage, GoImage and SnapshotID are recorded on the run row.
	NodeImage, GoImage, SnapshotID string

	Clock Clock
	HTTP  *http.Client
	// Log receives progress lines (no values, no credentials).
	Log io.Writer
}

func (c *RunConfig) defaults() {
	if c.Endpoints == nil {
		c.Endpoints = evalcorpus.Endpoints
	}
	if c.Lookback <= 0 {
		c.Lookback = DefaultLookback
	}
	if c.PerEndpointCap <= 0 {
		c.PerEndpointCap = DefaultPerEndpointCap
	}
	if c.CallTimeout <= 0 {
		c.CallTimeout = DefaultCallTimeout
	}
	if c.RPS <= 0 {
		c.RPS = DefaultRPS
	}
	if c.Burst <= 0 {
		c.Burst = DefaultBurst
	}
	if c.Concurrency <= 0 {
		c.Concurrency = DefaultConcurrency
	}
	if c.Window == (Window{}) {
		c.Window = DefaultWindow
	}
	if c.HealthInterval <= 0 {
		c.HealthInterval = DefaultHealthInterval
	}
	if c.MaxPause <= 0 {
		c.MaxPause = DefaultMaxPause
	}
	if c.MaxCases <= 0 {
		c.MaxCases = DefaultMaxCases
	}
	if c.MaxDuration <= 0 {
		c.MaxDuration = DefaultMaxDuration
	}
	if c.Clock == nil {
		c.Clock = RealClock{}
	}
	if c.HTTP == nil {
		c.HTTP = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	if c.Log == nil {
		c.Log = io.Discard
	}
}

// validate refuses a config that cannot run safely.
func (c *RunConfig) validate() error {
	for _, u := range []string{c.NodeURL, c.GoURL} {
		p, err := url.Parse(u)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return errors.New("NODE_URL and GO_URL must be absolute http(s) URLs")
		}
	}
	for _, e := range c.Endpoints {
		if _, err := evalcorpus.MasksFor(e); err != nil {
			return fmt.Errorf("endpoint %q: not a corpus endpoint", e)
		}
		// A comparison the server never decided would fall to the gallery's default: never score by it.
		if !server.HasCompareSelection(e) {
			return fmt.Errorf("endpoint %q: no compare selection (server.HasCompareSelection)", e)
		}
	}
	if c.Burst < callsPerCase {
		return fmt.Errorf("burst must be at least %d (one case's calls)", callsPerCase)
	}
	if c.Health == nil || len(c.Health.Checks) == 0 {
		if !c.AllowNoHealth {
			return errors.New("no health check: give --prom-url and --health (or --allow-no-health)")
		}
	} else if c.Health.PromURL == "" {
		return errors.New("health checks need --prom-url")
	}
	return nil
}

// Settings is the run row's `settings`: the effective non-secret settings (no URL, no PromQL, no
// account) and why the run ended.
type Settings struct {
	Endpoints      []string           `json:"endpoints"`
	Day            string             `json:"day"`
	LookbackHours  float64            `json:"lookback_hours"`
	PerEndpointCap int                `json:"per_endpoint_cap"`
	CallTimeoutMS  int64              `json:"call_timeout_ms"`
	RPS            float64            `json:"rps"`
	Burst          int                `json:"burst"`
	Concurrency    int                `json:"concurrency"`
	Window         string             `json:"window"`
	ForceWindow    bool               `json:"force_window"`
	HealthChecks   map[string]float64 `json:"health_checks"`
	HealthInterval string             `json:"health_interval"`
	MaxPause       string             `json:"max_pause"`
	MaxCases       int                `json:"max_cases"`
	MaxDuration    string             `json:"max_duration"`
	Selected       map[string]int     `json:"selected"`
	// Accounts are the accounts whose session tokens are expiring, expired or have no exp at start.
	Accounts      []AccountNote  `json:"accounts"`
	Verdicts      map[string]int `json:"verdicts"`
	RowsNotQueued int            `json:"rows_not_queued"`
	EndReason     string         `json:"end_reason"`
}

// Run is one live run: select the cases, replay each under the guards, write a results row per case
// and the runs row at the end. It returns the run row (also written) or an error before any case ran.
func Run(ctx context.Context, cfg RunConfig, accounts *Accounts, store Store) (RunRow, error) {
	cfg.defaults()
	if err := cfg.validate(); err != nil {
		return RunRow{}, err
	}
	clk := cfg.Clock
	started := clk.Now().UTC()
	if !cfg.ForceWindow && !cfg.Window.Contains(started) {
		return RunRow{}, fmt.Errorf("outside the run window %s UTC (--force-window to run anyway)", cfg.Window)
	}
	runID, err := NewRunID(PhaseLive, started)
	if err != nil {
		return RunRow{}, err
	}
	day := started.Format(time.DateOnly)
	from := started.Add(-cfg.Lookback)
	settings := Settings{
		Endpoints: cfg.Endpoints, Day: day, LookbackHours: cfg.Lookback.Hours(), PerEndpointCap: cfg.PerEndpointCap,
		CallTimeoutMS: cfg.CallTimeout.Milliseconds(), RPS: cfg.RPS, Burst: cfg.Burst, Concurrency: cfg.Concurrency,
		Window: cfg.Window.String(), ForceWindow: cfg.ForceWindow, HealthChecks: map[string]float64{},
		HealthInterval: cfg.HealthInterval.String(), MaxPause: cfg.MaxPause.String(), MaxCases: cfg.MaxCases,
		MaxDuration: cfg.MaxDuration.String(), Selected: map[string]int{}, Verdicts: map[string]int{},
		Accounts: accounts.Notes(),
	}
	if cfg.Health != nil {
		for _, c := range cfg.Health.Checks {
			settings.HealthChecks[c.Name] = c.Max
		}
	}
	perEndpoint := make([][]Case, 0, len(cfg.Endpoints))
	for _, e := range cfg.Endpoints {
		cases, err := store.SelectCases(ctx, e, from, started, day, cfg.PerEndpointCap)
		if err != nil {
			return RunRow{}, fmt.Errorf("select %s cases: %w", e, err)
		}
		settings.Selected[e] = len(cases)
		perEndpoint = append(perEndpoint, cases)
	}
	queue := interleave(perEndpoint)
	_, _ = fmt.Fprintf(cfg.Log, "feed-eval run %s: %d cases selected\n", runID, len(queue))

	r := &runner{cfg: cfg, runID: runID, store: store, accounts: accounts,
		bucket: NewTokenBucket(clk, cfg.RPS, cfg.Burst), started: started}
	end := r.loop(ctx, queue)
	settings.EndReason = end
	r.mu.Lock()
	for k, v := range r.verdicts {
		settings.Verdicts[k] = v
	}
	settings.RowsNotQueued = r.notQueued
	r.mu.Unlock()
	sj, err := json.Marshal(settings)
	if err != nil {
		return RunRow{}, err
	}
	row := RunRow{RunID: runID, Phase: PhaseLive, NodeImage: cfg.NodeImage, GoImage: cfg.GoImage, SnapshotID: cfg.SnapshotID,
		CorpusFrom: rowTime(from), CorpusTo: rowTime(started), Settings: string(sj), Started: rowTime(started),
		Finished: rowTime(clk.Now())}
	if !store.AddRun(row) {
		return row, errors.New("the runs row was not queued")
	}
	_, _ = fmt.Fprintf(cfg.Log, "feed-eval run %s: ended (%s)\n", runID, end)
	return row, nil
}

// NewRunID is `<phase>-<UTC yyyymmddThhmmssZ>-<6 random hex>`.
func NewRunID(phase string, t time.Time) (string, error) {
	var b [3]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return phase + "-" + t.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b[:]), nil
}

// interleave takes one case from each endpoint in turn, so a run cut short still covers every
// endpoint's heaviest signatures.
func interleave(lists [][]Case) []Case {
	var out []Case
	for i := 0; ; i++ {
		took := false
		for _, l := range lists {
			if i < len(l) {
				out = append(out, l[i])
				took = true
			}
		}
		if !took {
			return out
		}
	}
}

type runner struct {
	cfg      RunConfig
	runID    string
	store    Store
	accounts *Accounts
	bucket   *TokenBucket
	started  time.Time

	lastCheck   time.Time
	healthKnown bool

	mu        sync.Mutex
	verdicts  map[string]int
	notQueued int
}

// loop schedules the queue on Concurrency workers, gating each case (gate), and returns why it ended.
func (r *runner) loop(ctx context.Context, queue []Case) string {
	r.verdicts = map[string]int{}
	work := make(chan Case)
	var wg sync.WaitGroup
	for range r.cfg.Concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range work {
				r.runCase(ctx, c)
			}
		}()
	}
	end := EndDone
	for i, c := range queue {
		if i >= r.cfg.MaxCases {
			end = EndMaxCases
			break
		}
		if why := r.gate(ctx); why != "" {
			end = why
			break
		}
		select {
		case work <- c:
		case <-ctx.Done():
			end = EndCanceled
		}
		if end == EndCanceled {
			break
		}
	}
	close(work)
	wg.Wait()
	return end
}

// gate decides whether the next case may start: "" yes, else why the run ends. It ends the run when
// the budget's duration is spent or the window closed (unless forced), and pauses while the health
// check fails, ending the run once paused longer than MaxPause.
func (r *runner) gate(ctx context.Context) string {
	clk := r.cfg.Clock
	var pausedSince time.Time
	for {
		if ctx.Err() != nil {
			return EndCanceled
		}
		now := clk.Now()
		if now.Sub(r.started) >= r.cfg.MaxDuration {
			return EndMaxDuration
		}
		if !r.cfg.ForceWindow && !r.cfg.Window.Contains(now) {
			return EndWindow
		}
		h := r.cfg.Health
		if h == nil || len(h.Checks) == 0 {
			return ""
		}
		if r.healthKnown && pausedSince.IsZero() && now.Sub(r.lastCheck) < r.cfg.HealthInterval {
			return ""
		}
		ok, why := h.Check(ctx)
		r.lastCheck, r.healthKnown = clk.Now(), true
		if ok {
			if !pausedSince.IsZero() {
				_, _ = fmt.Fprintf(r.cfg.Log, "feed-eval run %s: resumed after %s\n", r.runID, clk.Now().Sub(pausedSince).Round(time.Second))
			}
			return ""
		}
		if pausedSince.IsZero() {
			pausedSince = now
			_, _ = fmt.Fprintf(r.cfg.Log, "feed-eval run %s: paused (%s)\n", r.runID, why)
		} else if now.Sub(pausedSince) > r.cfg.MaxPause {
			return EndHealth + ":" + why
		}
		if err := clk.Sleep(ctx, r.cfg.HealthInterval); err != nil {
			return EndCanceled
		}
	}
}

// runCase replays one case and writes its results row.
func (r *runner) runCase(ctx context.Context, c Case) {
	row := ResultRow{RunID: r.runID, CaseID: c.ID, Endpoint: c.Endpoint, Sig: c.Sig, DiffCategories: []string{}, UnstablePaths: []string{}}
	out, n1, g := r.replay(ctx, c, &row)
	row.Verdict, row.Reason, row.ResultClass = out.Verdict, safeReason(out.Reason), out.ResultClass
	if out.DiffCategories != nil {
		row.DiffCategories = out.DiffCategories
	}
	if out.UnstablePaths != nil {
		row.UnstablePaths = out.UnstablePaths
	}
	row.NodeStatus, row.GoStatus = status16(n1.Status), status16(g.Status)
	row.NodeMS, row.GoMS = float32(n1.Duration.Seconds()*1000), float32(g.Duration.Seconds()*1000)
	row.TS = rowTime(r.cfg.Clock.Now())
	queued := r.store.AddResult(row)
	r.mu.Lock()
	r.verdicts[row.Verdict]++
	if !queued {
		r.notQueued++
	}
	r.mu.Unlock()
}

// safeReason is a reason as written: "" stays "".
func safeReason(s string) string {
	if s == "" {
		return ""
	}
	return safeToken(s)
}

func status16(s int) uint16 {
	if s < 0 || s > 65535 {
		return 0
	}
	return uint16(s)
}

// replay maps the viewer, builds the request and runs the sandwich; it fills row.ViewerUsed.
func (r *runner) replay(ctx context.Context, c Case, row *ResultRow) (Outcome, Answer, Answer) {
	creds, why := r.accounts.Resolve(MapViewer(c.Request.Viewer, c.Request.Credential))
	if why != "" {
		return Outcome{Verdict: VerdictNotReplayable, Reason: why}, Answer{}, Answer{}
	}
	row.ViewerUsed = creds.ViewerUsed
	p, why := Prepare(c, creds)
	if why != "" {
		return Outcome{Verdict: VerdictNotReplayable, Reason: why}, Answer{}, Answer{}
	}
	if err := r.bucket.Wait(ctx, callsPerCase); err != nil {
		return Outcome{Verdict: VerdictInfraMiss, Reason: ReasonCanceled}, Answer{}, Answer{}
	}
	n1 := r.call(ctx, r.cfg.NodeURL, p, true)
	g := r.call(ctx, r.cfg.GoURL, p, false)
	n2 := r.call(ctx, r.cfg.NodeURL, p, true)
	masks, _ := evalcorpus.MasksFor(c.Endpoint) // validated at start
	return Score(server.CompareSelection(c.Endpoint), masks, n1, g, n2), n1, g
}

// call sends p to base (Node calls carry server.ParityReplayHeader: Node neither samples them nor
// writes them as devalue).
func (r *runner) call(parent context.Context, base string, p *Prepared, node bool) Answer {
	ctx, cancel := context.WithTimeout(parent, r.cfg.CallTimeout)
	defer cancel()
	// A failure is the call's own timeout only when the run itself was not cancelled: a cancelled
	// run's case in flight is Canceled, never a timeout of either side.
	failed := func(err error, a Answer) Answer {
		a.Err = redactURL(err)
		a.Canceled = parent.Err() != nil
		a.Timeout = !a.Canceled && ctx.Err() != nil
		return a
	}
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return Answer{Err: err}
	}
	u.Path += p.Path
	u.RawQuery = p.RawQuery
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Answer{Err: err}
	}
	req.Header = p.Header.Clone()
	if p.Host != "" {
		req.Host = p.Host
	}
	if node {
		req.Header.Set(server.ParityReplayHeader, "1")
	}
	start := time.Now()
	resp, err := r.cfg.HTTP.Do(req)
	if err != nil {
		return failed(err, Answer{Duration: time.Since(start)})
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswerBody))
	a := Answer{Status: resp.StatusCode, Header: resp.Header, Body: body, Duration: time.Since(start)}
	if err != nil {
		return failed(err, a)
	}
	return a
}

// redactURL drops the request URL (it carries the case's input and a token) from a transport error.
func redactURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
