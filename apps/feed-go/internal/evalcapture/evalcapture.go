// Package evalcapture is the capture side of the production-derived evals (DESIGN.md §19.6): it turns
// one request the server saw (a Node shadow sample, a serve-parity replay, or a sampled public
// request) into a `samples` row and, when the request is admitted to the corpus, a `cases` row, and
// hands both to the ClickHouse writers (internal/chwrite) without ever waiting on them.
//
// Every capture goes through Recorder.Record, the one entry point: it strips the request
// (evalcorpus.Capture: credentials, client address, the viewer's own ids), computes the signature,
// applies the per-pod daily admission limits, and queues the rows. Nothing here blocks: a full
// writer queue drops the row (outcome dropped).
//
// Insert-once (the `cases` pin contract): the writer login can INSERT but not SELECT, and `cases` is
// a ReplacingMergeTree versioned by last_seen, where the row with the newest last_seen wins. The
// harness (SELECT + INSERT) pins a case by re-inserting it with pinned = 1 and a later last_seen. A
// row this package inserts must therefore never be able to outrank a harness row, whenever it lands:
//
//   - a case_id is derived from the UTC day of the capture and the stored request
//     (CaseID: xxhash64 of day, endpoint, signature and the stored request), so a request seen again
//     on a later day is a new case, never a re-insert of a pinned one;
//   - every row this package writes for a case_id carries first_seen = last_seen = 00:00:00.000 UTC
//     of that day (the day the id is derived from), and pinned = 0. Every copy of one case_id, from
//     any pod, at any time, carries the same version;
//   - the harness's rule (DESIGN.md §19.6): any row it writes for a case carries a last_seen strictly
//     later than the start of the case's day (it writes now(), or the case's last_seen + 1 ms if that
//     is later). So a feed-go copy that lands after a pin (another pod's duplicate, a retried batch)
//     carries an older version and loses to the pin when the parts merge.
//
// Within a pod, a case_id is inserted at most once per day (Recorder keeps the day's admitted ids).
// Across pods the same request on the same day can be admitted twice: both rows carry the same
// version and the same stored request, so ReplacingMergeTree keeps one of them (node_body may differ
// between the two copies; either is a recorded Node answer to that request).
package evalcapture

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cespare/xxhash/v2"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/chwrite"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// Sources: where a capture's Node answer (or outcome) came from (the `source` column and metric label).
const (
	// SourceShadow: a Node shadow sample (the request Node served and posted to the compare endpoint).
	SourceShadow = "shadow"
	// SourceServeParity: a request this service served, replayed to the Node app (serve-parity).
	SourceServeParity = "serve-parity"
	// SourceServe: a public request sampled at FEED_GO_EVAL_CAPTURE_SERVE_RATE, served here or handed
	// back; no Node answer.
	SourceServe = "serve"
	// SourceCorpusOnly: a Node corpus-only sample (FEED_GO_SHADOW_CORPUS_ONLY_RATE, DESIGN.md §19.6
	// T4): a credentialed `/api/v1/models/[id]` or tRPC `image.getInfinite` request with its
	// credential taken out by Node, kept as its class (evalcorpus.Request.CredentialClass); never
	// compared, no Node answer.
	SourceCorpusOnly = "corpus-only"
)

// Sources is every source, in a fixed order.
var Sources = []string{SourceShadow, SourceServeParity, SourceServe, SourceCorpusOnly}

// Outcomes of feed_go_eval_capture_total: every Record of a supported endpoint ends in exactly one.
const (
	// OutcomeWritten: the request was admitted to the corpus; its sample and case rows were queued.
	OutcomeWritten = "written"
	// OutcomeDeduped: not admitted (the day's exemplars of its shape and outcome, its mismatch
	// categories' budget, or the endpoint's daily cap were used up, or the identical case was already
	// admitted today); its sample row was queued.
	OutcomeDeduped = "deduped"
	// OutcomeDropped: a row was not queued (a writer's queue was full or closed), or nothing could be
	// captured (the viewer could not be resolved, or the request did not build a case).
	OutcomeDropped = "dropped"
	// OutcomeRefused: SourceCorpusOnly only, counted by the server before Record: a corpus-only sample
	// that still carried a credential, a credential class other than header or query, or Node's answer.
	// Never recorded.
	OutcomeRefused = "refused"
)

