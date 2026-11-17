package chread

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorded is one request the fake server saw.
type recorded struct {
	method string
	path   string
	query  url.Values
	user   string
	pass   string
}

// fakeServer answers every request with handler, recording it.
func fakeServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, func() []recorded) {
	t.Helper()
	var mu sync.Mutex
	var seen []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, _ := r.BasicAuth()
		mu.Lock()
		seen = append(seen, recorded{r.Method, r.URL.Path, r.URL.Query(), u, p})
		mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []recorded {
		mu.Lock()
		defer mu.Unlock()
		return append([]recorded(nil), seen...)
	}
}

// The request is a GET (ClickHouse runs a GET read-only), with basic auth, the query text as
// @clickhouse/client sends it, Node's client setting for 64-bit integers, then the per-query settings;
// a URL path names the database. Rows come back as maps with json.Number numbers.
func TestQueryRequestAndRows(t *testing.T) {
	srv, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{\"entityId\":8001,\"metricType\":\"Like\",\"value\":5}\n\n{\"entityId\":8002,\"metricType\":\"Cry\",\"value\":12345678901}\n"))
	})
	c, err := New(Config{URL: srv.URL + "/metricsdb?application=feed-go", Username: "reader", Password: "pw", MaxInFlight: 1, HTTP: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := c.Query(context.Background(), "\n  SELECT 1;;\n  ", []Setting{{"max_threads", "1"}, {"max_execution_time", "6"}})
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{
		{"entityId": json.Number("8001"), "metricType": "Like", "value": json.Number("5")},
		{"entityId": json.Number("8002"), "metricType": "Cry", "value": json.Number("12345678901")},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %#v, want %#v", rows, want)
	}
	reqs := seen()
	if len(reqs) != 1 {
		t.Fatalf("%d requests, want 1", len(reqs))
	}
	r := reqs[0]
	if r.method != http.MethodGet || r.path != "/" || r.user != "reader" || r.pass != "pw" {
		t.Fatalf("request %s %s as %q/%q, want GET / as reader/pw", r.method, r.path, r.user, r.pass)
	}
	wantQ := url.Values{
		"query":       {"SELECT 1 \nFORMAT JSONEachRow"},
		"database":    {"metricsdb"},
		"application": {"feed-go"},
		"output_format_json_quote_64bit_integers":      {"0"},
		"cancel_http_readonly_queries_on_client_close": {"1"},
		"max_threads":        {"1"},
		"max_execution_time": {"6"},
	}
	if !reflect.DeepEqual(r.query, wantQ) {
		t.Fatalf("query parameters %v, want %v", r.query, wantQ)
	}
}

// WireQuery is formatQuery: trim, drop every trailing semicolon, append the format.
func TestWireQuery(t *testing.T) {
	for in, want := range map[string]string{
		"SELECT 1":            "SELECT 1 \nFORMAT JSONEachRow",
		"\n  SELECT 1;\n    ": "SELECT 1 \nFORMAT JSONEachRow",
		"SELECT ';' ;;":       "SELECT ';'  \nFORMAT JSONEachRow",
	} {
		if got := WireQuery(in); got != want {
			t.Errorf("WireQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

// A failed response is a ServerError carrying ClickHouse's code: from the exception header, else
// from the body's "Code: N." text; IsServerTimeout is code 159 only. An exception written into a
// started response (a 200 whose query then failed) is one too, in each shape ClickHouse writes it:
//   - JSONEachRow's own exception row (http_write_exception_in_output_format, on by default), as
//     JSONEachRowRowOutputFormat::writeSuffix writes it;
//   - the marker block of WriteBufferFromHTTPServerResponse::cancelWithException when the format did
//     not write it: through 25.10 "__exception__\r\n<message>\n"; from 25.11 a 16-letter tag (also
//     sent as X-ClickHouse-Exception-Tag) on its own line after the marker, and the block closed by
//     "<length> <tag>\r\n__exception__\r\n" (the server then breaks the chunked stream).
//
// A tag on the marker's own line is not a shape any release writes; it is decoded the same way.
func TestServerErrors(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		header  string
		body    string
		code    int
		timeout bool
	}{
		{"header", 500, "159", "Code: 159. DB::Exception: Timeout exceeded: elapsed 6.0 seconds", 159, true},
		{"body only", 500, "", "Code: 202. DB::Exception: Too many simultaneous queries", 202, false},
		{"auth", 403, "516", "Code: 516. DB::Exception: default: Authentication failed", 516, false},
		{"no code", 502, "", "bad gateway", 0, false},
		{"mid-stream", 200, "", "{\"entityId\":1,\"metricType\":\"Like\",\"value\":1}\nCode: 159. DB::Exception: Timeout exceeded", 159, true},
		{"mid-stream marker, 25.8", 200, "", "{\"x\":1}\n__exception__\r\nCode: 159. DB::Exception: Timeout exceeded: elapsed 1.000 sec., maximum: 1. (TIMEOUT_EXCEEDED) (version 25.8.9.20 (official build))\n", 159, true},
		{"mid-stream marker, 25.11 tag on its own line", 200, "", "{\"x\":1}\n\r\n__exception__\r\nqwertyuiopasdfgh\r\nCode: 159. DB::Exception: Timeout exceeded: elapsed 1.000 sec., maximum: 1. (TIMEOUT_EXCEEDED) (version 25.11.9.34 (official build))\n116 qwertyuiopasdfgh\r\n__exception__\r\n", 159, true},
		{"mid-stream marker, tag on the marker line", 200, "", "{\"x\":1}\n__exception__ qwertyuiopasdfgh\r\nCode: 159. DB::Exception: Timeout exceeded\n", 159, true},
		{"mid-stream marker, 25.11, not a timeout", 200, "", "{\"x\":1}\n\r\n__exception__\r\nzxcvbnmlkjhgfdsa\r\nCode: 241. DB::Exception: Memory limit exceeded\n47 zxcvbnmlkjhgfdsa\r\n__exception__\r\n", 241, false},
		{"exception row, timeout", 200, "", "{\"x\":1}\n{\"exception\":\"Code: 159. DB::Exception: Timeout exceeded: elapsed 1.000 sec., maximum: 1. (TIMEOUT_EXCEEDED) (version 25.8.9.20 (official build))\"}\n", 159, true},
		{"exception object", 200, "", "{\"x\":1}\n{\"exception\":\"Code: 202. DB::Exception: Too many simultaneous queries\"}\n", 202, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
				if tc.header != "" {
					w.Header().Set("X-ClickHouse-Exception-Code", tc.header)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			c, err := New(Config{URL: srv.URL, HTTP: srv.Client()})
			if err != nil {
				t.Fatal(err)
			}
			_, err = c.Query(context.Background(), "SELECT 1", nil)
			var se *ServerError
			if !errors.As(err, &se) || se.Code != tc.code || se.Status != tc.status {
				t.Fatalf("err %v, want a ServerError code %d status %d", err, tc.code, tc.status)
			}
			// The message is the exception text, without the marker block's tag or trailer.
			if tc.code != 0 && (!strings.HasPrefix(se.Message, "Code: ") || strings.Contains(se.Message, "__exception__") ||
				strings.Contains(se.Message, "qwertyuiopasdfgh") || strings.Contains(se.Message, "zxcvbnmlkjhgfdsa")) {
				t.Fatalf("message %q, want the exception text alone", se.Message)
			}
			if IsServerTimeout(err) != tc.timeout {
				t.Fatalf("IsServerTimeout = %v, want %v", IsServerTimeout(err), tc.timeout)
			}
		})
	}
	if IsServerTimeout(errors.New("Code: 159")) {
		t.Fatal("a plain error is not a server timeout")
	}
}

// A malformed row fails the read.
func TestMalformedRow(t *testing.T) {
	for _, body := range []string{"{\"a\":1}{\"b\":2}\n", "{\"a\":\n"} {
		srv, _ := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
		c, _ := New(Config{URL: srv.URL, HTTP: srv.Client()})
		if rows, err := c.Query(context.Background(), "SELECT 1", nil); err == nil {
			t.Fatalf("%q: rows %v, want an error", body, rows)
		}
	}
}

// MaxInFlight reads at once: one more is refused at once with ErrBusy (no request sent), and a slot
// frees when its read returns.
func TestBulkhead(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	var mu sync.Mutex
	reqs := 0
	srv, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		reqs++
		hold := reqs <= 2
		mu.Unlock()
		// Only the first two reads are held, so a read the cap fails to refuse answers (and the test
		// fails on its own assertion) instead of hanging.
		if hold {
			entered <- struct{}{}
			<-release
		}
		_, _ = w.Write([]byte("{\"x\":1}\n"))
	})
	c, _ := New(Config{URL: srv.URL, MaxInFlight: 2, HTTP: srv.Client()})
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := c.Query(context.Background(), "SELECT 1", nil)
			errs <- err
		}()
	}
	<-entered
	<-entered
	if _, err := c.Query(context.Background(), "SELECT 1", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("third read: %v, want ErrBusy", err)
	}
	if n := len(seen()); n != 2 {
		t.Fatalf("%d requests sent, want 2 (the refused read sends none)", n)
	}
	close(release)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Query(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatalf("after the slots freed: %v", err)
	}
}

// The context bounds the read; the transport error does not carry the request URL (it holds the query).
func TestContextBoundsTheRead(t *testing.T) {
	srv, _ := fakeServer(t, func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	c, _ := New(Config{URL: srv.URL, HTTP: srv.Client()})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := c.Query(ctx, "SELECT secret_column", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err %v, want the deadline", err)
	}
	if strings.Contains(err.Error(), "secret_column") || strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("err %q carries the request URL", err)
	}
}

// New refuses what it cannot send: a relative or non-http URL, credentials in the URL. MaxInFlight
// below 1 is 1.
func TestNew(t *testing.T) {
	for _, bad := range []string{"", "ch.example.test", "ftp://ch.example.test", "https://u:p@ch.example.test", "http://%zz"} {
		if _, err := New(Config{URL: bad}); err == nil {
			t.Errorf("New(%q) accepted", bad)
		}
	}
	c, err := New(Config{URL: "https://ch.example.test:8443", MaxInFlight: 0})
	if err != nil || cap(c.slots) != 1 {
		t.Fatalf("MaxInFlight 0: %v, %d slots; want 1", err, cap(c.slots))
	}
}
