// Package fallback marks a request this service will not answer itself.
//
// The rule the whole service follows: answer only what can be answered exactly as the Node procedure
// would, and hand everything else back. A fallback is not an error — in serving mode the request is
// proxied to the Node app unchanged, in shadow mode it is counted as `unsupported` with its reason, so
// the fallback rate per reason is the measured list of what is left to port.
package fallback

import (
	"errors"
	"fmt"
)

// Error carries why a request falls back. Reason is a short, fixed label (it becomes a metric label).
type Error struct {
	Reason string
	Detail string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return "fallback: " + e.Reason
	}
	return fmt.Sprintf("fallback: %s (%s)", e.Reason, e.Detail)
}

// New returns a fallback error.
func New(reason string) error { return &Error{Reason: reason} }

// Newf returns a fallback error with detail (detail never becomes a label).
func Newf(reason, format string, args ...any) error {
	return &Error{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// Reason returns the fallback reason of err, or "" when err is not a fallback.
func Reason(err error) string {
	var fe *Error
	if errors.As(err, &fe) {
		return fe.Reason
	}
	return ""
}
