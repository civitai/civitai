package evalharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/chwrite"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
)

// Tables the harness reads (cases, samples) and writes (results, runs). The database is the
// ClickHouse URL's path, as the capture's: no database name is written here.
const (
	ResultsTable = "results"
	RunsTable    = "runs"
)

// CHTimeFormat is how a DateTime64(3) query parameter is sent (the parameter's type names UTC).
const CHTimeFormat = "2006-01-02 15:04:05.000"

// ResultRow is a `results` row; its JSON names are the table's columns.
type ResultRow struct {
	RunID          string   `json:"run_id"`
	CaseID         uint64   `json:"case_id"`
	Endpoint       string   `json:"endpoint"`
	Sig            uint64   `json:"sig"`
	Verdict        string   `json:"verdict"`
	Reason         string   `json:"reason"`
	ResultClass    string   `json:"result_class"`
	DiffCategories []string `json:"diff_categories"`
	UnstablePaths  []string `json:"unstable_paths"`
	ViewerUsed     string   `json:"viewer_used"`
	NodeStatus     uint16   `json:"node_status"`
	GoStatus       uint16   `json:"go_status"`
	NodeMS         float32  `json:"node_ms"`
	GoMS           float32  `json:"go_ms"`
	TS             string   `json:"ts"`
}

// RunRow is a `runs` row, written once when the run ends.
type RunRow struct {
	RunID      string `json:"run_id"`
	Phase      string `json:"phase"`
	NodeImage  string `json:"node_image"`
	GoImage    string `json:"go_image"`
	SnapshotID string `json:"snapshot_id"`
	CorpusFrom string `json:"corpus_from"`
	CorpusTo   string `json:"corpus_to"`
	Settings   string `json:"settings"`
	Started    string `json:"started"`
	Finished   string `json:"finished"`
}

// Store is where a run reads its cases and writes its rows.
type Store interface {
	// SelectCases is endpoint's cases for the run: one per signature (the exemplar the run's day
	// picks), signatures by traffic weight over [from, to), at most limit.
	SelectCases(ctx context.Context, endpoint string, from, to time.Time, day string, limit int) ([]Case, error)
	// AddResult and AddRun queue a row (false: not queued).
	AddResult(r ResultRow) bool
	AddRun(r RunRow) bool
	// Close flushes the queued rows.
	Close(ctx context.Context) error
}

// CHConfig is FEED_EVAL_CLICKHOUSE_URL (whose path names the database), _USER and _PASSWORD: a login
// that can SELECT cases, samples, runs and results and INSERT results and runs.
type CHConfig struct {
	URL, Username, Password string
	HTTP                    *http.Client
	// FlushInterval is the writers' (0: chwrite's default).
	FlushInterval time.Duration
}

// CHStore is the ClickHouse Store (and publish's reader).
type CHStore struct {
	read          *chread.Client
	results, runs *chwrite.Writer
	// addedResults and addedRuns count every row handed to Add (queued or not): Close compares them
	// with what ClickHouse acknowledged.
	addedResults, addedRuns atomic.Uint64
}

// NewCHReader is a read-only client over cfg.
func NewCHReader(cfg CHConfig) (*chread.Client, error) {
	if cfg.URL == "" || cfg.Username == "" || cfg.Password == "" {
		return nil, errors.New("FEED_EVAL_CLICKHOUSE_URL, _USER and _PASSWORD are all required")
	}
	u, err := url.Parse(cfg.URL)
	if err != nil {
		return nil, errors.New("eval clickhouse url: not a URL")
	}
	if strings.Trim(u.Path, "/") == "" {
		return nil, errors.New("eval clickhouse url: its path must name the database")
	}
	return chread.New(chread.Config{ //nolint:gosec // G101: CredentialEnv names variables, it holds no credential
		URL: cfg.URL, Username: cfg.Username, Password: cfg.Password, MaxInFlight: 2, HTTP: cfg.HTTP,
		CredentialEnv: "FEED_EVAL_CLICKHOUSE_USER / FEED_EVAL_CLICKHOUSE_PASSWORD",
	})
}

// NewCHStore is the reader and the two writers (results, runs). The writers' URL gets
// date_time_input_format=best_effort, so the RFC 3339 timestamps are read with their zone.
func NewCHStore(cfg CHConfig) (*CHStore, error) {
	read, err := NewCHReader(cfg)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(cfg.URL) // parsed above
	q := u.Query()
	q.Set("date_time_input_format", "best_effort")
	u.RawQuery = q.Encode()
	mk := func(table string) (*chwrite.Writer, error) {
		return chwrite.New(chwrite.Config{URL: u.String(), Username: cfg.Username, Password: cfg.Password, Table: table,
			MaxRetries: 2, HTTP: cfg.HTTP, FlushInterval: cfg.FlushInterval})
	}
	s := &CHStore{read: read}
	if s.results, err = mk(ResultsTable); err != nil {
		return nil, err
	}
	if s.runs, err = mk(RunsTable); err != nil {
		_ = s.results.Close(context.Background())
		return nil, err
	}
	return s, nil
}

