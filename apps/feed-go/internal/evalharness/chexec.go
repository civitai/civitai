package evalharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
)

// CHExec runs one write statement (an INSERT with a JSONEachRow body, or an INSERT … SELECT) as a
// POST and waits for ClickHouse's answer: what `reconcile` and `import-tempo` write is acknowledged
// or the command fails, with no queue in between (unlike the run's writers, chwrite).
type CHExec struct {
	endpoint   *url.URL
	user, pass string
	http       *http.Client
}

// NewCHExec is a write client over cfg (the same login and URL as NewCHStore's). Its URL gets
// date_time_input_format=best_effort, so RFC 3339 timestamps in a body are read with their zone.
func NewCHExec(cfg CHConfig) (*CHExec, error) {
	if cfg.URL == "" || cfg.Username == "" || cfg.Password == "" {
		return nil, errors.New("FEED_EVAL_CLICKHOUSE_URL, _USER and _PASSWORD are all required")
	}
	u, err := url.Parse(cfg.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("eval clickhouse url: not an http(s) URL")
	}
	db := strings.Trim(u.Path, "/")
	if db == "" {
		return nil, errors.New("eval clickhouse url: its path must name the database")
	}
	q := u.Query()
	q.Set("database", db)
	q.Set("date_time_input_format", "best_effort")
	u.Path = "/"
	u.RawQuery = q.Encode()
	hc := cfg.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	return &CHExec{endpoint: u, user: cfg.Username, pass: cfg.Password, http: hc}, nil
}

// maxExecErrorBody bounds how much of a refusal is read (and none of it is returned: it can quote a
// row of the body).
const maxExecErrorBody = 4 << 10

// Exec runs sql with settings (query parameters among them) and body (nil for none), and returns the
// rows ClickHouse reports written (X-ClickHouse-Summary's written_rows; 0 when it sends none). An
// answer other than 200 is an error naming the status and ClickHouse's exception code only: the
// message can quote the body, which holds stored requests.
func (e *CHExec) Exec(ctx context.Context, sql string, settings []chread.Setting, body []byte) (uint64, error) {
	u := *e.endpoint
	q := u.Query()
	for _, s := range settings {
		q.Set(s.Name, s.Value)
	}
	q.Set("query", strings.TrimRight(strings.TrimSpace(sql), ";"))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.SetBasicAuth(e.user, e.pass)
	resp, err := e.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("clickhouse: %w", redactURL(err))
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxExecErrorBody))
	if resp.StatusCode != http.StatusOK {
		code := resp.Header.Get("X-ClickHouse-Exception-Code")
		if _, err := strconv.Atoi(code); err != nil {
			code = "?"
		}
		return 0, fmt.Errorf("clickhouse: write refused: http %d, code %s", resp.StatusCode, code)
	}
	var sum struct {
		WrittenRows string `json:"written_rows"`
	}
	if h := resp.Header.Get("X-ClickHouse-Summary"); h != "" && json.Unmarshal([]byte(h), &sum) == nil {
		n, _ := strconv.ParseUint(sum.WrittenRows, 10, 64)
		return n, nil
	}
	return 0, nil
}

// jsonEachRow is rows as a JSONEachRow body.
func jsonEachRow[T any](rows []T) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	for _, r := range rows {
		if err := enc.Encode(r); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// insertCasesSQL is a `cases` insert of JSONEachRow rows (evalcapture.CaseRow).
const insertCasesSQL = `INSERT INTO cases FORMAT JSONEachRow`

// insertBatch bounds the rows of one insert.
const insertBatch = 500

// InsertCases writes rows to `cases`, insertBatch rows per insert, each acknowledged before the next,
// and returns the rows ClickHouse reported written. The first refusal ends it: the rows before it
// are written, the rest not.
func InsertCases(ctx context.Context, e *CHExec, rows []evalcapture.CaseRow) (uint64, error) {
	var written uint64
	for len(rows) > 0 {
		n := min(insertBatch, len(rows))
		body, err := jsonEachRow(rows[:n])
		if err != nil {
			return written, err
		}
		w, err := e.Exec(ctx, insertCasesSQL, nil, body)
		if err != nil {
			return written, err
		}
		written += w
		rows = rows[n:]
	}
	return written, nil
}
