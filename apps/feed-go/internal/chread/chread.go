// Package chread is a read-only ClickHouse client over the HTTP interface: the one query shape this
// service sends (a SELECT answered as JSONEachRow), with a per-pod cap on concurrent reads.
//
// It is the standard library on purpose, not a driver: the Node app reads ClickHouse through
// @clickhouse/client, which is this same HTTP interface with the same output format, so the wire is
// reproduced exactly (the query text Node's client sends, JSONEachRow with
// output_format_json_quote_64bit_integers=0, the same per-query settings) with no dependency to
// vet or keep tidy. One setting is this client's own: cancel_http_readonly_queries_on_client_close=1
// (Query says why).
//
// Read-only by construction: every query is a GET, and ClickHouse runs a GET with `readonly` set
// (a statement that writes or changes the schema is refused, code 164), whatever the account's
// own grants are.
package chread

import (
	"bufio"
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
)

// Config is where and how to read.
type Config struct {
	// URL is FEED_GO_CLICKHOUSE_HOST: the HTTP(S) endpoint, e.g. https://host:8443. A path names the
	// database, as @clickhouse/client reads it; query parameters in it are sent with every query.
	URL string
	// Username and Password are FEED_GO_CLICKHOUSE_USERNAME / FEED_GO_CLICKHOUSE_PASSWORD (HTTP basic
	// auth): a dedicated SELECT-only login.
	Username, Password string
	// MaxInFlight caps the reads one process sends at once (at least 1). A read past it is refused
	// at once with ErrBusy: the caller falls back rather than queue behind a slow server.
	MaxInFlight int
	// HTTP is the client (nil: a dedicated one). Request deadlines come from the caller's context.
	HTTP *http.Client
	// CredentialEnv names, in New's error for a URL carrying credentials, the variables the login
	// belongs in ("": "FEED_GO_CLICKHOUSE_USERNAME / FEED_GO_CLICKHOUSE_PASSWORD", this reader's own).
	CredentialEnv string
	// Tracer observes every query (nil: none, and Query does no tracing work at all).
	// tracing.ClickHouseTracer is the one this service sets when tracing is on.
	Tracer Tracer
}

// Tracer observes one query, as pgx's QueryTracer does: QueryStart is called before anything else
// (the read slot included) and returns the context the query runs on; QueryEnd is called with that
// context, the number of rows returned and the query's error once it has finished.
type Tracer interface {
	QueryStart(ctx context.Context, sql string) context.Context
	QueryEnd(ctx context.Context, rows int, err error)
}

// Client sends read-only queries. Safe for concurrent use.
type Client struct {
	endpoint *url.URL
	user     string
	pass     string
	http     *http.Client
	slots    chan struct{}
	tracer   Tracer
}

// ErrBusy is a read refused because MaxInFlight reads are already running.
var ErrBusy = errors.New("clickhouse: every read slot is in use")

// ServerError is an error ClickHouse answered with: its exception code (0 when it sent none) and
// message.
type ServerError struct {
	Code    int
	Status  int
	Message string
}

func (e *ServerError) Error() string {
	return fmt.Sprintf("clickhouse: code %d (http %d): %s", e.Code, e.Status, e.Message)
}

// HTTPStatus is the response's HTTP status (fallback.Class reads it as http_4xx / http_5xx).
func (e *ServerError) HTTPStatus() int { return e.Status }

// IsServerTimeout is whether err is ClickHouse's TIMEOUT_EXCEEDED (code 159): the server stopped the
// query at its max_execution_time.
func IsServerTimeout(err error) bool {
	var se *ServerError
	return errors.As(err, &se) && se.Code == 159
}

