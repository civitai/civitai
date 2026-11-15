package safe

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/sync/errgroup"
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

// A panic in an errgroup worker would otherwise kill the process: errgroup does not recover it.
func TestGoTurnsAWorkerPanicIntoTheGroupError(t *testing.T) {
	var g errgroup.Group
	g.Go(Go(func() error { return nil }))
	g.Go(Go(func() error { panic(fmt.Sprintf("worker %d", 2)) }))
	err := g.Wait()
	var pe *PanicError
	if !errors.As(fmt.Errorf("wrapped: %w", err), &pe) || pe.Value != "worker 2" {
		t.Fatalf("Wait = %v, want the worker's *PanicError (through wrapping)", err)
	}
}
