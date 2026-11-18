//go:build !unix

package server

import "time"

// processCPU is unavailable off unix: phase CPU is then not recorded (wall time still is).
func processCPU() (time.Duration, bool) { return 0, false }
