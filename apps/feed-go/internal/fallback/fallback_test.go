package fallback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
)

type pgErr struct{ code string }

func (e *pgErr) Error() string {
	return "ERROR: invalid input syntax for type integer: \"SENTINEL_USER_42\""
}
func (e *pgErr) SQLState() string { return e.code }

type redisErr struct{}

func (redisErr) Error() string { return "WRONGTYPE user:SENTINEL_USER_42" }
func (redisErr) RedisError()   {}

// The loggable detail is opt-in per call site: Newf's detail (request input, store errors) never
// reaches SafeDetail; Safef, NewfSafe and Wrap say what does. Error() keeps Newf's text in every case.
func TestSafeDetail(t *testing.T) {
	const sentinel = "SENTINEL_USER_42"
	for _, c := range []struct {
		name      string
		err       error
		wantError string
		wantSafe  string
	}{
		{"New", New("bulkhead"), "fallback: bulkhead", ""},
		{"Newf: never loggable", Newf("input-cursor", "%q", sentinel), `fallback: input-cursor ("SENTINEL_USER_42")`, ""},
		{"Safef", Safef("feed-status", "%d", 503), "fallback: feed-status (503)", "503"},
		{"NewfSafe: the field, not the value", NewfSafe("input-invalid", "limit", "limit: %v", sentinel),
			"fallback: input-invalid (limit: SENTINEL_USER_42)", "limit"},
		{"Wrap: the class, not the text", Wrap("feed-unavailable", errors.New("GET /feed?user="+sentinel)),
			"fallback: feed-unavailable (GET /feed?user=SENTINEL_USER_42)", "other"},
		{"Wrap nil", Wrap("feed-unavailable", nil), "fallback: feed-unavailable", ""},
		{"wrapped in another error", fmt.Errorf("outer: %w", Safef("deadline", "budget %v", "6s")),
			"outer: fallback: deadline (budget 6s)", "budget 6s"},
		{"not a fallback", errors.New(sentinel), sentinel, ""},
		{"a safe detail is still filtered", NewfSafe("input-unknown-key", "a@b.c d\nx", "%s", "k"),
			"fallback: input-unknown-key (k)", "a?b.c d?x"},
	} {
		if got := c.err.Error(); got != c.wantError {
			t.Errorf("%s: Error() = %q, want %q", c.name, got, c.wantError)
		}
		if got := SafeDetail(c.err); got != c.wantSafe {
			t.Errorf("%s: SafeDetail = %q, want %q", c.name, got, c.wantSafe)
		}
	}
}