// Outcomes is every outcome Record returns, in a fixed order (OutcomeRefused is the server's).
var Outcomes = []string{OutcomeWritten, OutcomeDeduped, OutcomeDropped}

// Production results a capture records besides the comparison results (prod_result).
const (
	// ResultServed: SourceServe, answered here (served, served_empty, served_cached).
	ResultServed = "served"
	// ResultHandback: SourceServe, handed to the Node app (fallback_reason says why).
	ResultHandback = "handback"
	// ResultError: SourceServe, handed back after a compute error (not a fallback).
	ResultError = "error"
	// ResultCorpusOnly: SourceCorpusOnly, never compared (its own outcome class).
	ResultCorpusOnly = "corpus-only"
)

// Origins of a case row (the `origin` column).
const (
	OriginSample   = "sample"
	OriginMismatch = "prod-mismatch"
	// OriginTempo: imported from a feed-bench Tempo capture (`feed-eval import-tempo`), never by
	// feed-go. Its case ids are derived from a day namespaced by this origin (TempoCaseDay), so no
	// imported case can share an id with a captured one.
	OriginTempo = "tempo"
)

// TempoCaseDay is the day CaseID is given for an imported Tempo case: the record's UTC day prefixed
// with OriginTempo, a string no capture day can equal.
func TempoCaseDay(day string) string { return OriginTempo + ":" + day }

// Defaults of the admission limits (Config zero values).
const (
	// DefaultExemplars is K: cases admitted per (endpoint, signature, outcome class) per day per pod.
	DefaultExemplars = 3
	// DefaultMismatchesPerCategory: mismatch cases admitted per (endpoint, diff category) per day per pod.
	DefaultMismatchesPerCategory = 20
	// DefaultEndpointDailyCap: cases admitted per endpoint per day per pod.
	DefaultEndpointDailyCap = 20000
)

// Sink is where rows go: a chwrite.Writer in production. Add must not block; false = not queued.
type Sink interface {
	Add(row any) bool
}

// Config is a Recorder's setup.
type Config struct {
	// Samples and Cases receive the `samples` and `cases` rows. Required.
	Samples, Cases Sink
	// HostColors, RegionRules and RegionBlockRules are what the host and region classes are read
	// against (evalcorpus.Env).
	HostColors                    browsing.HostColors
	RegionRules, RegionBlockRules []browsing.RegionRule
	// GoVersion is this binary's version (the `go_version` column).
	GoVersion string
	// Now is the clock (nil: time.Now). It decides the capture day and the timestamps.
	Now func() time.Time
	// The admission limits (0: the Default* values).
	Exemplars, MismatchesPerCategory, EndpointDailyCap int
}

// Sample is one capture, as a tap hands it to Record.
type Sample struct {
	Source string
	// Request is the request as the server saw it, credentials included: Record strips them.
	Request evalcorpus.Request
	// Viewer is who made it; ViewerKnown false when it could not be resolved (Record then drops it:
	// without the viewer the input cannot be searched for the viewer's own ids).
	Viewer      evalcorpus.Viewer
	ViewerKnown bool
	// Weight is 1 / the effective rate this request was sampled at (0: unknown).
	Weight float64
	// ProdResult is the production verdict: a comparison result (match, fields, …, unsupported,
	// deadline, go_error, bad_request) for a shadow or serve-parity capture, ResultServed /
	// ResultHandback / ResultError for a serve capture.
	ProdResult string
	// FallbackReason is the hand-back's reason ("" when none).
	FallbackReason string
	// DiffCategories are the comparison's differing path categories (no values).
	DiffCategories []string
	// HeaderResult is the header comparison's result (match | mismatch | uncompared; "" when none).
	HeaderResult string
	// NodeBody and NodeHeaders are Node's answer, when the capture has one. Kept only for a request
	// with no session user and no credential (Record decides, keepNodeAnswer).
	NodeBody    []byte
	NodeHeaders map[string]string
}

