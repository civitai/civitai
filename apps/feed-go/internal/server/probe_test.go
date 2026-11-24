package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// goldenCache is the cache-cluster fake a golden env reads (the gallery store's client).
func goldenCache(t *testing.T, env *goldenEnv) *testkit.Redis {
	t.Helper()
	r, ok := env.server.Deps.Gallery.Cache.(*testkit.Redis)
	if !ok {
		t.Fatal("the golden env's cache is not a testkit.Redis")
	}
	return r
}

// cacheState is every key the fake holds and every string value (a write of any kind changes it).
func cacheState(r *testkit.Redis) map[string]string {
	out := map[string]string{}
	for _, k := range r.AllKeys() {
		v, _ := r.String(k)
		out[k] = string(v)
	}
	return out
}

// goldenProbeCase is one registered procedure's golden fixtures: its probe and its serving compute.
type goldenProbeCase struct {
	dir, procedure string
	min            int
	setup          func(*testing.T, *goldenFixture) *goldenEnv
	serve          func(*Server, context.Context, *http.Request) (*computed, error)
	request        func(context.Context, ShadowRequest) (*http.Request, error)
	// required: the caches the emptied-cache comparison must reach as would_miss.
	required []string
	// computed: the caches Go computes whose emptied-cache comparison must reach would_serve with the
	// cache reported (the miss computation, hydrate.MissCaches).
	computed []string
	// presence: the probe checks presence itself (a recorder); model.getAll runs its serving path
	// and reports the cache its fallback names, and the misses Go computes (hydrate.WithPresence).
	presence bool
}

var goldenProbeCases = []goldenProbeCase{
	{"as-posts", Procedure, goldenMinAsPosts, goldenSetup, (*Server).compute, SyntheticRequest,
		[]string{hydrate.CacheMetrics, CacheSessionUser, CacheGallerySettings}, []string{hydrate.CacheTagIDs, hydrate.CacheImageFrames}, true},
	{"infinite", ProcedureInfinite, goldenMinInfinite, goldenSetup, (*Server).computeInfinite, SyntheticInfiniteRequest,
		[]string{hydrate.CacheMetrics, CacheNewCreators}, []string{hydrate.CacheTagIDs}, true},
	{"model-getall", ProcedureModelGetAll, goldenMinModels, goldenSetupModels, (*Server).computeModelGetAll, SyntheticModelGetAllRequest,
		[]string{hydrate.CacheUserCosmetics}, []string{CacheModelData, CacheModelTags, CacheModelFrames, CacheModelDecorations, hydrate.CacheTagIDs,
			CacheOfficialModels}, false},
}

// The registry holds exactly the procedures the golden cases cover (a new registration needs its
// golden case here).
func TestProbeRegistryMatchesGoldenCases(t *testing.T) {
	got := make([]string, 0, len(probes))
	want := make([]string, 0, len(goldenProbeCases))
	for p := range probes {
		got = append(got, p)
	}
	for _, c := range goldenProbeCases {
		want = append(want, c.procedure)
	}
	slices.Sort(got)
	slices.Sort(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("registered probes %v, golden-covered %v", got, want)
	}
}

// runGoldenProbe runs the registered probe of fx's request on env, synchronously, and classifies it.
func runGoldenProbe(t *testing.T, env *goldenEnv, fx *goldenFixture, procedure string) (string, []string, error) {
	t.Helper()
	checker, ok := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
	if !ok {
		t.Fatal("the golden hydrator has no presence check")
	}
	rec := &hydrate.PresenceProbe{Checker: checker}
	err := probes[procedure].run(env.server, context.Background(), ProbeRequest{Input: fx.Request.Input, Headers: env.headers}, rec)
	result, missed := classifyProbe(err, rec.Misses(), rec.Raced(), checker.MissReason)
	return result, missed, err
}

// missReasonCache is the cache a serving fallback reason is a miss on ("" for any other reason): the
// page caches' Reasons and the pre-hydration ones.
func missReasonCache(reason string) string { return fallbackMissCache(reason) }

// The probe over every golden request of each registered procedure, against what serving does with
// the same request:
// a served fixture is would_serve, with the feed service asked exactly the queries Node sends (the
// page ids are resolved as serving resolves them); a fixture serving falls back on with a cache-miss
// reason is would_miss on that cache; any other fallback is unsupported. Never a write.
func TestProbeGolden(t *testing.T) {
	for _, gc := range goldenProbeCases {
		t.Run(gc.dir, func(t *testing.T) { probeGoldenDir(t, gc) })
	}
}

func probeGoldenDir(t *testing.T, gc goldenProbeCase) {
	seen := map[string]int{}
	expected := map[string]bool{}
	for _, path := range goldenFiles(t, gc.dir, gc.min) {
		fx := goldenLoad(t, path)
		switch want := fx.Expect.Fallback; {
		case want == "":
			expected[ProbeWouldServe] = true
		case missReasonCache(want) != "":
			expected[ProbeWouldMiss] = true
		default:
			expected[ProbeUnsupported] = true
		}
		t.Run(fx.Name, func(t *testing.T) {
			env := gc.setup(t, fx)
			cache := goldenCache(t, env)
			before := cacheState(cache)
			result, missed, err := runGoldenProbe(t, env, fx, gc.procedure)
			if after := cacheState(cache); !reflect.DeepEqual(after, before) {
				t.Fatalf("the probe wrote to the cache:\n before %v\n after  %v", before, after)
			}
			seen[result]++
			want := fx.Expect.Fallback
			switch c := missReasonCache(want); {
			case want == "":
				if result != ProbeWouldServe {
					t.Fatalf("served by Go; probe %s (missed %v, err %v)", result, missed, err)
				}
				// A cold-<cache> fixture is served by computing that cache's misses: the probe
				// still reports the cache (the miss Go-first would compute), and would_serve.
				if c := goldenColdCache[fx.Name]; c != "" {
					if !slices.Contains(missed, c) {
						t.Fatalf("%s: probe missed %v, want %s reported", fx.Name, missed, c)
					}
					seen["cold:"+c]++
				}
				if gc.presence {
					// The image procedures' pages come from the feed service: the probe asked it
					// exactly what serving asks.
					env.feed.check(t, true)
				}
			case c != "":
				if result != ProbeWouldMiss || !slices.Contains(missed, c) {
					t.Fatalf("Go falls back with %s; probe %s missed %v (err %v), want would_miss on %s", want, result, missed, err, c)
				}
				env.feed.check(t, false)
			default:
				if result != ProbeUnsupported || fallback.Reason(err) != want {
					t.Fatalf("Go falls back with %s; probe %s (err %v), want unsupported with the same reason", want, result, err)
				}
				env.feed.check(t, false)
			}
		})
	}
	// Positive control: the probe reached every outcome the fixtures' expectations imply, and on
	// as-posts every cold-<cache> fixture. (would_miss is also reached by the next test.)
	outcomes := []string{ProbeWouldServe}
	for _, r := range []string{ProbeWouldMiss, ProbeUnsupported} {
		if expected[r] {
			outcomes = append(outcomes, r)
		}
	}
	if gc.dir == "as-posts" {
		for _, c := range goldenColdCache {
			outcomes = append(outcomes, "cold:"+c)
		}
	}
	for _, r := range outcomes {
		if seen[r] == 0 {
			t.Errorf("no fixture probed %s: %v", r, seen)
		}
	}
}

