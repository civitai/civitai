package v1models

import (
	"context"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// failKey fails exactly key's cache commands (testWorld.failKey), edit (if any) applied first.
func failKey(key string, edit ...func(*testWorld)) func(*testWorld) {
	return func(w *testWorld) {
		for _, e := range edit {
			e(w)
		}
		w.failKey = key
	}
}

// A cache GET that FAILS on either REST models route hands back with that cache's own
// `-read-failed` reason, never the `-miss` a content miss gives: the canary's fallback-delta drops
// the content reasons (sticky clients skew them), and a read failure is a regression it must count.
// Each failure case is paired with its content control: the same entry absent, no read failing.
func TestServeReadFailureIsNotAContentMiss(t *testing.T) {
	hideBuzz := func(w *testWorld) { w.entries[KeyMetricPrivacy+":1001"] = meta("hideModelBuzz", true) }
	absent := func(key string) func(*testWorld) { return func(w *testWorld) { w.entries[key] = nil } }
	for _, c := range []struct {
		name   string
		edit   func(*testWorld)
		reason string
	}{
		{"model data: GET fails", failKey(KeyDataForModel + ":5001"), "v1-models-data-read-failed"},
		{"model data: absent", absent(KeyDataForModel + ":5001"), "v1-models-data-miss"},
		{"model tags: GET fails", failKey(KeyModelTags + ":5001"), "v1-models-tags-read-failed"},
		{"model tags: absent", absent(KeyModelTags + ":5001"), "v1-models-tags-miss"},
		{"tag name: GET fails", failKey(KeyBasicTags + ":11"), "v1-models-tag-name-read-failed"},
		{"tag name: absent", absent(KeyBasicTags + ":11"), "v1-models-tag-name-miss"},
		{"files: GET fails", failKey(KeyFilesForVersion + ":6001"), "v1-models-files-read-failed"},
		{"files: absent", absent(KeyFilesForVersion + ":6001"), "v1-models-files-miss"},
		{"membership: GET fails", failKey(KeyMembershipValid+":1001", hideBuzz), "v1-models-membership-read-failed"},
		{"membership: absent", hideBuzz, "v1-models-membership-miss"},
	} {
		_, _, dErr, lErr := serveBoth(t, c.edit, nil)
		if reason(dErr) != c.reason || reason(lErr) != c.reason {
			t.Errorf("%s: detail %q (%v), list %q (%v), want %q", c.name, reason(dErr), dErr, reason(lErr), lErr, c.reason)
		}
	}
}

// serveListWith is serveDataMissList (a public list request, FEED_GO_V1_MODELS_SERVE_DATA_MISS and
// FEED_GO_COMPUTE_MISSES on).
func serveListWith(t *testing.T, w *testWorld) (*Answer, int, error) {
	t.Helper()
	d := w.deps(t)
	reads := 0
	d.Sources.Replica = &testkit.DB{Routes: append(modelDataRoutes(&reads), w.db.Routes...)}
	d.Config.ComputeMisses = true
	d.Sources.Compute = &hydrate.MissCompute{Now: func() time.Time { return testNow }}
	d.Config.ServeDataMiss = true
	ans, err := ServeList(context.Background(), d, d.Sources, ListRequest{
		Query: "limit=5", Path: "/api/v1/models", Host: "site.example.test", Serving: true,
	})
	return ans, reads, err
}

// The list's model-data miss computation reads the model's lag flag first (Node's lag-aware lookup):
// a flag READ that fails hands back as v1-models-lag-flag-failed, with no lookup, where a flag that is
// SET hands back as the content miss v1-models-data-miss (the flag wins over a failed read, as
// lagFlagged answers). A data GET that failed is a miss the computation answers like any other when
// the flag reads clean (served, unchanged), and v1-models-data-read-failed when it would hand back.
func TestServeListLagFlagReadFailure(t *testing.T) {
	const lagKey = "lag-helper:model:5001"
	noData := func(w *testWorld) { w.entries[KeyDataForModel+":5001"] = nil }
	for _, c := range []struct {
		name   string
		edit   func(*testWorld)
		reason string // "" = served
		reads  int
	}{
		{"data miss, the flag read fails", failKey(lagKey, noData), "v1-models-lag-flag-failed", 0},
		{"data miss, the flag set", func(w *testWorld) { noData(w); w.raw[lagKey] = "1" }, "v1-models-data-miss", 0},
		{"data miss, the flag clean: computed", noData, "", 1},
		{"data GET fails, the flag clean: computed", failKey(KeyDataForModel + ":5001"), "", 1},
		{"data GET fails, the flag set", failKey(KeyDataForModel+":5001", func(w *testWorld) { w.raw[lagKey] = "1" }),
			"v1-models-data-read-failed", 0},
	} {
		w := newTestWorld()
		c.edit(w)
		ans, reads, err := serveListWith(t, w)
		if reason(err) != c.reason || reads != c.reads {
			t.Errorf("%s: %q (%v), %d lookups; want %q and %d", c.name, reason(err), err, reads, c.reason, c.reads)
			continue
		}
		if c.reason == "" && (ans == nil || ans.Trivial) {
			t.Errorf("%s: no page served", c.name)
		}
	}
}

// The curated-showcase guard with the miss computation on: a version with no showcase entry whose
// lag-flag READ fails hands back as v1-models-showcase-miss-failed on both routes, not as the
// content miss v1-models-showcase-miss a set flag gives; neither queries the replica.
func TestCuratedShowcaseGuardLagFlagReadFailure(t *testing.T) {
	const lagKey = "lag-helper:modelVersion:6001"
	noEntry := func(w *testWorld) { w.entries[showcaseKey6001] = nil }
	for _, c := range []struct {
		name   string
		edit   func(*testWorld)
		reason string
	}{
		{"the flag read fails", failKey(lagKey, noEntry), "v1-models-showcase-miss-failed"},
		{"the flag set", func(w *testWorld) {
			noEntry(w)
			w.raw[lagKey] = "1"
		}, "v1-models-showcase-miss"},
	} {
		_, _, bound, dErr, lErr := serveBothComputed(t, c.edit, false, nil)
		if reason(dErr) != c.reason || reason(lErr) != c.reason {
			t.Errorf("%s: detail %q (%v), list %q (%v), want %q", c.name, reason(dErr), dErr, reason(lErr), lErr, c.reason)
		}
		if len(bound) != 0 {
			t.Errorf("%s: replica lookups %v, want none", c.name, bound)
		}
	}
}