// SampleRow is a `samples` row.
type SampleRow struct {
	TS             string   `json:"ts"`
	Endpoint       string   `json:"endpoint"`
	Source         string   `json:"source"`
	Sig            uint64   `json:"sig"`
	SigText        string   `json:"sig_text"`
	ViewerClass    string   `json:"viewer_class"`
	HostClass      string   `json:"host_class"`
	Weight         float64  `json:"weight"`
	ProdResult     string   `json:"prod_result"`
	FallbackReason string   `json:"fallback_reason"`
	DiffCategories []string `json:"diff_categories"`
	HeaderResult   string   `json:"header_result"`
	GoVersion      string   `json:"go_version"`
	CaseID         uint64   `json:"case_id"`
}

// CaseRow is a `cases` row.
type CaseRow struct {
	CaseID      uint64            `json:"case_id"`
	Endpoint    string            `json:"endpoint"`
	Sig         uint64            `json:"sig"`
	SigText     string            `json:"sig_text"`
	Origin      string            `json:"origin"`
	Request     string            `json:"request"`
	NodeBody    string            `json:"node_body"`
	NodeHeaders map[string]string `json:"node_headers"`
	ProdResult  string            `json:"prod_result"`
	Pinned      uint8             `json:"pinned"`
	FirstSeen   string            `json:"first_seen"`
	LastSeen    string            `json:"last_seen"`
}

// StoredRequest is a case's `request` column: what the replay rebuilds the request from.
type StoredRequest struct {
	Input      string                      `json:"input,omitempty"`
	Path       string                      `json:"path,omitempty"`
	Query      string                      `json:"query,omitempty"`
	Headers    map[string]string           `json:"headers"`
	Credential string                      `json:"credential"`
	Viewer     evalcorpus.ViewerDescriptor `json:"viewer"`
}

// TimeFormat is how timestamps are written: RFC 3339 in UTC with milliseconds. The writer's URL
// carries date_time_input_format=best_effort (NewWriters), so ClickHouse reads the zone, whatever
// the server's own time zone.
const TimeFormat = "2006-01-02T15:04:05.000Z"

// Recorder admits and writes captures. Safe for concurrent use.
type Recorder struct {
	cfg Config
	now func() time.Time

	mu sync.Mutex
	// day is the UTC day the counters below are for; they reset when it changes.
	day         string
	exemplars   map[exemplarKey]int
	mismatches  map[categoryKey]int
	perEndpoint map[string]int
	admitted    map[uint64]bool
}

type exemplarKey struct {
	endpoint string
	sig      uint64
	class    string
}

type categoryKey struct{ endpoint, category string }

