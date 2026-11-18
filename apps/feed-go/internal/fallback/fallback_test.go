package fallback

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
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
		{"postgres", fmt.Errorf("query: %w", &pgErr{code: "22P02"}), "pg:22P02", "*fallback.pgErr"},
		{"redis", redisErr{}, "redis", "fallback.redisErr"},
		{"net timeout", &net.OpError{Op: "read", Err: timeoutErr{}}, "timeout", "fallback.timeoutErr"},
		{"net op", &net.OpError{Op: "dial", Err: os.ErrPermission}, "net:dial", "*errors.errorString"},
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