// goldenColdCache names the cache each cold-<cache> fixture has cold (gen.mjs): served by computing
// those misses (hydrate.MissCompute).
var goldenColdCache = map[string]string{
	"cold-user-cosmetics":   hydrate.CacheUserCosmetics,
	"cold-image-frames":     hydrate.CacheImageFrames,
	"cold-event-decoration": hydrate.CacheEventDecorations,
}

// goldenKeyCache is the cache a golden Redis key belongs to ("" for keys the probe does not report).
var goldenPerIDKey = regexp.MustCompile(`^(.*):(\d+)$`)

func goldenKeyCache(key string) string {
	if key == feed.BlockedTagsKey {
		return CacheBlockedTags
	}
	if key == hydrate.KeyOfficialModels {
		return CacheOfficialModels
	}
	if strings.HasPrefix(key, feed.NewCreatorsKey+":") {
		return CacheNewCreators
	}
	m := goldenPerIDKey.FindStringSubmatch(key)
	if m == nil {
		return ""
	}
	switch m[1] {
	case "session:data2":
		return CacheSessionUser
	case "model:gallery-settings":
		return CacheGallerySettings
	case hydrate.KeyDataForModel:
		return CacheModelData
	case hydrate.KeyModelTags:
		return CacheModelTags
	case hydrate.KeyModelFrames:
		return CacheModelFrames
	case hydrate.KeyModelEvents:
		return CacheModelDecorations
	case hydrate.KeyVersionImages:
		return CacheVersionImages
	}
	for _, c := range hydrate.PageCaches {
		if c.Key == m[1] {
			return c.Name
		}
	}
	return ""
}

// The cache table against serving, cache by cache: for every served golden request and every cache
// it reads, the request with that cache emptied is served and probed. Where serving falls back with
// a cache-miss reason, the probe must say would_miss on that same cache; where serving still answers
// (a miss Go fills from the replica), the probe must say would_serve. So a cache whose Reason drifts
// from what Page does — or a fallback miss the probe cannot see — fails here.
func TestProbeAgreesWithServeOnEachCacheMiss(t *testing.T) {
	for _, gc := range goldenProbeCases {
		t.Run(gc.dir, func(t *testing.T) { probeAgreesOnEachCacheMiss(t, gc) })
	}
}

func probeAgreesOnEachCacheMiss(t *testing.T, gc goldenProbeCase) {
	missCompared := map[string]int{}
	serveCompared := map[string]int{}
	for _, path := range goldenFiles(t, gc.dir, gc.min) {
		fx := goldenLoad(t, path)
		if fx.Expect.Fallback != "" {
			continue
		}
		byCache := map[string][]string{}
		for k := range fx.Redis {
			if c := goldenKeyCache(k); c != "" {
				byCache[c] = append(byCache[c], k)
			}
		}
		for cache, keys := range byCache {
			t.Run(fx.Name+"/"+cache, func(t *testing.T) {
				cold := *fx
				// Not a request Node answered: the fixture's expected answer (and the model harness's
				// "every page Node read" check, which reads it) does not apply to the cold copy.
				cold.Expect.Fallback = "test-cache-emptied"
				cold.Redis = map[string]goldenRedisEntry{}
				for k, v := range fx.Redis {
					if !slices.Contains(keys, k) {
						cold.Redis[k] = v
					}
				}
				served := gc.setup(t, &cold)
				r, err := gc.request(context.Background(), ShadowRequest{Input: cold.Request.Input, Headers: served.headers})
				if err != nil {
					t.Fatal(err)
				}
				_, serveErr := gc.serve(served.server, context.Background(), r)
				result, missed, probeErr := runGoldenProbe(t, gc.setup(t, &cold), &cold, gc.procedure)
				reason := fallback.Reason(serveErr)
				switch {
				case serveErr == nil:
					if result != ProbeWouldServe {
						t.Fatalf("served with %s cold; probe %s missed %v (err %v), want would_serve", cache, result, missed, probeErr)
					}
					// A cache this request never reads (a moderator skips the held-level settings) is
					// served cold and not reported; one it reads and fills itself is reported.
					if slices.Contains(missed, cache) {
						serveCompared[cache]++
					}
				case missReasonCache(reason) != "":
					if missReasonCache(reason) != cache {
						t.Fatalf("emptying %s made serving fall back with %s, a miss on another cache", cache, reason)
					}
					if result != ProbeWouldMiss || !slices.Contains(missed, cache) {
						t.Fatalf("serving falls back with %s; probe %s missed %v (err %v), want would_miss on %s", reason, result, missed, probeErr, cache)
					}
					missCompared[cache]++
				default:
					// Serving failed another way (the golden replica does not answer every miss
					// query): nothing to compare. The controls below bound how often.
					t.Logf("not compared: serving answered %v", serveErr)
				}
			})
		}
	}
	// Positive controls: every cache Go falls back on was compared at least once, and so was a cache
	// Go fills itself (else the would_serve arm proves nothing). The golden server computes the
	// user-cosmetic, frame (image and model), tag-ids and event-decoration misses (MissCompute), so
	// those serve; metric hashes still fall back. The infinite fixtures reach the per-image ones.
	for _, c := range gc.required {
		if missCompared[c] == 0 {
			t.Errorf("no golden request compared a %s miss (compared: %v)", c, missCompared)
		}
	}
	for _, c := range gc.computed {
		if serveCompared[c] == 0 {
			t.Errorf("no golden request was served with its %s cold and reported it (the computed miss is unexercised): %v", c, serveCompared)
		}
	}
	if gc.presence && serveCompared[hydrate.CacheBasicUsers] == 0 {
		t.Errorf("no golden request was served with its basic users cold and reported them (the would_serve arm is unexercised): %v", serveCompared)
	}
	t.Logf("would_miss compared %v; would_serve compared %v", missCompared, serveCompared)
}