// New is a Recorder over cfg.
func New(cfg Config) *Recorder {
	if cfg.Exemplars <= 0 {
		cfg.Exemplars = DefaultExemplars
	}
	if cfg.MismatchesPerCategory <= 0 {
		cfg.MismatchesPerCategory = DefaultMismatchesPerCategory
	}
	if cfg.EndpointDailyCap <= 0 {
		cfg.EndpointDailyCap = DefaultEndpointDailyCap
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Recorder{cfg: cfg, now: now}
}

// Supported reports whether endpoint is one the corpus has rules for (evalcorpus.Endpoints). A tap
// skips every other endpoint before doing any work, and Record returns "" for one.
func Supported(endpoint string) bool {
	return slices.Contains(evalcorpus.Endpoints, endpoint)
}

// MatchResults and MismatchResults are the comparison results (prod_result) of the match and the
// mismatch outcome classes: the one list OutcomeClass and the harness's reconcile read them from.
var (
	MatchResults    = []string{"match", "match_empty", "match_cached"}
	MismatchResults = []string{"fields", "order", "membership"}
)

// OutcomeClass is the class a production result is deduplicated under: match, mismatch, served,
// handback, corpus-only or error.
func OutcomeClass(prodResult string) string {
	switch {
	case slices.Contains(MatchResults, prodResult):
		return "match"
	case slices.Contains(MismatchResults, prodResult):
		return "mismatch"
	}
	switch prodResult {
	case ResultServed:
		return "served"
	case ResultHandback, "unsupported", "deadline":
		return "handback"
	case ResultCorpusOnly:
		return ResultCorpusOnly
	}
	return "error"
}

// Record captures s and returns its outcome (OutcomeWritten, OutcomeDeduped or OutcomeDropped), or ""
// for an endpoint that is not Supported (nothing done, nothing to count).
func (r *Recorder) Record(s Sample) string {
	if !Supported(s.Request.Endpoint) {
		return ""
	}
	if !s.ViewerKnown {
		return OutcomeDropped
	}
	now := r.now().UTC()
	c, err := evalcorpus.Capture(s.Request, s.Viewer, evalcorpus.Env{
		HostColors: r.cfg.HostColors, RegionRules: r.cfg.RegionRules, RegionBlockRules: r.cfg.RegionBlockRules, Now: now,
	}, evalcorpus.Extra{})
	if err != nil {
		return OutcomeDropped
	}
	sig, err := strconv.ParseUint(c.Signature, 16, 64)
	if err != nil {
		return OutcomeDropped
	}
	reqJSON, err := Stored(c)
	if err != nil {
		return OutcomeDropped
	}
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	day := dayStart.Format(time.DateOnly)
	caseID := CaseID(day, c.Endpoint, c.Signature, reqJSON)
	class := OutcomeClass(s.ProdResult)
	categories := uniqueSorted(s.DiffCategories)
	admit := r.admit(day, c.Endpoint, sig, class, categories, caseID)

	row := SampleRow{
		TS: now.Format(TimeFormat), Endpoint: c.Endpoint, Source: s.Source, Sig: sig, SigText: c.Shape,
		ViewerClass: c.Viewer.Class, HostClass: evalcorpus.HostClass(r.cfg.HostColors, c.Headers["host"]),
		Weight: s.Weight, ProdResult: s.ProdResult, FallbackReason: s.FallbackReason, DiffCategories: categories,
		HeaderResult: s.HeaderResult, GoVersion: r.cfg.GoVersion,
	}
	if admit == nil {
		if !r.cfg.Samples.Add(row) {
			return OutcomeDropped
		}
		return OutcomeDeduped
	}
	cr := CaseRow{
		CaseID: caseID, Endpoint: c.Endpoint, Sig: sig, SigText: c.Shape, Origin: OriginSample,
		Request: string(reqJSON), NodeHeaders: map[string]string{}, ProdResult: s.ProdResult,
		FirstSeen: dayStart.Format(TimeFormat), LastSeen: dayStart.Format(TimeFormat),
	}
	if class == "mismatch" {
		cr.Origin = OriginMismatch
	}
	if keepNodeAnswer(c) {
		cr.NodeBody = string(s.NodeBody)
		for k, v := range s.NodeHeaders {
			cr.NodeHeaders[k] = v
		}
	}
	// The case first, and the sample names it only once it is queued: a sample never carries the id of
	// a case that was not (case_id 0 then, as for a capture not admitted).
	if !r.cfg.Cases.Add(cr) {
		// The case never reached the queue: its admission is handed back, so a later request can
		// take the slot.
		r.release(admit)
		r.cfg.Samples.Add(row)
		return OutcomeDropped
	}
	row.CaseID = caseID
	if !r.cfg.Samples.Add(row) {
		return OutcomeDropped
	}
	return OutcomeWritten
}

// Stored is a case's `request` column: the stripped case as the replay rebuilds it, with any search
// text replaced (redactSearchText). The one way a stored request is built, for a capture and for an
// imported case alike.
func Stored(c *evalcorpus.Case) ([]byte, error) {
	return json.Marshal(StoredRequest{Input: redactSearchText(c.Input), Path: c.Path, Query: c.Query, Headers: c.Headers,
		Credential: c.Credential, Viewer: c.Viewer})
}

// keepNodeAnswer: Node's answer is stored only for a request made with no session user (anon, or a
// verified crawler) and no credential of any kind, the answer anyone sending that request gets.
func keepNodeAnswer(c *evalcorpus.Case) bool {
	return (c.Viewer.Class == evalcorpus.ViewerAnon || c.Viewer.Class == evalcorpus.ViewerCrawler) &&
		c.Credential == evalcorpus.CredentialNone
}

// CaseID is a case's id: xxhash64 of the capture's UTC day (YYYY-MM-DD), the endpoint, the signature
// and the stored request (the `request` column's JSON), never 0 (0 is "not admitted" in `samples`).
// The same request on the same day has the same id on every pod; on another day another id.
func CaseID(day, endpoint, signature string, storedRequest []byte) uint64 {
	d := xxhash.New()
	for _, part := range [][]byte{[]byte(day), []byte(endpoint), []byte(signature), storedRequest} {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(part)))
		_, _ = d.Write(n[:])
		_, _ = d.Write(part)
	}
	if id := d.Sum64(); id != 0 {
		return id
	}
	return 1
}

