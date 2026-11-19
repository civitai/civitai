package safe

import (
	"errors"
	"strings"
	"testing"
)

func TestCallReturnsResultsWhenNothingPanics(t *testing.T) {
	want := errors.New("plain error")
	n, err := Call(func() (int, error) { return 7, want })
	if n != 7 || !errors.Is(err, want) {
		t.Fatalf("Call = %d, %v; want 7, %v", n, err, want)
	}
}

func TestCallTurnsAPanicIntoAPanicError(t *testing.T) {
	n, err := Call(func() (int, error) { panic("boom") })
	var pe *PanicError
	if !errors.As(err, &pe) {
		t.Fatalf("err = %v, want a *PanicError", err)
	}
	if n != 0 || pe.Value != "boom" || err.Error() != "panic: boom" {
		t.Fatalf("got n=%d value=%v msg=%q", n, pe.Value, err.Error())
	}
	if !strings.Contains(string(pe.Stack), "TestCallTurnsAPanicIntoAPanicError") {
		t.Fatalf("stack does not name the panicking test:\n%s", pe.Stack)
	}
}
