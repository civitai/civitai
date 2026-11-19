// Package safe turns a panic into an error, so one bad request can never take the process down: the
// served path answers it with a fallback to the Node app, the shadow path counts it, and both record
// beacon_go_panics_total. (Copied from apps/feed-go/internal/safe, without its errgroup helper: this
// service starts no worker groups.)
//
// A recover only catches a panic on its own goroutine, so every goroutine this service starts for a
// request runs its body through Call.
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