// admission is what admit took, so release can hand it back.
type admission struct {
	day        string
	exemplar   exemplarKey
	categories []categoryKey
	endpoint   string
	caseID     uint64
}

// admit decides whether a capture becomes a case, and takes its share of the day's limits when it
// does (nil: not admitted). A mismatch needs, besides an exemplar slot, a diff category (or `none`
// when it has none) still under its daily budget; it takes one from each of its categories under it.
func (r *Recorder) admit(day, endpoint string, sig uint64, class string, categories []string, caseID uint64) *admission {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.day != day {
		r.day = day
		r.exemplars = map[exemplarKey]int{}
		r.mismatches = map[categoryKey]int{}
		r.perEndpoint = map[string]int{}
		r.admitted = map[uint64]bool{}
	}
	if r.admitted[caseID] || r.perEndpoint[endpoint] >= r.cfg.EndpointDailyCap {
		return nil
	}
	ek := exemplarKey{endpoint, sig, class}
	if r.exemplars[ek] >= r.cfg.Exemplars {
		return nil
	}
	a := &admission{day: day, exemplar: ek, endpoint: endpoint, caseID: caseID}
	if class == "mismatch" {
		if len(categories) == 0 {
			categories = []string{"none"}
		}
		for _, cat := range categories {
			if k := (categoryKey{endpoint, cat}); r.mismatches[k] < r.cfg.MismatchesPerCategory {
				a.categories = append(a.categories, k)
			}
		}
		if len(a.categories) == 0 {
			return nil
		}
		for _, k := range a.categories {
			r.mismatches[k]++
		}
	}
	r.exemplars[ek]++
	r.perEndpoint[endpoint]++
	r.admitted[caseID] = true
	return a
}

// release hands back what admit took (a case that was not queued), if the day has not turned since.
func (r *Recorder) release(a *admission) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.day != a.day {
		return
	}
	r.exemplars[a.exemplar]--
	for _, k := range a.categories {
		r.mismatches[k]--
	}
	r.perEndpoint[a.endpoint]--
	delete(r.admitted, a.caseID)
}