// selectCasesSQL picks, per signature of one endpoint, a promoted case (origin prod-mismatch,
// pinned: what reconcile promotes for a blind spot, DESIGN.md §19.9) when the signature has one,
// and among those (or among all, when it has none) the case whose cityHash64(case_id, day) is least
// (ties by case_id): the exemplar rotates nightly and is the same for every run of one day, and a
// blind spot's next run replays a case production mismatched on. Every value is a query parameter,
// never text in the query.
const selectCasesSQL = `SELECT toString(tupleElement(c.pick, 1)) AS case_id, tupleElement(c.pick, 2) AS request,
  tupleElement(c.pick, 3) AS sig_text, toString(c.sig) AS sig, ifNull(s.w, 0) AS weight
FROM (
  SELECT sig, argMin((case_id, request, sig_text),
    (if(origin = {promoted:String} AND pinned = 1, 0, 1), cityHash64(case_id, {day:String}), case_id)) AS pick
  FROM cases FINAL
  WHERE endpoint = {endpoint:String}
  GROUP BY sig
) AS c
LEFT JOIN (
  SELECT sig, sum(weight) AS w
  FROM samples
  WHERE endpoint = {endpoint:String} AND ts >= {from:DateTime64(3, 'UTC')} AND ts < {to:DateTime64(3, 'UTC')}
  GROUP BY sig
) AS s ON c.sig = s.sig
ORDER BY weight DESC, c.sig ASC
LIMIT {limit:UInt32}`

// param is a ClickHouse query parameter setting.
func param(name, value string) chread.Setting {
	return chread.Setting{Name: "param_" + name, Value: value}
}

// SelectCases implements Store.
func (s *CHStore) SelectCases(ctx context.Context, endpoint string, from, to time.Time, day string, limit int) ([]Case, error) {
	rows, err := s.read.Query(ctx, selectCasesSQL, []chread.Setting{
		param("day", day), param("endpoint", endpoint), param("promoted", evalcapture.OriginMismatch),
		param("from", from.UTC().Format(CHTimeFormat)), param("to", to.UTC().Format(CHTimeFormat)),
		param("limit", strconv.Itoa(limit)),
	})
	if err != nil {
		return nil, err
	}
	out := make([]Case, 0, len(rows))
	for _, r := range rows {
		c, err := caseFromRow(endpoint, r)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func caseFromRow(endpoint string, r map[string]any) (Case, error) {
	id, err := strconv.ParseUint(str(r["case_id"]), 10, 64)
	if err != nil {
		return Case{}, errors.New("cases: case_id is not a UInt64")
	}
	sig, err := strconv.ParseUint(str(r["sig"]), 10, 64)
	if err != nil {
		return Case{}, errors.New("cases: sig is not a UInt64")
	}
	c := Case{ID: id, Endpoint: endpoint, Sig: sig, SigText: str(r["sig_text"]), Weight: num(r["weight"])}
	if err := json.Unmarshal([]byte(str(r["request"])), &c.Request); err != nil {
		// Not wrapped: the error could quote the stored request.
		return Case{}, fmt.Errorf("cases: case %s: request is not a stored request", HexID(id))
	}
	return c, nil
}

// str is a JSONEachRow string column ("" otherwise).
func str(v any) string {
	s, _ := v.(string)
	return s
}

// num is a JSONEachRow number column (0 otherwise).
func num(v any) float64 {
	switch t := v.(type) {
	case json.Number:
		f, _ := t.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

// AddResult implements Store.
func (s *CHStore) AddResult(r ResultRow) bool {
	s.addedResults.Add(1)
	return s.results.Add(r)
}

// AddRun implements Store.
func (s *CHStore) AddRun(r RunRow) bool {
	s.addedRuns.Add(1)
	return s.runs.Add(r)
}

// Close implements Store: results first, then the run row that summarises them. It is an error when
// ClickHouse did not acknowledge every row handed to Add (refused, failed after its retries, never
// queued, or cut by ctx), with the counts lost per table: a run whose rows were lost must not exit 0.
func (s *CHStore) Close(ctx context.Context) error {
	err := errors.Join(s.results.Close(ctx), s.runs.Close(ctx))
	lostResults := s.addedResults.Load() - min(s.addedResults.Load(), s.results.Sent())
	lostRuns := s.addedRuns.Load() - min(s.addedRuns.Load(), s.runs.Sent())
	if lostResults+lostRuns > 0 {
		err = errors.Join(err, fmt.Errorf("clickhouse: %d of %d results rows and %d of %d runs rows were not written",
			lostResults, s.addedResults.Load(), lostRuns, s.addedRuns.Load()))
	}
	return err
}

// Reader is the read client (publish's queries).
func (s *CHStore) Reader() *chread.Client { return s.read }

// rowTime is t as a row writes it (evalcapture.TimeFormat).
func rowTime(t time.Time) string { return t.UTC().Format(evalcapture.TimeFormat) }
