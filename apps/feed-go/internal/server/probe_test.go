package server

import (
	"context"
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
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

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

// runGoldenProbe runs the as-posts probe of fx's request on env, synchronously, and classifies it.
func runGoldenProbe(t *testing.T, env *goldenEnv, fx *goldenFixture) (string, []string, error) {
	t.Helper()
	checker, ok := env.server.Deps.Hydrator.(hydrate.PresenceChecker)
	if !ok {
		t.Fatal("the golden hydrator has no presence check")
	}
	rec := &hydrate.PresenceProbe{Checker: checker}
	err := env.server.probeAsPosts(context.Background(), ProbeRequest{Input: fx.Request.Input, Headers: env.headers}, rec)
	result, missed := classifyProbe(err, rec.Misses())
	return result, missed, err
}

// missReasonCache is the cache a serving fallback reason is a miss on ("" for any other reason): the
// page caches' Reasons and the pre-hydration ones.
func missReasonCache(reason string) string {
	if c := preHydrateMissReasons[reason]; c != "" {
		return c
	}
	for _, c := range hydrate.PageCaches {
		if c.Reason != "" && c.Reason == reason {
			return c.Name
		}
	}
	return ""
}

// The probe over every golden as-posts request, against what serving does with the same request:
// a served fixture is would_serve, with the feed service asked exactly the queries Node sends (the
// page ids are resolved as serving resolves them); a fixture serving falls back on with a cache-miss
// reason is would_miss on that cache; any other fallback is unsupported. Never a write.
func TestProbeGoldenAsPosts(t *testing.T) {
	seen := map[string]int{}
	for _, path := range goldenFiles(t, "as-posts", goldenMinAsPosts) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) {
			env := goldenSetup(t, fx)
			cache := goldenCache(t, env)
			before := cacheState(cache)
			result, missed, err := runGoldenProbe(t, env, fx)
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
				env.feed.check(t, true)
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
	// Positive control: the fixtures reached all three outcomes.
	for _, r := range []string{ProbeWouldServe, ProbeWouldMiss, ProbeUnsupported} {
		if seen[r] == 0 {
			t.Errorf("no fixture probed %s: %v", r, seen)
		}
	}
}

// goldenKeyCache is the cache a golden Redis key belongs to ("" for keys the probe does not report).
var goldenPerIDKey = regexp.MustCompile(`^(.*):(\d+)$`)

func goldenKeyCache(key string) string {
	m := goldenPerIDKey.FindStringSubmatch(key)
	if m == nil {
		return ""
	}
	switch m[1] {
	case "session:data2":
		return CacheSessionUser
	case "model:gallery-settings":
		return CacheGallerySettings
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
	missCompared := map[string]int{}
	serveCompared := map[string]int{}
	for _, path := range goldenFiles(t, "as-posts", goldenMinAsPosts) {
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
				cold.Redis = map[string]goldenRedisEntry{}
				for k, v := range fx.Redis {
					if !slices.Contains(keys, k) {
						cold.Redis[k] = v
					}
				}
				served := goldenSetup(t, &cold)
				r, err := SyntheticRequest(context.Background(), ShadowRequest{Input: cold.Request.Input, Headers: served.headers})
				if err != nil {
					t.Fatal(err)
				}
				_, serveErr := served.server.compute(context.Background(), r)
				result, missed, probeErr := runGoldenProbe(t, goldenSetup(t, &cold), &cold)
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
	// Go fills from the replica (else the would_serve arm proves nothing).
	for _, c := range []string{CacheSessionUser, CacheGallerySettings, hydrate.CacheUserCosmetics, hydrate.CacheImageFrames,
		hydrate.CacheTagIDs, hydrate.CacheEventDecorations, hydrate.CacheMetrics} {
		if missCompared[c] == 0 {
			t.Errorf("no golden request compared a %s miss (compared: %v)", c, missCompared)
		}
	}
	if serveCompared[hydrate.CacheBasicUsers] == 0 {
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
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result, missed := classifyProbe(c.err, c.misses)
			if result != c.wantResult || !reflect.DeepEqual(missed, c.wantMissed) {
				t.Fatalf("classifyProbe = %s %v, want %s %v", result, missed, c.wantResult, c.wantMissed)
			}
		})
	}
}

func TestObserveLag(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	at := time.UnixMilli(1_700_000_000_200)
	observeLag(m.GoFirstReceiptLag, EndpointAsPosts, at, 1_700_000_000_000) // 200ms after
	observeLag(m.GoFirstReceiptLag, EndpointAsPosts, at, 1_700_000_000_400) // a clock 150ms ahead: 0
	observeLag(m.GoFirstReceiptLag, EndpointAsPosts, at, 0)                 // unknown start: nothing
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_gofirst_receipt_lag_seconds" {
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
	t.Fatal("no receipt-lag histogram")
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
// its result, its misses and both lag histograms recorded.
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
	if n := goFirst(t, reg, "feed_go_gofirst_receipt_lag_seconds", ep); n != 1 {
		t.Errorf("receipt lag observations %v, want 1", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_check_lag_seconds", ep); n != 1 {
		t.Errorf("check lag observations %v, want 1 (the page was checked)", n)
	}
	for _, r := range []string{ProbeWouldMiss, ProbeUnsupported, ProbeError} {
		if n := goFirst(t, reg, "feed_go_gofirst_total", resultLabels(r)); n != 0 {
			t.Errorf("%s = %v, want 0", r, n)
		}
	}
	if err := env.server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	// A cold tag-ids cache: would_miss, the miss counted on its cache, and the probe's reason-free
	// end (no fallback was raised: the recorder never falls back).
	env, fx, reg = probeEnv(t)
	cache := goldenCache(t, env)
	for _, k := range cache.AllKeys() {
		if strings.HasPrefix(k, hydrate.KeyTagIDs+":") {
			cache.SetString(k, []byte{0xc1}) // undecodable: a miss, as an absent key
		}
	}
	w = httptest.NewRecorder()
	env.server.ProbeHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ProbePathPrefix+Procedure, probeBody(t, fx, env.headers, 0)))
	waitFor(t, "the probe to finish", func() bool {
		return goFirst(t, reg, "feed_go_gofirst_total", resultLabels(ProbeWouldMiss)) == 1 && len(env.server.ProbeQueue) == 0
	})
	if n := goFirst(t, reg, "feed_go_gofirst_miss_total", map[string]string{"feed_endpoint": EndpointAsPosts, "cache": hydrate.CacheTagIDs}); n != 1 {
		t.Errorf("tag-ids misses %v, want 1 (one probe)", n)
	}
	if n := goFirst(t, reg, "feed_go_gofirst_receipt_lag_seconds", map[string]string{"feed_endpoint": EndpointAsPosts}); n != 0 {
		t.Errorf("receipt lag observed %v times with no startedAt, want 0", n)
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
	if c := call(http.MethodPost, ProbePathPrefix+"model.getAll", strings.NewReader("{}")); c != http.StatusNotFound {
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
