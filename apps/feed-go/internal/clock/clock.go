// Package clock is the instant an answer is computed at: the wall clock, unless eval mode froze it
// (FEED_GO_EVAL_NOW, DESIGN.md §19.7). Every read that changes WHAT an answer holds goes through
// Now: publish and schedule filters, cache-entry staleness, session-token and API-key expiry, the
// dated region rules. Reads that only measure or pace this process (a duration, a memo's TTL, a
// log line's rate limit, the search circuit, a write budget) stay on time.Now: freezing them would
// freeze the process, not the answer.
//
// The clock is frozen, not offset: a replayed case is answered at one fixed instant however long
// the run takes and whichever case runs first, so two runs of one corpus compute the same answers.
package clock

import (
	"sync/atomic"
	"time"
)

// frozen is the instant Now returns; nil: the wall clock.
var frozen atomic.Pointer[time.Time]

// Now is the frozen instant when Freeze set one, else time.Now().
func Now() time.Time {
	if t := frozen.Load(); t != nil {
		return *t
	}
	return time.Now()
}

// Freeze makes every later Now return t. Called once at startup, before anything is served (eval
// mode only); tests call it and undo it with Reset.
func Freeze(t time.Time) {
	frozen.Store(&t)
}

// Reset returns Now to the wall clock.
func Reset() {
	frozen.Store(nil)
}

// Frozen reports whether Now is frozen.
func Frozen() bool {
	return frozen.Load() != nil
}