func TestClassifyProbe(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		misses     map[string]int
		wantResult string
		wantMissed []string
	}{
		{"every cache answered", nil, nil, ProbeWouldServe, nil},
		{"a miss Go fills itself", nil, map[string]int{hydrate.CacheBasicUsers: 2, hydrate.CacheCosmetics: 1}, ProbeWouldServe,
			[]string{hydrate.CacheBasicUsers, hydrate.CacheCosmetics}},
		{"a miss Go falls back on", nil, map[string]int{hydrate.CacheTagIDs: 1, hydrate.CacheThumbnails: 1}, ProbeWouldMiss,
			[]string{hydrate.CacheThumbnails, hydrate.CacheTagIDs}},
		{"a session miss", fallback.New("session-cache-miss"), nil, ProbeWouldMiss, []string{CacheSessionUser}},
		{"a cleared session", fallback.New("session-cache-cleared"), nil, ProbeWouldMiss, []string{CacheSessionUser}},
		{"gallery settings to rebuild", fallback.New("gallery-settings-stale"), nil, ProbeWouldMiss, []string{CacheGallerySettings}},
		{"gallery settings absent", fallback.New("gallery-settings-miss"), nil, ProbeWouldMiss, []string{CacheGallerySettings}},
		{"another fallback after a page miss", fallback.New("sponsored-post"), map[string]int{hydrate.CacheMetrics: 1}, ProbeUnsupported,
			[]string{hydrate.CacheMetrics}},
		{"an input shape", fallback.New("input-sort"), nil, ProbeUnsupported, nil},
		{"the budget", fallback.New("deadline"), nil, ProbeUnsupported, nil},
		{"a panic", fallback.New("panic"), nil, ProbeError, nil},
		{"a store error", errors.New("redis down"), map[string]int{hydrate.CacheTagIDs: 1}, ProbeError, []string{hydrate.CacheTagIDs}},
		{"a blocked-tag list to rebuild", fallback.New("blocked-tags-stale"), nil, ProbeWouldMiss, []string{CacheBlockedTags}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result, missed := classifyProbe(c.err, c.misses, nil, (&hydrate.Sources{}).MissReason)
			if result != c.wantResult || !reflect.DeepEqual(missed, c.wantMissed) {
				t.Fatalf("classifyProbe = %s %v, want %s %v", result, missed, c.wantResult, c.wantMissed)
			}
		})
	}
}

// With the misses computed (MissCompute), user-cosmetics, tag-ids, model-frame and model-decoration misses are served
// Go-first and a metric-hash miss still is not: the classification follows the deployment's Sources,
// not the static table.
func TestClassifyProbeWithComputedMisses(t *testing.T) {
	computed := (&hydrate.Sources{Compute: &hydrate.MissCompute{}}).MissReason
	plain := (&hydrate.Sources{}).MissReason
	result, missed := classifyProbe(nil, map[string]int{hydrate.CacheUserCosmetics: 3, hydrate.CacheImageFrames: 1, hydrate.CacheTagIDs: 2}, nil, computed)
	if result != ProbeWouldServe || !reflect.DeepEqual(missed, []string{hydrate.CacheUserCosmetics, hydrate.CacheImageFrames, hydrate.CacheTagIDs}) {
		t.Fatalf("computed misses: %s %v, want would_serve reporting all three", result, missed)
	}
	if result, missed := classifyProbe(nil, map[string]int{CacheModelFrames: 1}, nil, computed); result != ProbeWouldServe || !reflect.DeepEqual(missed, []string{CacheModelFrames}) {
		t.Fatalf("a model-frames miss with computed misses: %s %v, want would_serve reporting it", result, missed)
	}
	if result, missed := classifyProbe(nil, map[string]int{CacheVersionImages: 3}, nil, computed); result != ProbeWouldServe || !reflect.DeepEqual(missed, []string{CacheVersionImages}) {
		t.Fatalf("a version-images miss with computed misses: %s %v, want would_serve reporting it", result, missed)
	}
	if result, missed := classifyProbe(nil, map[string]int{CacheModelDecorations: 2}, nil, computed); result != ProbeWouldServe || !reflect.DeepEqual(missed, []string{CacheModelDecorations}) {
		t.Fatalf("a model-decorations miss with computed misses: %s %v, want would_serve reporting it", result, missed)
	}
	if result, _ := classifyProbe(nil, map[string]int{hydrate.CacheTagIDs: 1, hydrate.CacheMetrics: 1}, nil, computed); result != ProbeWouldMiss {
		t.Fatalf("a metrics miss with computed misses: %s, want would_miss", result)
	}
	// The same misses without a computation are would_miss (the arm can differ).
	for _, c := range []string{hydrate.CacheUserCosmetics, hydrate.CacheTagIDs, CacheModelFrames, CacheModelDecorations, CacheVersionImages} {
		if result, _ := classifyProbe(nil, map[string]int{c: 1}, nil, plain); result != ProbeWouldMiss {
			t.Fatalf("a %s miss without a computation: %s, want would_miss", c, result)
		}
	}
}