// Tables are the table names the writers insert into; the database is the writer URL's path
// (chwrite.Config.URL), so no database name is written here.
const (
	SamplesTable = "samples"
	CasesTable   = "cases"
)

// WriterConfig is where the capture writes: FEED_GO_EVAL_CLICKHOUSE_URL (an http(s) URL whose path
// names the database), _USER and _PASSWORD, for an INSERT-only login.
type WriterConfig struct {
	URL, Username, Password string
	// Dropped is chwrite.Config's, with the table (SamplesTable or CasesTable) the rows were for;
	// OnError is chwrite.Config's. Both are called concurrently and must not block.
	Dropped func(table string, n int, reason string)
	OnError func(err error)
}

// NewWriters starts the two writers (samples, cases). The URL gets date_time_input_format=best_effort,
// so the RFC 3339 timestamps (TimeFormat) are read with their zone.
func NewWriters(cfg WriterConfig) (samples, cases *chwrite.Writer, err error) {
	u, err := url.Parse(cfg.URL)
	if err != nil {
		// Not wrapped: url.Parse's error repeats the URL, which may carry a host.
		return nil, nil, errors.New("eval clickhouse url: not a URL")
	}
	if strings.Trim(u.Path, "/") == "" {
		return nil, nil, errors.New("eval clickhouse url: its path must name the database")
	}
	q := u.Query()
	q.Set("date_time_input_format", "best_effort")
	u.RawQuery = q.Encode()
	mk := func(table string) (*chwrite.Writer, error) {
		var dropped func(int, string)
		if cfg.Dropped != nil {
			dropped = func(n int, reason string) { cfg.Dropped(table, n, reason) }
		}
		return chwrite.New(chwrite.Config{
			URL: u.String(), Username: cfg.Username, Password: cfg.Password, Table: table,
			MaxRetries: 2, Dropped: dropped, OnError: cfg.OnError,
		})
	}
	if samples, err = mk(SamplesTable); err != nil {
		return nil, nil, err
	}
	if cases, err = mk(CasesTable); err != nil {
		_ = samples.Close(context.Background())
		return nil, nil, err
	}
	return samples, cases, nil
}

// SearchPlaceholder replaces a free-text search value in a stored case (searchKeys).
const SearchPlaceholder = "$search"

// searchKeys are the tRPC input keys holding free text a user typed (model.getAll's `query`). A case
// lives 90 days or more (forever when pinned), and search text is kept at most 30 days (DESIGN.md
// §19.6), so a case never stores it: a non-empty string value is replaced by SearchPlaceholder. The
// shape still records the value's class, so the signature is unchanged; the replay substitutes a
// search text of its own.
var searchKeys = []string{"query"}

// redactSearchText is a stored tRPC input (the superjson envelope evalcorpus wrote) with every
// searchKeys string value that is not empty replaced by SearchPlaceholder. An input with none is
// returned as it is; one that does not decode as an envelope object is returned as "" (not stored).
func redactSearchText(input string) string {
	if input == "" {
		return ""
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(input), &env); err != nil {
		return ""
	}
	var body map[string]json.RawMessage
	if raw, ok := env["json"]; !ok || json.Unmarshal(raw, &body) != nil {
		return input // not an object input: no key to hold search text
	}
	changed := false
	for _, k := range searchKeys {
		var v string
		if raw, ok := body[k]; ok && json.Unmarshal(raw, &v) == nil && v != "" {
			body[k] = json.RawMessage(`"` + SearchPlaceholder + `"`)
			changed = true
		}
	}
	if !changed {
		return input
	}
	b, err := json.Marshal(body)
	if err != nil {
		return ""
	}
	env["json"] = b
	out, err := json.Marshal(env)
	if err != nil {
		return ""
	}
	return string(out)
}

func uniqueSorted(in []string) []string {
	out := slices.Clone(in)
	slices.Sort(out)
	out = slices.Compact(out)
	if out == nil {
		out = []string{}
	}
	return out
}
