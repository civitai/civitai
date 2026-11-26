package config

import (
	"strings"
	"testing"
	"time"
)

// envOf is a getenv over m.
func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadEvalDefaultsOff(t *testing.T) {
	e, err := LoadEval(envOf(nil))
	if err != nil || e.Mode || !e.Now.IsZero() {
		t.Fatalf("unset: %+v, %v; want off with no instant", e, err)
	}
	for _, v := range []string{"false", "0", "no", " FALSE "} {
		if e, err := LoadEval(envOf(map[string]string{"FEED_GO_EVAL_MODE": v})); err != nil || e.Mode {
			t.Errorf("FEED_GO_EVAL_MODE=%q: %+v, %v; want off", v, e, err)
		}
	}
}

// Production runs every conflicting switch on with eval mode off: none of them may refuse it.
func TestLoadEvalConflictsAreFineWithoutEvalMode(t *testing.T) {
	env := map[string]string{}
	for _, k := range EvalConflicts {
		env[k] = "1"
	}
	if e, err := LoadEval(envOf(env)); err != nil || e.Mode {
		t.Fatalf("eval mode off with every conflict on: %+v, %v; want off and no error", e, err)
	}
}

func TestLoadEvalModeOn(t *testing.T) {
	for _, v := range []string{"true", "1", "yes", "TRUE"} {
		e, err := LoadEval(envOf(map[string]string{"FEED_GO_EVAL_MODE": v}))
		if err != nil || !e.Mode || !e.Now.IsZero() {
			t.Errorf("FEED_GO_EVAL_MODE=%q: %+v, %v; want on, wall clock", v, e, err)
		}
	}
	e, err := LoadEval(envOf(map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_EVAL_NOW": "2025-03-04T05:06:07+02:00"}))
	want := time.Date(2025, 3, 4, 3, 6, 7, 0, time.UTC)
	if err != nil || !e.Mode || !e.Now.Equal(want) {
		t.Fatalf("with FEED_GO_EVAL_NOW: %+v, %v; want on at %v", e, err, want)
	}
	// An explicit off on every conflicting switch is fine.
	env := map[string]string{"FEED_GO_EVAL_MODE": "true"}
	offs := []string{"0", "false", "0.0", "off"}
	for i, k := range EvalConflicts {
		env[k] = offs[i%len(offs)]
	}
	if _, err := LoadEval(envOf(env)); err != nil {
		t.Fatalf("eval mode with every conflict explicitly off: %v", err)
	}
}

func TestLoadEvalRefusals(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{"mode typo", map[string]string{"FEED_GO_EVAL_MODE": "ture"}, `FEED_GO_EVAL_MODE="ture"`},
		{"now without mode", map[string]string{"FEED_GO_EVAL_NOW": "2025-03-04T05:06:07Z"}, "FEED_GO_EVAL_NOW is set without FEED_GO_EVAL_MODE"},
		{"now without mode, mode off", map[string]string{"FEED_GO_EVAL_MODE": "false", "FEED_GO_EVAL_NOW": "2025-03-04T05:06:07Z"}, "FEED_GO_EVAL_NOW is set without FEED_GO_EVAL_MODE"},
		{"now not RFC3339", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_EVAL_NOW": "2025-03-04 05:06:07"}, `FEED_GO_EVAL_NOW="2025-03-04 05:06:07": want an RFC3339 instant`},
		{"shadow workers", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_SHADOW_WORKERS": "8"}, "with FEED_GO_SHADOW_WORKERS set"},
		{"serve parity", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_SERVE_PARITY_SAMPLE_RATE": "0.005"}, "with FEED_GO_SERVE_PARITY_SAMPLE_RATE set"},
		{"eval capture", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_EVAL_CAPTURE": "true"}, "with FEED_GO_EVAL_CAPTURE set"},
		{"eval capture serve rate", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_EVAL_CAPTURE_SERVE_RATE": "0.01"}, "with FEED_GO_EVAL_CAPTURE_SERVE_RATE set"},
		{"junk counts as on", map[string]string{"FEED_GO_EVAL_MODE": "true", "FEED_GO_EVAL_CAPTURE": "maybe"}, "with FEED_GO_EVAL_CAPTURE set"},
		{"several, in list order", map[string]string{"FEED_GO_EVAL_MODE": "1", "FEED_GO_EVAL_CAPTURE": "1", "FEED_GO_SHADOW_WORKERS": "2"},
			"with FEED_GO_SHADOW_WORKERS, FEED_GO_EVAL_CAPTURE set: "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, err := LoadEval(envOf(tc.env))
			if err == nil {
				t.Fatalf("LoadEval = %+v, nil; want an error holding %q", e, tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q, want it to hold %q", err, tc.wantErr)
			}
		})
	}
}

// The conflict list is a contract: each name is a switch that sends traffic to the Node app or the
// corpus. A switch added there without a refusal here (or the reverse) fails.
func TestEvalConflictsLedger(t *testing.T) {
	want := []string{"FEED_GO_SHADOW_WORKERS", "FEED_GO_SERVE_PARITY_SAMPLE_RATE", "FEED_GO_EVAL_CAPTURE", "FEED_GO_EVAL_CAPTURE_SERVE_RATE"}
	if strings.Join(EvalConflicts, ",") != strings.Join(want, ",") {
		t.Fatalf("EvalConflicts = %v, want %v", EvalConflicts, want)
	}
}

// Load reads it: a refusal fails startup, and the settings reach Config.
func TestLoadReadsEval(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	t.Setenv("FEED_GO_EVAL_MODE", "")
	t.Setenv("FEED_GO_EVAL_NOW", "2025-03-04T05:06:07Z")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "FEED_GO_EVAL_NOW is set without FEED_GO_EVAL_MODE") {
		t.Fatalf("Load with FEED_GO_EVAL_NOW alone: %v, want the refusal", err)
	}
	t.Setenv("FEED_GO_EVAL_MODE", "true")
	t.Setenv("FEED_GO_SERVE_PARITY_SAMPLE_RATE", "0.005")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "FEED_GO_SERVE_PARITY_SAMPLE_RATE") {
		t.Fatalf("Load in eval mode with serve parity: %v, want the refusal", err)
	}
	t.Setenv("FEED_GO_SERVE_PARITY_SAMPLE_RATE", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.Eval.Mode || !c.Eval.Now.Equal(time.Date(2025, 3, 4, 5, 6, 7, 0, time.UTC)) {
		t.Fatalf("Load: Eval = %+v, want on at 2025-03-04T05:06:07Z", c.Eval)
	}
}