// A race turns would_serve into raced only on a cache Go falls back on (missReason non-empty): an
// entry filled mid-probe on a cache Go answers itself would have been answered had it been missing,
// exactly as a cold miss there is. A miss Go falls back on, a fallback or an error keep their own
// result whatever raced.
func TestClassifyProbeRaced(t *testing.T) {
	// metrics falls back on a miss; every other cache (image-frames, basic-users, ...) Go answers.
	reason := func(name string) string {
		if name == hydrate.CacheMetrics {
			return "metrics-miss"
		}
		return ""
	}
	frames, metrics := hydrate.CacheImageFrames, hydrate.CacheMetrics
	for _, c := range []struct {
		name   string
		err    error
		misses map[string]int
		raced  map[string]int
		want   string
	}{
		{"nothing raced", nil, nil, nil, ProbeWouldServe},
		{"raced only on a cache Go computes", nil, nil, map[string]int{frames: 2}, ProbeWouldServe},
		{"raced on caches Go answers, one also missed", nil, map[string]int{frames: 1},
			map[string]int{frames: 1, hydrate.CacheBasicUsers: 3}, ProbeWouldServe},
		{"raced on a cache Go falls back on", nil, nil, map[string]int{metrics: 1}, ProbeRaced},
		{"raced on both kinds", nil, nil, map[string]int{frames: 1, metrics: 1}, ProbeRaced},
		{"a computed miss and a fallback-cache race", nil, map[string]int{frames: 1}, map[string]int{metrics: 1}, ProbeRaced},
		{"a zero raced count", nil, nil, map[string]int{metrics: 0}, ProbeWouldServe},
		{"a fallback-cache miss and a race on it", nil, map[string]int{metrics: 1}, map[string]int{metrics: 1}, ProbeWouldMiss},
		{"a fallback-cache miss and a computed-cache race", nil, map[string]int{metrics: 1}, map[string]int{frames: 1}, ProbeWouldMiss},
		{"another fallback", fallback.New("input-sort"), nil, map[string]int{metrics: 1}, ProbeUnsupported},
		{"a store error", errors.New("down"), nil, map[string]int{metrics: 1}, ProbeError},
	} {
		if got, _ := classifyProbe(c.err, c.misses, c.raced, reason); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestRacedSince(t *testing.T) {
	if !racedSince(0).IsZero() {
		t.Fatal("no start: want no race threshold")
	}
	got := racedSince(1_700_000_000_250.5)
	want := time.UnixMicro(1_700_000_000_250_500).Add(-RaceSkewMargin)
	if !got.Equal(want) {
		t.Fatalf("racedSince = %v, want %v", got, want)
	}
}

// The race end to end. A tag-ids entry Node filled after the request began (its cachedAt after
// startedAt) is present; tag ids are a cache Go computes, so a Go-first serve would have answered it
// cold too: would_serve, the race still counted on its cache, and the lookup it would have made
// counted as a database read. A metric hash populated after the request began is a cache Go falls back
// on: raced. The same fixture with the entry stamped before the margin is would_serve with no read
// (the control: the stamp alone decides).
func TestProbeHandlerRaced(t *testing.T) {
	for _, tc := range []struct {
		name     string
		cache    string
		filledAt time.Duration // relative to the request's start
		want     string
		reads    bool // a database read counted on the cache
	}{
		{"tag ids filled after the request began", hydrate.CacheTagIDs, 20 * time.Millisecond, ProbeWouldServe, true},
		{"tag ids filled inside the skew margin before it", hydrate.CacheTagIDs, -RaceSkewMargin / 2, ProbeWouldServe, true},
		{"tag ids filled before the margin", hydrate.CacheTagIDs, -time.Hour, ProbeWouldServe, false},
		{"metrics populated after the request began", hydrate.CacheMetrics, 20 * time.Millisecond, ProbeRaced, false},
		{"metrics populated before the margin", hydrate.CacheMetrics, -time.Hour, ProbeWouldServe, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, fx, reg := probeEnv(t)
			start := time.Now().Add(-time.Second)
			filled := start.Add(tc.filledAt)
			cache := goldenCache(t, env)
			stamped := 0
			for _, k := range cache.AllKeys() {
				switch {
				case tc.cache == hydrate.CacheTagIDs && strings.HasPrefix(k, hydrate.KeyTagIDs+":"):
					b, err := msgpack.Marshal(map[string]any{"tags": []any{1}, "cachedAt": filled})
					if err != nil {
						t.Fatal(err)
					}
					cache.SetString(k, b)
				case tc.cache == hydrate.CacheMetrics && strings.HasPrefix(k, "metrics:Image:"):
					h := cache.Hash(k)
					if h == nil {
						t.Fatalf("%s is not a hash", k)
					}
					h["_populatedAt"] = strconv.FormatInt(filled.UnixMilli(), 10)
					cache.SetHash(k, h)
				default:
					continue
				}
				stamped++
			}
			if stamped == 0 {
				t.Fatalf("the fixture has no %s keys to stamp", tc.cache)
			}
			startedAt := float64(start.UnixNano()) / 1e6
			w := httptest.NewRecorder()
			env.server.ProbeHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, startedAt)))
			results := []string{ProbeWouldServe, ProbeWouldMiss, ProbeRaced, ProbeUnsupported, ProbeError}
			waitFor(t, "the probe to finish", func() bool {
				n := 0.0
				for _, r := range results {
					n += goFirst(t, reg, "feed_go_gofirst_total", resultLabels(r))
				}
				return n == 1 && len(env.server.ProbeQueue) == 0
			})
			for _, r := range results {
				if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(r)); r == tc.want && n != 1 || r != tc.want && n != 0 {
					t.Errorf("%s = %v, want the probe %s", r, n, tc.want)
				}
			}
			labels := map[string]string{"feed_endpoint": EndpointAsPosts, "cache": tc.cache}
			// Every raced cache is counted, whatever the result.
			racedN := goFirst(t, reg, "feed_go_gofirst_raced_total", labels)
			if wantRaced := map[bool]float64{true: 1, false: 0}[tc.filledAt > -time.Hour]; racedN != wantRaced {
				t.Errorf("raced{%s} = %v, want %v", tc.cache, racedN, wantRaced)
			}
			reads := goFirst(t, reg, "feed_go_gofirst_db_reads_total", labels)
			pages := goFirst(t, reg, "feed_go_gofirst_pages_total", map[string]string{"feed_endpoint": EndpointAsPosts})
			if tc.reads && (reads < 1 || reads > pages) {
				t.Errorf("db reads{%s} = %v over %v pages, want at least one and at most one per page", tc.cache, reads, pages)
			} else if !tc.reads && reads != 0 {
				t.Errorf("db reads{%s} = %v, want 0", tc.cache, reads)
			}
		})
	}
}

