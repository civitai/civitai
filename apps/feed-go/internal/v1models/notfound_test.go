package v1models

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// A not-found `[id]` answer is Absent (the public route may write Node's 404) exactly when it is a
// public request with Config.AnswerNotFound, the model statement returned no row, and the model's lag
// flag reads clean. Each case below differs from the first in one of those, so each condition is the
// one deciding; the fixtures are Node's own 404s (detail-not-found*, expect.status), and the last is
// a found model, the control that a statement row is answered as before.
func TestServeDetailAbsentOnlyWhenTheStatementFindsNoRow(t *testing.T) {
	const lagKey = "lag-helper:model:5099"
	for _, c := range []struct {
		name       string
		fixture    string
		serving    bool
		on         bool
		setup      func(r *testkit.Redis)
		notFound   bool
		wantAbsent bool
	}{
		{"no statement row, public, switch on, flag clean", "detail-not-found.json", true, true, nil, true, true},
		{"switch off", "detail-not-found.json", true, false, nil, true, false},
		{"a shadow sample", "detail-not-found.json", false, true, nil, true, false},
		{"the lag flag set", "detail-not-found.json", true, true, func(r *testkit.Redis) { r.SetString(lagKey, []byte("1")) }, true, false},
		{"the lag flag unreadable", "detail-not-found.json", true, true, func(r *testkit.Redis) {
			r.KeyErr = func(key string) error {
				if key == lagKey {
					return errors.New("read failed")
				}
				return nil
			}
		}, true, false},
		{"a statement row dropped after the statement (no Published version)", "detail-not-found-no-published-version.json", true, true, nil, true, false},
		{"control: a found model", "detail-all-levels.json", true, true, nil, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			fx := goldenLoad(t, filepath.Join(goldenDir, c.fixture))
			env := goldenSetup(t, fx)
			env.deps.Config.AnswerNotFound = c.on
			if c.setup != nil {
				r, ok := env.deps.Sources.Packed.Redis.(*testkit.Redis)
				if !ok {
					t.Fatalf("the cache is a %T, not the test redis", env.deps.Sources.Packed.Redis)
				}
				c.setup(r)
			}
			ans, err := ServeDetail(context.Background(), env.deps, DetailRequest{
				ID: filepath.Base(fx.Request.Path), RegionRestricted: fx.Config.RegionRestricted, Serving: c.serving,
				Host: fx.Request.Headers["host"],
			})
			if err != nil {
				t.Fatalf("compute: %v (fallback reason %q)", err, fallback.Reason(err))
			}
			if ans.NotFound != c.notFound || ans.Absent != c.wantAbsent {
				t.Fatalf("NotFound=%v Absent=%v, want %v and %v", ans.NotFound, ans.Absent, c.notFound, c.wantAbsent)
			}
			if env.stmts != 1 {
				t.Fatalf("model statements: %d, want 1", env.stmts)
			}
		})
	}
}

// With no cache client for the lag flag (Sources without a packed reader) the flag cannot be read,
// so nothing is Absent.
func TestServeDetailAbsentNeedsALagFlagReader(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "detail-not-found.json"))
	env := goldenSetup(t, fx)
	env.deps.Config.AnswerNotFound = true
	noFlags := *env.deps.Sources
	noFlags.Packed = nil
	env.deps.Sources = &noFlags
	ans, err := ServeDetail(context.Background(), env.deps, DetailRequest{ID: "5099", Serving: true, Host: "site.example.test"})
	if err != nil {
		t.Fatalf("compute: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	if !ans.NotFound || ans.Absent {
		t.Fatalf("NotFound=%v Absent=%v, want true and false", ans.NotFound, ans.Absent)
	}
}