// New validates cfg. The URL must be absolute http or https; credentials in it are refused (they
// would be sent and logged with every request URL), use Username and Password.
func New(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil {
		// Not wrapped: url.Parse's error repeats the URL.
		return nil, errors.New("clickhouse url: not a URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("clickhouse url: want an absolute http(s) URL")
	}
	if u.User != nil {
		env := cfg.CredentialEnv
		if env == "" {
			env = "FEED_GO_CLICKHOUSE_USERNAME / FEED_GO_CLICKHOUSE_PASSWORD"
		}
		return nil, errors.New("clickhouse url: credentials belong in " + env)
	}
	n := cfg.MaxInFlight
	if n < 1 {
		n = 1
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	return &Client{endpoint: u, user: cfg.Username, pass: cfg.Password, http: hc, slots: make(chan struct{}, n),
		tracer: cfg.Tracer}, nil
}

// Setting is one ClickHouse setting sent with a query, in order.
type Setting struct{ Name, Value string }

// WireQuery is the query text @clickhouse/client sends for a JSONEachRow query (formatQuery in its
// dist/common/client.js): trimmed, trailing semicolons dropped, then " \nFORMAT JSONEachRow".
func WireQuery(sql string) string {
	return strings.TrimRight(strings.TrimSpace(sql), ";") + " \nFORMAT JSONEachRow"
}

// maxErrorBody bounds how much of an error response is read.
const maxErrorBody = 4 << 10

// Query runs sql (without a FORMAT clause) with settings, as a GET, and returns its rows, each a
// column-name map whose numbers are json.Number. It holds one read slot until the response is
// read; ctx bounds the whole read. A Config.Tracer sees the whole call, a refused one (ErrBusy)
// included.
func (c *Client) Query(ctx context.Context, sql string, settings []Setting) ([]map[string]any, error) {
	if c.tracer == nil {
		return c.query(ctx, sql, settings)
	}
	ctx = c.tracer.QueryStart(ctx, sql)
	rows, err := c.query(ctx, sql, settings)
	c.tracer.QueryEnd(ctx, len(rows), err)
	return rows, err
}

func (c *Client) query(ctx context.Context, sql string, settings []Setting) ([]map[string]any, error) {
	select {
	case c.slots <- struct{}{}:
	default:
		return nil, ErrBusy
	}
	defer func() { <-c.slots }()

	u := *c.endpoint
	q := u.Query()
	if db := strings.Trim(u.Path, "/"); db != "" {
		q.Set("database", db)
	}
	u.Path = "/"
	q.Set("output_format_json_quote_64bit_integers", "0")
	// Without it ClickHouse keeps running a read after the client closes the connection, holding a
	// query slot until max_execution_time (or indefinitely under the retry settings). A GET runs
	// read-only mode 2, which allows setting it. Safe to cancel here because the only read that fills
	// the cache (hydrate.populateDetached, write-back on) runs on a context detached from the request.
	q.Set("cancel_http_readonly_queries_on_client_close", "1")
	for _, s := range settings {
		q.Set(s.Name, s.Value)
	}
	q.Set("query", WireQuery(sql))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	if c.user != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clickhouse: %w", redact(err))
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, serverError(resp.StatusCode, resp.Header.Get("X-ClickHouse-Exception-Code"), string(body))
	}
	return decodeRows(resp.Body, resp.Header.Get("X-ClickHouse-Exception-Tag"))
}

// redact drops the request URL (it carries the query) from a transport error.
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// serverError builds the error of a failed response: the code from the exception header, else from
// the body's leading "Code: N." (both are what ClickHouse sends).
func serverError(status int, header, body string) *ServerError {
	msg := strings.TrimSpace(body)
	code, _ := strconv.Atoi(strings.TrimSpace(header))
	if code == 0 {
		code = bodyCode(msg)
	}
	return &ServerError{Code: code, Status: status, Message: msg}
}

// bodyCode is N of a "Code: N. ..." exception text (0 for any other text).
func bodyCode(s string) int {
	rest, ok := strings.CutPrefix(s, "Code: ")
	if !ok {
		return 0
	}
	end := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' })
	if end <= 0 {
		return 0
	}
	n, _ := strconv.Atoi(rest[:end])
	return n
}

// exceptionText is s from its "Code: " on (an exception line may carry a tag or prefix before it).
func exceptionText(s string) string {
	if i := strings.Index(s, "Code: "); i > 0 {
		return s[i:]
	}
	return s
}

// maxRowLine bounds one JSONEachRow line.
const maxRowLine = 1 << 20

// exceptionMarker opens (and from 25.11 closes) the block ClickHouse writes into a response it had
// already started when the query then fails and the output format did not write the exception
// itself (WriteBufferFromHTTPServerResponse::cancelWithException).
const exceptionMarker = "__exception__"

// decodeRows reads JSONEachRow: one JSON object per line. A failure ClickHouse writes into a response
// it had already started (a 200 whose query then failed) is returned as a ServerError, in each shape
// it is written:
//   - the format's own exception row, {"exception": "Code: N. ..."} (http_write_exception_in_output_format,
//     on by default, JSONEachRow supports it);
//   - the marker block. Through 25.10: "__exception__\r\n<message>\n". From 25.11:
//     "\r\n__exception__\r\n<tag>\r\n<message>\n<length> <tag>\r\n__exception__\r\n", the tag 16
//     random letters, also sent as the X-ClickHouse-Exception-Tag header (tag, "" when absent). A tag
//     on the marker's own line is read the same way;
//   - a bare "Code: N. ..." line.
//
// After the marker the server breaks the chunked stream, so the read error that follows is expected
// and ignored: the block is the answer.
func decodeRows(r io.Reader, tag string) ([]map[string]any, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxRowLine)
	var rows []map[string]any
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		if rest, ok := bytes.CutPrefix(line, []byte(exceptionMarker)); ok {
			if t := strings.TrimSpace(string(rest)); tag == "" && t != "" {
				tag = t
			}
			return nil, exceptionBlock(sc, tag)
		}
		if line[0] != '{' {
			return nil, serverError(http.StatusOK, "", exceptionText(string(line)))
		}
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		var row map[string]any
		if err := dec.Decode(&row); err != nil {
			return nil, fmt.Errorf("clickhouse: row: %w", err)
		}
		if dec.More() {
			return nil, errors.New("clickhouse: row: trailing data")
		}
		// A JSON format's own exception object (http_write_exception_in_output_format).
		if msg, ok := row["exception"].(string); ok && len(row) == 1 {
			return nil, serverError(http.StatusOK, "", exceptionText(msg))
		}
		rows = append(rows, row)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("clickhouse: response: %w", err)
	}
	return rows, nil
}

// exceptionBlock reads the rest of a marker block (the lines after the opening marker) as the
// ServerError it reports: the message is the text from its "Code: " on, without the tag line and the
// closing "<length> <tag>" / marker lines.
func exceptionBlock(sc *bufio.Scanner, tag string) *ServerError {
	var msg []string
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == exceptionMarker {
			break
		}
		if line == "" || (tag != "" && (line == tag || strings.HasSuffix(line, " "+tag))) {
			continue
		}
		if len(msg) == 0 && !strings.Contains(line, "Code: ") {
			// Before the message: the tag line, when the header did not name it. Taken as the tag so
			// the closing "<length> <tag>" line is dropped too.
			if tag == "" && !strings.ContainsRune(line, ' ') {
				tag = line
			}
			continue
		}
		msg = append(msg, line)
	}
	return serverError(http.StatusOK, "", exceptionText(strings.Join(msg, "\n")))
}
