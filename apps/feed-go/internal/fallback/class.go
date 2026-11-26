package fallback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"syscall"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
)

// pgStateClasses are Postgres' SQLSTATE classes (the first two characters of a code; PostgreSQL
// documentation, Appendix A), in that order. A code outside them is pg_other.
var pgStateClasses = []string{
	"00", "01", "02", "03", "08", "09", "0A", "0B", "0F", "0L", "0P", "0Z",
	"20", "21", "22", "23", "24", "25", "26", "27", "28", "2B", "2D", "2F",
	"34", "38", "39", "3B", "3D", "3F", "40", "42", "44", "53", "54", "55",
	"57", "58", "72", "F0", "HV", "P0", "XX",
}

var pgClassLabel = func() map[string]string {
	m := make(map[string]string, len(pgStateClasses))
	for _, c := range pgStateClasses {
		m[c] = "pg_" + c
	}
	return m
}()

// errorClasses is every value Class returns for a non-nil error, in a fixed order (ErrorClasses).
var errorClasses = func() []string {
	out := []string{"deadline", "canceled", "pg_no_rows", "pg_connect"}
	for _, c := range pgStateClasses {
		out = append(out, pgClassLabel[c])
	}
	return append(out, "pg_other",
		"redis_nil", "redis_pool_timeout", "redis_closed", "redis_reply",
		"timeout", "conn_refused", "conn_reset", "dns", "net_dial", "net_read", "net_write", "net_other",
		"clickhouse_busy", "http_4xx", "http_5xx", "http_other", "eof", "json", "other")
}()

// ErrorClasses is the closed set of Class values for a non-nil error (a copy): it is the `class`
// label of feed_go_errors_total.
func ErrorClasses() []string { return append([]string(nil), errorClasses...) }

// Class names the kind of err without its text, for a log line, a span status and the `class` label
// of feed_go_errors_total. It unwraps to the most specific sentinel or kind it knows, first match
// wins:
//
//   - deadline, canceled: context.DeadlineExceeded / Canceled anywhere in the chain;
//   - pg_no_rows (pgx.ErrNoRows), pg_connect (*pgconn.ConnectError), pg_<SQLSTATE class> (a
//     Postgres error's code, its two-character class only: pg_22 data exception, pg_40 rollback,
//     pg_57 operator intervention, ...), pg_other for a code outside Postgres' classes;
//   - redis_nil (a miss), redis_pool_timeout, redis_closed, redis_reply (any other server reply);
//   - timeout (a network timeout), conn_refused, conn_reset, dns, net_dial / net_read / net_write /
//     net_other (by the failed operation);
//   - clickhouse_busy (chread.ErrBusy); http_4xx / http_5xx / http_other (an error carrying an
//     upstream HTTP status: HTTPStatus() int, e.g. chread.ServerError);
//   - eof, json (a decode error), other.
//
// "" for nil. Never the error's text, a value or a key: the text of a store error can name a key or
// quote a value.
func Class(err error) string {
	if err == nil {
		return ""
	}
	var (
		connErr *pgconn.ConnectError
		pg      interface{ SQLState() string }
		reply   interface{ RedisError() }
		nerr    net.Error
		dnsErr  *net.DNSError
		opErr   *net.OpError
		status  interface{ HTTPStatus() int }
		syntax  *json.SyntaxError
		typeErr *json.UnmarshalTypeError
	)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, pgx.ErrNoRows):
		return "pg_no_rows"
	case errors.As(err, &connErr):
		return "pg_connect"
	case errors.As(err, &pg):
		return pgClass(pg.SQLState())
	case errors.Is(err, redis.Nil):
		return "redis_nil"
	case errors.Is(err, redis.ErrPoolTimeout):
		return "redis_pool_timeout"
	case errors.Is(err, redis.ErrClosed):
		return "redis_closed"
	case errors.As(err, &reply):
		return "redis_reply"
	case errors.As(err, &nerr) && nerr.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "conn_refused"
	case errors.Is(err, syscall.ECONNRESET):
		return "conn_reset"
	case errors.As(err, &dnsErr):
		return "dns"
	case errors.As(err, &opErr):
		switch opErr.Op {
		case "dial", "read", "write":
			return "net_" + opErr.Op
		}
		return "net_other"
	case errors.Is(err, chread.ErrBusy):
		return "clickhouse_busy"
	case errors.As(err, &status):
		switch s := status.HTTPStatus(); {
		case s >= 400 && s < 500:
			return "http_4xx"
		case s >= 500 && s < 600:
			return "http_5xx"
		}
		return "http_other"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	case errors.As(err, &syntax), errors.As(err, &typeErr):
		return "json"
	}
	return "other"
}

// pgClass is the label of a SQLSTATE code's class.
func pgClass(code string) string {
	if len(code) >= 2 {
		if l, ok := pgClassLabel[code[:2]]; ok {
			return l
		}
	}
	return "pg_other"
}
