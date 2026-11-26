// Package safe turns a panic into an error, so one bad request can never take the process down: the
// served path answers it with a fallback, the shadow path counts it, and both record
// feed_go_panics_total.
//
// A recover only catches a panic on its own goroutine. Every goroutine a request starts (an errgroup's
// workers) runs its body through Go, and the request's own goroutine through Call, so a panic anywhere
// in a computation surfaces as a *PanicError from Call or from the group's Wait.
package safe

import (
	"fmt"
	"runtime/debug"
)

// PanicError is a recovered panic: its value and the stack of the goroutine that panicked.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("panic: %v", e.Value) }

// Call runs fn and returns its results, or a *PanicError if it panicked.
func Call[T any](fn func() (T, error)) (out T, err error) {
	defer func() {
		if p := recover(); p != nil {
			var zero T
			out, err = zero, &PanicError{Value: p, Stack: debug.Stack()}
		}
	}()
	return fn()
}

// Go wraps an errgroup worker: a panic in fn becomes its *PanicError result.
func Go(fn func() error) func() error {
	return func() (err error) {
		defer func() {
			if p := recover(); p != nil {
				err = &PanicError{Value: p, Stack: debug.Stack()}
			}
		}()
		return fn()
	}
}