func TestToken(t *testing.T) {
	long := "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"
	for in, want := range map[string]string{
		"collectionId":           "collectionId",
		"meta-select_2.x":        "meta-select_2.x",
		"jane.doe@mail.example":  "jane.doe?mail.example",
		"two words":              "two?words",
		"tab\there":              "tab?here",
		"ü":                      "??",
		long:                     long[:64],
		"":                       "",
		`"quoted":{json}`:        "?quoted???json?",
		"/path/../etc?x=1&y=2#f": "?path?..?etc?x?1?y?2?f",
	} {
		if got := Token(in); got != want {
			t.Errorf("Token(%q) = %q, want %q", in, got, want)
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestClassAndType(t *testing.T) {
	for _, c := range []struct {
		name      string
		err       error
		wantClass string
		wantType  string
	}{
		{"nil", nil, "", ""},
		{"deadline", fmt.Errorf("read: %w", context.DeadlineExceeded), "deadline", "context.deadlineExceededError"},
		{"canceled", context.Canceled, "canceled", "*errors.errorString"},
		{"postgres", fmt.Errorf("query: %w", &pgErr{code: "22P02"}), "pg_22", "*fallback.pgErr"},
		{"redis reply", redisErr{}, "redis_reply", "fallback.redisErr"},
		{"net timeout", &net.OpError{Op: "read", Err: timeoutErr{}}, "timeout", "fallback.timeoutErr"},
		{"net op", &net.OpError{Op: "dial", Err: os.ErrPermission}, "net_dial", "*errors.errorString"},
		{"eof", fmt.Errorf("body: %w", io.ErrUnexpectedEOF), "eof", "*errors.errorString"},
		{"other", errors.New("SENTINEL_USER_42"), "other", "*errors.errorString"},
	} {
		if got := Class(c.err); got != c.wantClass {
			t.Errorf("%s: Class = %q, want %q", c.name, got, c.wantClass)
		}
		if got := Type(c.err); got != c.wantType {
			t.Errorf("%s: Type = %q, want %q", c.name, got, c.wantType)
		}
	}
}

type statusErr struct{ status int }

func (e statusErr) Error() string {
	return "upstream answered " + strconv.Itoa(e.status) + " for SENTINEL_USER_42"
}
func (e statusErr) HTTPStatus() int { return e.status }

// classCases are errors of every kind this service meets, each with the class it must log as: the
// sentinel or kind, never the text. Shared by the closed-set test.
var classCases = []struct {
	name string
	err  error
	want string
}{
	{"deadline wrapped by pgconn", fmt.Errorf("timeout: %w", context.DeadlineExceeded), "deadline"},
	{"canceled", fmt.Errorf("x: %w", context.Canceled), "canceled"},
	{"pgx no rows", fmt.Errorf("scan: %w", pgx.ErrNoRows), "pg_no_rows"},
	{"pg connect", &pgconn.ConnectError{Config: &pgconn.Config{}}, "pg_connect"},
	{"pg data exception", &pgconn.PgError{Code: "22P02", Message: "invalid input: SENTINEL_USER_42"}, "pg_22"},
	{"pg query canceled", &pgconn.PgError{Code: "57014"}, "pg_57"},
	{"pg serialization", &pgconn.PgError{Code: "40001"}, "pg_40"},
	{"pg undefined column", &pgconn.PgError{Code: "42703"}, "pg_42"},
	{"pg too many connections", &pgconn.PgError{Code: "53300"}, "pg_53"},
	{"pg internal", &pgconn.PgError{Code: "XX000"}, "pg_XX"},
	{"pg unknown class", &pgconn.PgError{Code: "ZZ999"}, "pg_other"},
	{"pg empty code", &pgconn.PgError{}, "pg_other"},
	{"redis nil", fmt.Errorf("get: %w", redis.Nil), "redis_nil"},
	{"redis pool timeout", redis.ErrPoolTimeout, "redis_pool_timeout"},
	{"redis closed", redis.ErrClosed, "redis_closed"},
	{"redis server reply", redisErr{}, "redis_reply"},
	{"net read timeout", &net.OpError{Op: "read", Err: timeoutErr{}}, "timeout"},
	{"connection refused", &net.OpError{Op: "dial", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}, "conn_refused"},
	{"connection reset", &net.OpError{Op: "read", Err: &os.SyscallError{Syscall: "read", Err: syscall.ECONNRESET}}, "conn_reset"},
	{"dns", &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "SENTINEL_USER_42.example"}}, "dns"},
	{"net dial", &net.OpError{Op: "dial", Err: os.ErrPermission}, "net_dial"},
	{"net write", &net.OpError{Op: "write", Err: os.ErrPermission}, "net_write"},
	{"net other op", &net.OpError{Op: "listen", Err: os.ErrPermission}, "net_other"},
	{"clickhouse busy", fmt.Errorf("metrics: %w", chread.ErrBusy), "clickhouse_busy"},
	{"clickhouse 500", &chread.ServerError{Code: 241, Status: 500, Message: "SENTINEL_USER_42"}, "http_5xx"},
	{"upstream 404", statusErr{404}, "http_4xx"},
	{"upstream 503", fmt.Errorf("feed: %w", statusErr{503}), "http_5xx"},
	{"upstream 302", statusErr{302}, "http_other"},
	{"eof", io.EOF, "eof"},
	{"unexpected eof", fmt.Errorf("body: %w", io.ErrUnexpectedEOF), "eof"},
	{"json syntax", fmt.Errorf("decode: %w", &json.SyntaxError{}), "json"},
	{"json type", &json.UnmarshalTypeError{Value: "string"}, "json"},
	{"anything else", errors.New("SENTINEL_USER_42"), "other"},
}

// Class unwraps to the sentinel or kind specific enough to debug from: context deadline vs canceled,
// pgx no-rows vs a Postgres error's SQLSTATE CLASS (never the full code's detail), Redis miss vs pool
// timeout vs a server reply, the network failure, the upstream HTTP status class.
func TestClassIsSpecific(t *testing.T) {
	for _, c := range classCases {
		if got := Class(c.err); got != c.want {
			t.Errorf("%s: Class = %q, want %q", c.name, got, c.want)
		}
	}
}

// The class is a metric label (feed_go_errors_total{class}): the set is closed. ErrorClasses is
// pinned whole, every class Class returns is in it, and a SQLSTATE class outside Postgres' list maps to
// pg_other rather than minting a label.
func TestErrorClassesAreClosed(t *testing.T) {
	want := []string{
		"deadline", "canceled", "pg_no_rows", "pg_connect",
		"pg_00", "pg_01", "pg_02", "pg_03", "pg_08", "pg_09", "pg_0A", "pg_0B", "pg_0F", "pg_0L", "pg_0P", "pg_0Z",
		"pg_20", "pg_21", "pg_22", "pg_23", "pg_24", "pg_25", "pg_26", "pg_27", "pg_28", "pg_2B", "pg_2D", "pg_2F",
		"pg_34", "pg_38", "pg_39", "pg_3B", "pg_3D", "pg_3F", "pg_40", "pg_42", "pg_44", "pg_53", "pg_54", "pg_55",
		"pg_57", "pg_58", "pg_72", "pg_F0", "pg_HV", "pg_P0", "pg_XX", "pg_other",
		"redis_nil", "redis_pool_timeout", "redis_closed", "redis_reply",
		"timeout", "conn_refused", "conn_reset", "dns", "net_dial", "net_read", "net_write", "net_other",
		"clickhouse_busy", "http_4xx", "http_5xx", "http_other", "eof", "json", "other",
	}
	got := ErrorClasses()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ErrorClasses() =\n%v\nwant\n%v", got, want)
	}
	in := map[string]bool{}
	for _, c := range got {
		in[c] = true
	}
	for _, c := range classCases {
		if cl := Class(c.err); !in[cl] {
			t.Errorf("%s: Class %q is not in ErrorClasses", c.name, cl)
		}
	}
	for _, code := range []string{"", "2", "zz000", "99999", "0a000", "\x00\x01", "😀😀"} {
		if cl := Class(&pgconn.PgError{Code: code}); !in[cl] {
			t.Errorf("SQLSTATE %q: Class %q is not in ErrorClasses", code, cl)
		}
	}
}