func TestObserveLag(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	at := time.UnixMilli(1_700_000_000_200)
	observeLag(m.GoFirstCheckLag, EndpointAsPosts, at, 1_700_000_000_000) // 200ms after
	observeLag(m.GoFirstCheckLag, EndpointAsPosts, at, 1_700_000_000_400) // a clock 150ms ahead: 0
	observeLag(m.GoFirstCheckLag, EndpointAsPosts, at, 0)                 // unknown start: nothing
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_gofirst_check_lag_seconds" {
			continue
		}
		h := mf.GetMetric()[0].GetHistogram()
		if h.GetSampleCount() != 2 || h.GetSampleSum() < 0.1999 || h.GetSampleSum() > 0.2001 {
			t.Fatalf("count %d sum %v, want 2 observations summing to 0.2s", h.GetSampleCount(), h.GetSampleSum())
		}
		// The 0.2 s observation is above the 0.1 bucket and within 0.25; the clamped one in the first.
		for _, b := range h.GetBucket() {
			want := map[float64]uint64{.001: 1, .1: 1, .25: 2}[b.GetUpperBound()]
			if want != 0 && b.GetCumulativeCount() != want {
				t.Errorf("bucket le=%v: %d, want %d", b.GetUpperBound(), b.GetCumulativeCount(), want)
			}
		}
		return
	}
	t.Fatal("no check-lag histogram")
}

// probeEnv is a golden env for a served fixture, with the metrics and queues the handler needs.
// probeFixture is a served, signed-out gallery page with images, a video and every cache warm.
const probeFixture = "version-signed-out-most-reactions"

func probeEnv(t *testing.T) (*goldenEnv, *goldenFixture, *prometheus.Registry) {
	t.Helper()
	fx := goldenLoad(t, filepath.Join(goldenDir, "as-posts", probeFixture+".json"))
	env := goldenSetup(t, fx)
	reg := prometheus.NewRegistry()
	env.server.Metrics = NewMetrics(reg)
	env.server.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	env.server.ProbeQueue = make(chan struct{}, 1)
	return env, fx, reg
}

func probeBody(t *testing.T, fx *goldenFixture, headers map[string]string, startedAt float64) io.Reader {
	t.Helper()
	b, err := json.Marshal(ProbeRequest{Input: fx.Request.Input, Headers: headers, StartedAt: startedAt})
	if err != nil {
		t.Fatal(err)
	}
	return strings.NewReader(string(b))
}

func goFirst(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, name, labels)
	return v
}

func resultLabels(result string) map[string]string {
	return map[string]string{"feed_endpoint": EndpointAsPosts, "result": result}
}

