// Package fallback marks a request this service will not answer itself.
//
// The rule the whole service follows: answer only what can be answered exactly as the Node procedure
// would, and hand everything else back. A fallback is not an error — in serving mode the request is
// proxied to the Node app unchanged, in shadow mode it is counted as `unsupported` with its reason, so
// the fallback rate per reason is the measured list of what is left to port.
//
// A fallback carries two details. Detail is for Error() only: it may hold request input or a store
// error's text, so it is never logged or put on a span. Safe is the detail that may be (SafeDetail):
// empty unless the call site built the error with Safef, NewfSafe or Wrap, each of which states what
// goes into it — a field name, a count, a status code, an error class, an enum token.
package fallback

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

// Error carries why a request falls back. Reason is a short, fixed label (it becomes a metric label).
type Error struct {
	Reason string
	// Detail is Error()'s text only: never logged (it may carry request input or store errors).
	Detail string
	// Safe is the loggable detail (SafeDetail); "" = none.
	Safe string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return "fallback: " + e.Reason
	}
	return fmt.Sprintf("fallback: %s (%s)", e.Reason, e.Detail)
}

// New returns a fallback error.
func New(reason string) error { return &Error{Reason: reason} }

// Newf returns a fallback error with detail. The detail never becomes a label and is never logged:
// use Safef, NewfSafe or Wrap for one that may be.
func Newf(reason, format string, args ...any) error {
	return &Error{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// Safef is Newf whose detail is also loggable. Only for arguments that cannot carry user data: a count,
// a status code, a duration, a fixed field name, or a value already passed through Token.
func Safef(reason, format string, args ...any) error {
	d := fmt.Sprintf(format, args...)
	return &Error{Reason: reason, Detail: d, Safe: d}
}

// NewfSafe is Newf (the same Error() text) with a separate loggable detail, safe: a fixed field name
// or another value Safef would accept.
func NewfSafe(reason, safe, format string, args ...any) error {
	return &Error{Reason: reason, Detail: fmt.Sprintf(format, args...), Safe: safe}
}

// Wrap is Newf(reason, "%v", err) whose loggable detail is err's Class (never its text, which may name
// a key, a value or a query).
func Wrap(reason string, err error) error {
	if err == nil {
		return &Error{Reason: reason}
	}
	return &Error{Reason: reason, Detail: err.Error(), Safe: Class(err)}
}

// Reason returns the fallback reason of err, or "" when err is not a fallback.
func Reason(err error) string {
	var fe *Error
	if errors.As(err, &fe) {
		return fe.Reason
	}
	return ""
}

// maxSafe bounds a loggable detail.
const maxSafe = 64

// SafeDetail returns err's loggable detail ("" when it has none, or is not a fallback), passed through
// Token's character filter and bound to 64 bytes whatever the call site put in it.
func SafeDetail(err error) string {
	var fe *Error
	if !errors.As(err, &fe) || fe.Safe == "" {
		return ""
	}
	return filter(fe.Safe, " :/,")
}

// Token makes a client-sent token (an input key name, an enum value) loggable: every byte outside
// [A-Za-z0-9_.-] becomes '?', and it is cut to 64 bytes. A key name or enum value survives as sent;
// free text (an e-mail address, a sentence) does not.
func Token(s string) string { return filter(s, "") }

func filter(s, extra string) string {
	if len(s) > maxSafe {
		s = s[:maxSafe]
	}
	b := []byte(s)
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '.', c == '-':
		case strings.IndexByte(extra, c) >= 0:
		default:
			b[i] = '?'
		}
	}
	return string(b)
}

// Class names the kind of err without its text, for a log line or a span: deadline, canceled,
// timeout, eof, pg:<SQLSTATE>, redis, net:<op>, or other ("" for nil). The text of a store error can
// name a key or quote a value, so it is never what is logged.
func Class(err error) string {
	if err == nil {
		return ""
	}
	var (
		pg    interface{ SQLState() string }
		rerr  interface{ RedisError() }
		nerr  net.Error
		operr *net.OpError
	)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.As(err, &pg):
		return "pg:" + Token(pg.SQLState())
	case errors.As(err, &rerr):
		return "redis"
	case errors.As(err, &nerr) && nerr.Timeout():
		return "timeout"
	case errors.As(err, &operr):
		return "net:" + Token(operr.Op)
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	}
	return "other"
}

// Type is the Go type of the innermost error in err's chain (`%T`, e.g. `*pgconn.PgError`): a type
// name, never the text. "" for nil.
func Type(err error) string {
	if err == nil {
		return ""
	}
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return fmt.Sprintf("%T", err)
		}
		err = next
	}
}

// ErrorClasses: API STUB (the next commit implements it).
func ErrorClasses() []string { return nil }
