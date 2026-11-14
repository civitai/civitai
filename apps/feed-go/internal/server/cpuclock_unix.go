//go:build unix

package server

import (
	"syscall"
	"time"
)

// processCPU is the whole process's user+system CPU time so far (getrusage RUSAGE_SELF): every
// goroutine, the GC workers and the runtime, not only the calling goroutine.
func processCPU() (time.Duration, bool) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}
