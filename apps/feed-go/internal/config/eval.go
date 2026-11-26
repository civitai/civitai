package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Eval is eval mode's settings (DESIGN.md §19.7): a pod the replay harness runs cases against, never
// one serving users.
type Eval struct {
	// Mode is FEED_GO_EVAL_MODE (default off). On, a request this service hands back is answered with
	// the hand-back stub (status 599, the fallback reason in a header) instead of being proxied to the
	// Node app, and the internal shadow and probe routes are not mounted.
	Mode bool
	// Now is FEED_GO_EVAL_NOW (RFC3339; zero: unset): the instant every answer is computed at
	// (clock.Freeze). Only with Mode.
	Now time.Time
}

// EvalConflicts are the switches eval mode refuses to start beside, by environment name: each one
// sends this pod's traffic, or a copy of it, to the Node app or to the eval corpus, and an eval pod
// must do neither (its answers are a replay's, not a user's). FEED_GO_SHADOW_WORKERS is the shadow's
// only switch on this side (the Node sampler decides what is sent); FEED_GO_EVAL_CAPTURE and
// FEED_GO_EVAL_CAPTURE_SERVE_RATE are the corpus capture's (§19.6).
var EvalConflicts = []string{
	"FEED_GO_SHADOW_WORKERS",
	"FEED_GO_SERVE_PARITY_SAMPLE_RATE",
	"FEED_GO_EVAL_CAPTURE",
	"FEED_GO_EVAL_CAPTURE_SERVE_RATE",
	// Write-back stamps a cache entry with the wall clock while an eval pod reads staleness on the
	// frozen one, and writes the caches other pods read: an eval pod writes no cache.
	"FEED_GO_CACHE_WRITEBACK",
}

// LoadEval reads the Eval settings through getenv (os.Getenv in Load). It refuses:
//   - a FEED_GO_EVAL_MODE that is neither on (true, 1, yes) nor off (unset, false, 0, no): a typo
//     must not leave a pod meant for evals proxying to the Node app, nor the reverse;
//   - eval mode with any EvalConflicts switch set to anything but an explicit off (evalSwitchOff);
//   - FEED_GO_EVAL_NOW without eval mode (a frozen clock on a serving pod would serve stale answers);
//   - a FEED_GO_EVAL_NOW that is not RFC3339.
func LoadEval(getenv func(string) string) (Eval, error) {
	var e Eval
	switch v := strings.ToLower(strings.TrimSpace(getenv("FEED_GO_EVAL_MODE"))); v {
	case "true", "1", "yes":
		e.Mode = true
	case "", "false", "0", "no":
	default:
		return Eval{}, fmt.Errorf("FEED_GO_EVAL_MODE=%q: want true or false", v)
	}
	if raw := strings.TrimSpace(getenv("FEED_GO_EVAL_NOW")); raw != "" {
		if !e.Mode {
			return Eval{}, errors.New("FEED_GO_EVAL_NOW is set without FEED_GO_EVAL_MODE: the clock is frozen only on an eval pod")
		}
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return Eval{}, fmt.Errorf("FEED_GO_EVAL_NOW=%q: want an RFC3339 instant", raw)
		}
		e.Now = t
	}
	if !e.Mode {
		return e, nil
	}
	var on []string
	for _, name := range EvalConflicts {
		if !evalSwitchOff(getenv(name)) {
			on = append(on, name)
		}
	}
	if len(on) > 0 {
		return Eval{}, fmt.Errorf("FEED_GO_EVAL_MODE is on with %s set: an eval pod never shadows, replays to the Node app or captures (set each unset or 0)",
			strings.Join(on, ", "))
	}
	return e, nil
}

// evalSwitchOff reports whether v leaves a switch off: unset, or an explicit off (false, no, off, or a
// number equal to 0). Anything else, junk included, counts as on: the refusal errs towards not
// starting.
func evalSwitchOff(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	switch v {
	case "", "false", "no", "off":
		return true
	}
	f, err := strconv.ParseFloat(v, 64)
	return err == nil && f == 0
}