// The handler end to end through the internal mux: 202 at once, the probe runs in the background,
// its result, its misses, the check-lag histogram and the pages it checked recorded.
func TestProbeHandlerRecordsAResult(t *testing.T) {
	env, fx, reg := probeEnv(t)
	mux := InternalMux(env.server, http.NotFoundHandler(), false)
	startedAt := float64(time.Now().Add(-20*time.Millisecond).UnixNano()) / 1e6
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, startedAt)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
	waitFor(t, "the probe to finish", func() bool {
		return goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldServe)) == 1 && len(env.server.ProbeQueue) == 0
	})
	ep := map[string]string{"feed_endpoint": EndpointAsPosts}
	// The cost gate's denominator: a served probe counts the pages it checked.
	if n := goFirst(t, reg, "feed_go_gofirst_pages_total", ep); n < 1 {
		t.Errorf("pages counted %v for a served probe, want >= 1", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_check_lag_seconds", ep); n != 1 {
		t.Errorf("check lag observations %v, want 1 (the page was checked)", n)
	}
	for _, r := range []string{ProbeWouldMiss, ProbeRaced, ProbeUnsupported, ProbeError} {
		if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(r)); n != 0 {
			t.Errorf("%s = %v, want 0", r, n)
		}
	}
	if err := env.server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	// A cold tag-ids cache: Go computes those misses, so would_serve, the miss counted on its cache,
	// its lookup counted as a database read on every page that missed, and nothing queried or
	// written by the probe itself.
	env, fx, reg = probeEnv(t)
	cache := goldenCache(t, env)
	for _, k := range cache.AllKeys() {
		if strings.HasPrefix(k, hydrate.KeyTagIDs+":") {
			cache.SetString(k, []byte{0xc1}) // undecodable: a miss, as an absent key
		}
	}
	before := cacheState(cache)
	w = httptest.NewRecorder()
	env.server.ProbeHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, 0)))
	waitFor(t, "the probe to finish", func() bool {
		return goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldServe)) == 1 && len(env.server.ProbeQueue) == 0
	})
	tagLabels := map[string]string{"feed_endpoint": EndpointAsPosts, "cache": hydrate.CacheTagIDs}
	if n := goFirst(t, reg, "feed_go_gofirst_miss_total", tagLabels); n != 1 {
		t.Errorf("tag-ids misses %v, want 1 (one probe)", n)
	}
	pages := goFirst(t, reg, "feed_go_gofirst_pages_total", ep)
	reads := goFirst(t, reg, "feed_go_gofirst_db_reads_total", tagLabels)
	if pages < 1 || reads < 1 || reads > pages {
		t.Errorf("tag-ids db reads %v over %v pages, want at least one read and at most one per page", reads, pages)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldMiss)); n != 0 {
		t.Errorf("would_miss = %v for a tag-ids miss Go computes, want 0", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_check_lag_seconds", ep); n != 0 {
		t.Errorf("check lag observed %v times with no startedAt, want 0", n)
	}
	if after := cacheState(cache); !reflect.DeepEqual(after, before) {
		t.Error("the probe wrote to the cache")
	}
	if err := env.server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	// The same cold cache without the computation (FEED_GO_COMPUTE_MISSES off): would_miss, and a
	// would_miss probe is not served, so no pages and no reads for the cost gate.
	env, fx, reg = probeEnv(t)
	env.server.Deps.Hydrator.(*hydrate.Sources).Compute = nil
	cache = goldenCache(t, env)
	for _, k := range cache.AllKeys() {
		if strings.HasPrefix(k, hydrate.KeyTagIDs+":") {
			cache.SetString(k, []byte{0xc1})
		}
	}
	w = httptest.NewRecorder()
	env.server.ProbeHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, 0)))
	waitFor(t, "the probe to finish", func() bool {
		return goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldMiss)) == 1 && len(env.server.ProbeQueue) == 0
	})
	if n := goFirst(t, reg, "feed_go_gofirst_miss_total", tagLabels); n != 1 {
		t.Errorf("no computation: tag-ids misses %v, want 1", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_pages_total", ep); n != 0 {
		t.Errorf("pages counted %v for a would_miss probe, want 0", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_db_reads_total", tagLabels); n != 0 {
		t.Errorf("db reads counted %v for a would_miss probe, want 0", n)
	}
}

// model.getAll's probe with the model frames cold: Go computes them, so would_serve with the miss
// reported, its lookup counted as one read on the page that missed and the page counted, and the
// probe sent no frame query and wrote nothing (hydrate.WithPresence). Without the computation the
// same probe is would_miss on model-frames.
func TestProbeModelGetAllComputedFrameMiss(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "highest-rated-signed-out.json"))
	cold := *fx
	cold.Expect.Fallback = "test-cache-emptied"
	cold.Redis = map[string]goldenRedisEntry{}
	frames := 0
	for k, v := range fx.Redis {
		if strings.HasPrefix(k, hydrate.KeyModelFrames+":") {
			frames++
			continue
		}
		cold.Redis[k] = v
	}
	if frames == 0 {
		t.Fatal("the fixture has no model frame keys to empty")
	}
	for _, withCompute := range []bool{true, false} {
		env := goldenSetupModels(t, &cold)
		if !withCompute {
			env.server.Models.Sources.(*hydrate.Sources).Compute = nil
			env.server.Deps.Hydrator.(*hydrate.Sources).Compute = nil
		}
		before := cacheState(env.cache)
		checker := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
		rec := &hydrate.PresenceProbe{Checker: checker}
		err := probes[ProcedureModelGetAll].run(env.server, context.Background(), ProbeRequest{Input: cold.Request.Input, Headers: env.headers}, rec)
		result, missed := classifyProbe(err, rec.Misses(), nil, checker.MissReason)
		if !slices.Contains(missed, CacheModelFrames) {
			t.Fatalf("compute %v: missed %v, want model-frames reported", withCompute, missed)
		}
		if !withCompute {
			if result != ProbeWouldMiss || fallback.Reason(err) != "model-frame-miss" {
				t.Fatalf("no computation: %s (%v), want would_miss on model-frame-miss", result, err)
			}
			continue
		}
		if result != ProbeWouldServe {
			t.Fatalf("computed: %s missed %v (err %v), want would_serve", result, missed, err)
		}
		_, pages := rec.FirstCheck()
		if reads := rec.DBReads()[CacheModelFrames]; pages < 1 || reads < 1 || reads > pages {
			t.Fatalf("model-frames reads %d over %d pages, want at least one and at most one per page", reads, pages)
		}
		if rec.Misses()[CacheModelFrames] < 1 {
			t.Fatalf("misses %v", rec.Misses())
		}
		for _, q := range env.server.Models.DB.(*goldenModelPG).Calls {
			if strings.Contains(q, `IS DISTINCT FROM 'string'`) {
				t.Fatal("the probe queried for a frame miss")
			}
		}
		if after := cacheState(env.cache); !reflect.DeepEqual(after, before) {
			t.Fatal("the probe wrote to the cache")
		}
	}
}

// goldenShowcaseColumns are the showcase lookup's columns, in its SELECT order.
var goldenShowcaseColumns = []string{"id", "userId", "name", "url", "nsfwLevel", "width", "height", "hash", "type",
	"metadata", "minor", "poi", "modelVersionId", "availability", "hasMeta", "hasPositivePrompt", "onSite", "remixOfId"}

// goldenShowcaseRows is a cached showcase entry as the lookup's rows would return it: each image's
// columns, the json ones as text, integers as int64.
func goldenShowcaseRows(t *testing.T, e goldenRedisEntry) [][]any {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(e.Packed)
	if err != nil {
		t.Fatal(err)
	}
	v, err := hydrate.Unpack(b)
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := v.(map[string]any)
	images, _ := entry["images"].([]any)
	rows := make([][]any, 0, len(images))
	for _, raw := range images {
		img, _ := raw.(map[string]any)
		row := make([]any, len(goldenShowcaseColumns))
		for i, col := range goldenShowcaseColumns {
			val := img[col]
			switch col {
			case "metadata", "remixOfId":
				if val != nil {
					j, err := json.Marshal(val)
					if err != nil {
						t.Fatal(err)
					}
					val = string(j)
				}
			case "id", "userId", "nsfwLevel", "width", "height", "modelVersionId":
				if n, ok := hydrate.Int(val); ok {
					val = int64(n)
				}
			}
			row[i] = val
		}
		rows = append(rows, row)
	}
	return rows
}

// model.getAll's probe with the version showcases cold (highest-rated-signed-out: the shown versions
// 6001 and 6003, then 6004, the version a cover lives on). Go computes them, and the probe looks them
// up (on the replica, here the fixture's own cached rows) instead of answering "no entry", since a
// model without images would be dropped and the probe would page on: would_serve with the 3 versions
// reported, one read per lookup (2) over the 1 page, and nothing written. Without the computation the
// same probe is would_miss on version-images (model-images-miss).
func TestProbeModelGetAllComputedShowcaseMiss(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "highest-rated-signed-out.json"))
	cold := *fx
	cold.Expect.Fallback = "test-cache-emptied"
	cold.Redis = map[string]goldenRedisEntry{}
	showcases := map[int][][]any{}
	for k, v := range fx.Redis {
		if id, ok := strings.CutPrefix(k, hydrate.KeyVersionImages+":"); ok {
			n, err := strconv.Atoi(id)
			if err != nil {
				t.Fatal(err)
			}
			showcases[n] = goldenShowcaseRows(t, v)
			continue
		}
		cold.Redis[k] = v
	}
	if len(showcases) != 3 {
		t.Fatalf("emptied %d showcase keys, want the fixture's 3", len(showcases))
	}
	for _, withCompute := range []bool{true, false} {
		env := goldenSetupModels(t, &cold)
		if !withCompute {
			env.server.Models.Sources.(*hydrate.Sources).Compute = nil
			env.server.Deps.Hydrator.(*hydrate.Sources).Compute = nil
		}
		pg := env.server.Models.DB.(*goldenModelPG)
		lookups := 0
		pg.Routes = append([]testkit.Route{{Match: `AS full_mv(id)`, Rows: func(args []any) (*testkit.Rows, error) {
			lookups++
			out := testkit.NewRows(goldenShowcaseColumns)
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, showcases[id]...)
			}
			return out, nil
		}}}, pg.Routes...)
		before := cacheState(env.cache)
		checker := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
		rec := &hydrate.PresenceProbe{Checker: checker}
		err := probes[ProcedureModelGetAll].run(env.server, context.Background(), ProbeRequest{Input: cold.Request.Input, Headers: env.headers}, rec)
		result, missed := classifyProbe(err, rec.Misses(), nil, checker.MissReason)
		if !slices.Contains(missed, "version-images") {
			t.Fatalf("compute %v: missed %v (err %v), want version-images reported", withCompute, missed, err)
		}
		if !withCompute {
			if result != ProbeWouldMiss || fallback.Reason(err) != "model-images-miss" || lookups != 0 {
				t.Fatalf("no computation: %s (%v), %d lookups, want would_miss on model-images-miss and none", result, err, lookups)
			}
			continue
		}
		if result != ProbeWouldServe || err != nil {
			t.Fatalf("computed: %s missed %v (err %v), want would_serve", result, missed, err)
		}
		_, pages := rec.FirstCheck()
		if got := rec.Misses()["version-images"]; got != 3 {
			t.Fatalf("version-images misses %d, want 3 (misses %v)", got, rec.Misses())
		}
		if reads := rec.DBReads()["version-images"]; pages != 1 || reads != 2 || lookups != 2 {
			t.Fatalf("version-images reads %d (%d lookups) over %d pages, want 2 (2) over 1", reads, lookups, pages)
		}
		if after := cacheState(env.cache); !reflect.DeepEqual(after, before) {
			t.Fatal("the probe wrote to the cache")
		}
	}
}

// model.getAll's probe with the model decorations cold (decoration-visible: one page of one model,
// its hat cached): Go computes them, so would_serve with the one missed id reported, one read on the
// one page, no decoration query sent and nothing written. Without the computation the same probe is
// would_miss on model-decorations (model-decoration-miss).
func TestProbeModelGetAllComputedDecorationMiss(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "decoration-visible.json"))
	cold := *fx
	cold.Expect.Fallback = "test-cache-emptied"
	cold.Redis = map[string]goldenRedisEntry{}
	emptied := 0
	for k, v := range fx.Redis {
		if strings.HasPrefix(k, hydrate.KeyModelEvents+":") {
			emptied++
			continue
		}
		cold.Redis[k] = v
	}
	if emptied != 1 {
		t.Fatalf("emptied %d model decoration keys, want the fixture's one", emptied)
	}
	for _, withCompute := range []bool{true, false} {
		env := goldenSetupModels(t, &cold)
		if !withCompute {
			env.server.Models.Sources.(*hydrate.Sources).Compute = nil
			env.server.Deps.Hydrator.(*hydrate.Sources).Compute = nil
		}
		before := cacheState(env.cache)
		checker := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
		rec := &hydrate.PresenceProbe{Checker: checker}
		err := probes[ProcedureModelGetAll].run(env.server, context.Background(), ProbeRequest{Input: cold.Request.Input, Headers: env.headers}, rec)
		result, missed := classifyProbe(err, rec.Misses(), nil, checker.MissReason)
		if !slices.Contains(missed, "model-decorations") {
			t.Fatalf("compute %v: missed %v, want model-decorations reported", withCompute, missed)
		}
		if !withCompute {
			if result != ProbeWouldMiss || fallback.Reason(err) != "model-decoration-miss" {
				t.Fatalf("no computation: %s (%v), want would_miss on model-decoration-miss", result, err)
			}
			continue
		}
		if result != ProbeWouldServe || err != nil {
			t.Fatalf("computed: %s missed %v (err %v), want would_serve", result, missed, err)
		}
		_, pages := rec.FirstCheck()
		if got := rec.Misses()["model-decorations"]; got != 1 {
			t.Fatalf("model-decorations misses %d, want 1 (misses %v)", got, rec.Misses())
		}
		if reads := rec.DBReads()["model-decorations"]; pages != 1 || reads != 1 {
			t.Fatalf("model-decorations reads %d over %d pages, want 1 over 1", reads, pages)
		}
		for _, q := range env.server.Models.DB.(*goldenModelPG).Calls {
			if strings.Contains(q, `jsonb_typeof(c.data->'event') = 'string'`) {
				t.Fatal("the probe queried for a decoration miss")
			}
		}
		if after := cacheState(env.cache); !reflect.DeepEqual(after, before) {
			t.Fatal("the probe wrote to the cache")
		}
	}
}

func TestProbeHandlerRejectsAndDrops(t *testing.T) {
	env, fx, reg := probeEnv(t)
	s := env.server
	call := func(method, path string, body io.Reader) int {
		w := httptest.NewRecorder()
		s.ProbeHandler(w, httptest.NewRequestWithContext(context.Background(), method, path, body))
		return w.Code
	}
	if c := call(http.MethodGet, ProbePathPrefix+Procedure, nil); c != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d, want 405", c)
	}
	if c := call(http.MethodPost, ProbePathPrefix+"nope.unregistered", strings.NewReader("{}")); c != http.StatusNotFound {
		t.Errorf("an unregistered procedure: %d, want 404", c)
	}
	if c := call(http.MethodPost, ProbePathPrefix+Procedure, strings.NewReader("not json")); c != http.StatusBadRequest || len(s.ProbeQueue) != 0 {
		t.Errorf("a bad body: %d with %d queued, want 400 and its slot released", c, len(s.ProbeQueue))
	}
	if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeError)); n != 1 {
		t.Errorf("error = %v after a bad body, want 1", n)
	}
	dropped := map[string]string{"feed_endpoint": EndpointAsPosts}
	s.ProbeQueue <- struct{}{}
	if c := call(http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, 0)); c != http.StatusAccepted {
		t.Errorf("a full queue: %d, want 202", c)
	}
	<-s.ProbeQueue
	if n := goFirst(t, reg, "feed_go_gofirst_dropped_total", dropped); n != 1 {
		t.Errorf("dropped = %v after a full queue, want 1", n)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c := call(http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, 0)); c != http.StatusAccepted {
		t.Errorf("shutting down: %d, want 202", c)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_dropped_total", dropped); n != 2 {
		t.Errorf("dropped = %v after shutdown began, want 2", n)
	}
	// Nothing ran: no result beyond the bad body's.
	if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldServe)); n != 0 {
		t.Errorf("would_serve = %v, want 0", n)
	}
}

func TestProbeErrors(t *testing.T) {
	env, fx, reg := probeEnv(t)
	s := env.server
	req := ProbeRequest{Input: fx.Request.Input, Headers: env.headers}

	// A panic in the probe: error, and counted where=probe.
	s.probe(context.Background(), probeSpec{endpoint: EndpointAsPosts, run: func(*Server, context.Context, ProbeRequest, *hydrate.PresenceProbe) error {
		panic("probe boom")
	}}, req)
	if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeError)); n != 1 {
		t.Errorf("error = %v after a panic, want 1", n)
	}
	if n := goFirst(t, reg, "feed_go_panics_total", map[string]string{"where": "probe"}); n != 1 {
		t.Errorf("panics{probe} = %v, want 1", n)
	}

	// A fallback that is not a cache miss: unsupported, its reason under mode=probe.
	s.probe(context.Background(), probeSpec{endpoint: EndpointAsPosts, run: func(*Server, context.Context, ProbeRequest, *hydrate.PresenceProbe) error {
		return fallback.New("input-sort")
	}}, req)
	if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeUnsupported)); n != 1 {
		t.Errorf("unsupported = %v, want 1", n)
	}
	if n := goFirst(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "probe", "reason": "input-sort"}); n != 1 {
		t.Errorf("fallback{mode=probe,reason=input-sort} = %v, want 1", n)
	}

	// A hydrator with no presence check (never in production): error, nothing run.
	ran := false
	s.Deps.Hydrator = struct{ feed.Hydrator }{}
	s.probe(context.Background(), probeSpec{endpoint: EndpointAsPosts, run: func(*Server, context.Context, ProbeRequest, *hydrate.PresenceProbe) error {
		ran = true
		return nil
	}}, req)
	if ran || goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeError)) != 2 {
		t.Errorf("no presence check: ran=%v error=%v, want not run and error 2", ran, goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeError)))
	}
}

// probeDeps swaps the hydrator and makes the query cache read-only on a COPY: the serving deps are
// untouched.
func TestProbeDepsCopies(t *testing.T) {
	cache := &feed.QueryCache{Enabled: true}
	d := &feed.Deps{Cache: cache}
	rec := &hydrate.PresenceProbe{}
	pd := probeDeps(d, rec)
	if pd.Hydrator != rec || !pd.Cache.ReadOnly || !pd.Cache.Enabled {
		t.Fatalf("probe deps %+v (cache %+v)", pd, pd.Cache)
	}
	if d.Hydrator != nil || cache.ReadOnly || d.Cache != cache {
		t.Fatal("probeDeps changed the serving deps")
	}
	if probeDeps(&feed.Deps{}, rec).Cache != nil {
		t.Fatal("no query cache must stay none")
	}
}

// A probe holding its queue slot makes an overlapping shadow phase not solo: the probe's work lands
// in process CPU like a sample's (DESIGN.md §10.1).
func TestShadowPhaseNotSoloWhileAProbeRuns(t *testing.T) {
	if _, ok := processCPU(); !ok {
		t.Skip("no process CPU clock on this platform")
	}
	reg := prometheus.NewRegistry()
	entered, release := make(chan struct{}), make(chan struct{})
	s := newPhaseServer(reg, 1, func(context.Context, *http.Request) (*computed, error) {
		close(entered)
		<-release
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	s.ProbeQueue = make(chan struct{}, 1)
	post(t, s, "A")
	<-entered
	s.ProbeQueue <- struct{}{} // a probe running across the end of A's compute
	close(release)
	waitFor(t, "A's compute to end", func() bool {
		n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", phaseLabels("compute", "served"))
		return n == 1
	})
	<-s.ProbeQueue
	waitFor(t, "A to finish", func() bool {
		v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_total", phaseLabels("compute", "served")); n != 0 {
		t.Errorf("compute solo = %v with a probe in flight, want 0", n)
	}
	// Positive control: decode ran before the probe and is solo.
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_solo_total", phaseLabels("decode", "ok")); n != 1 {
		t.Errorf("decode solo = %v, want 1", n)
	}
}

func TestInternalMuxRoutesProbes(t *testing.T) {
	env, fx, _ := probeEnv(t)
	mux := InternalMux(env.server, http.NotFoundHandler(), false)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/probe/nope", probeBody(t, fx, env.headers, 0)))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown probe through the mux: %d, want 404", w.Code)
	}
}
