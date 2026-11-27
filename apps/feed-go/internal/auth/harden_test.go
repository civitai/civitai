package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// switchableJWKS serves whichever keys are current, or a status/body failure when set.
type switchableJWKS struct {
	mu      sync.Mutex
	keys    []keyPair
	status  int    // 0 = 200
	body    string // "" = the key set
	fetches atomic.Int32
}

func (s *switchableJWKS) set(keys ...keyPair) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys, s.status, s.body = keys, 0, ""
}

func (s *switchableJWKS) fail(status int, body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status, s.body = status, body
}

func (s *switchableJWKS) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	s.fetches.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status != 0 {
		w.WriteHeader(s.status)
	}
	if s.body != "" {
		_, _ = w.Write([]byte(s.body))
		return
	}
	set := []map[string]string{}
	for _, k := range s.keys {
		set = append(set, k.jwk())
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": set})
}

func newSwitchable(t *testing.T, keys ...keyPair) (*switchableJWKS, *httptest.Server) {
	t.Helper()
	j := &switchableJWKS{}
	j.set(keys...)
	srv := httptest.NewServer(j)
	t.Cleanup(srv.Close)
	return j, srv
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A signing key the hub removes stops verifying after the next periodic refresh, without a restart.
// Before Run existed the cached key stayed trusted for the process lifetime: only an unknown kid
// refetched the set.
func TestRunDropsARemovedSigningKey(t *testing.T) {
	now := time.Now()
	k1, k2 := newKey(t, "k1"), newKey(t, "k2")
	j, srv := newSwitchable(t, k1, k2)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return now },
		RefreshInterval: 20 * time.Millisecond, MinRefetch: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { v.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	waitUntil(t, "the warm-up fetch to load the set", func() bool {
		v.mu.RLock()
		defer v.mu.RUnlock()
		return len(v.keys) == 2
	})
	tok := sign(t, k2, "ES256", baseClaims(now))
	if _, err := v.Verify(context.Background(), tok); err != nil {
		t.Fatalf("k2 token rejected while k2 is published: %v", err)
	}
	j.set(k1) // the hub retires k2
	base := j.fetches.Load()
	waitUntil(t, "two more refreshes", func() bool { return j.fetches.Load() >= base+2 })
	if _, err := v.Verify(context.Background(), tok); err == nil {
		t.Fatal("a token signed by a removed key still verifies after the refresh")
	}
	if _, err := v.Verify(context.Background(), sign(t, k1, "ES256", baseClaims(now))); err != nil {
		t.Fatalf("k1 token rejected: %v", err)
	}
}

// A failing refresh keeps the last good key set and retries with a growing delay, reporting each
// failure through OnRefresh.
func TestRunKeepsTheLastGoodSetAndBacksOff(t *testing.T) {
	now := time.Now()
	k1 := newKey(t, "k1")
	j, srv := newSwitchable(t, k1)
	var mu sync.Mutex
	var results []error
	var times []time.Time
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return now },
		RefreshInterval: time.Hour, RetryMin: 40 * time.Millisecond, MinRefetch: time.Hour,
		OnRefresh: func(err error) {
			mu.Lock()
			defer mu.Unlock()
			results = append(results, err)
			times = append(times, time.Now())
		}}
	// Load k1 first, then break the hub before Run's first fetch.
	if err := v.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	j.fail(http.StatusBadGateway, "upstream down")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { v.Run(ctx); close(done) }()
	waitUntil(t, "three failed refreshes", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(results) >= 3
	})
	cancel()
	<-done

	mu.Lock()
	defer mu.Unlock()
	for i, err := range results[:3] {
		if err == nil || !strings.Contains(err.Error(), "status 502") {
			t.Fatalf("refresh %d: err = %v, want the 502", i, err)
		}
	}
	// Run's first fetch is immediate; the retries wait 40 ms, then 80 ms. With a fixed 40 ms (no
	// backoff) the second gap would also be ~40 ms.
	if gap := times[2].Sub(times[1]); gap < 70*time.Millisecond {
		t.Fatalf("second retry came %v after the first, want ≥ 80 ms (doubling)", gap)
	}
	if _, err := v.Verify(context.Background(), sign(t, k1, "ES256", baseClaims(now))); err != nil {
		t.Fatalf("the last good key set was dropped by a failed refresh: %v", err)
	}
}

func TestBackoffAndJitterBounds(t *testing.T) {
	cases := []struct {
		failures int
		want     time.Duration
	}{{1, 5 * time.Second}, {2, 10 * time.Second}, {3, 20 * time.Second}, {8, 10 * time.Minute}, {40, 10 * time.Minute}}
	for _, c := range cases {
		if got := backoff(5*time.Second, 10*time.Minute, c.failures); got != c.want {
			t.Errorf("backoff(%d failures) = %v, want %v", c.failures, got, c.want)
		}
	}
	lo, hi := 9*time.Minute, 11*time.Minute
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		d := jitter(10 * time.Minute)
		if d < lo || d >= hi {
			t.Fatalf("jitter = %v, want within [%v, %v)", d, lo, hi)
		}
		seen[d] = true
	}
	if len(seen) < 2 {
		t.Fatal("jitter returned one value 200 times: it does not spread")
	}
}

// refresh's error paths: each fails, and none replaces the key set already held.
func TestRefreshErrorPathsKeepTheKeySet(t *testing.T) {
	now := time.Now()
	k1 := newKey(t, "k1")
	j, srv := newSwitchable(t, k1)
	v := &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return now },
		FetchTimeout: 100 * time.Millisecond}
	if err := v.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	good := sign(t, k1, "ES256", baseClaims(now))
	check := func(name, wantErr string) {
		t.Helper()
		err := v.refresh(context.Background())
		if err == nil || !strings.Contains(err.Error(), wantErr) {
			t.Fatalf("%s: err = %v, want one containing %q", name, err, wantErr)
		}
		v.mu.RLock()
		_, kept := v.keys["k1"]
		v.mu.RUnlock()
		if !kept {
			t.Fatalf("%s: the key set was replaced by a failed refresh", name)
		}
	}
	j.fail(http.StatusInternalServerError, "oops")
	check("5xx", "jwks: status 500")
	j.fail(0, "{not json")
	check("undecodable body", "invalid character")
	j.fail(0, `{"keys":[{"kty":"RSA","kid":"r1","n":"x","e":"AQAB"}]}`)
	check("no usable key", "no usable signing keys")

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer slow.Close()
	v.JWKSURL, v.HTTP = slow.URL, slow.Client()
	check("timeout", "context deadline exceeded")

	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()
	v.JWKSURL, v.HTTP = closedURL, &http.Client{}
	check("connection refused", "connect")

	v.JWKSURL = "http://[::1]:namedport"
	check("bad url", "invalid port")

	// The held set still verifies after all of it.
	if _, err := v.Verify(context.Background(), good); err != nil {
		t.Fatalf("held key no longer verifies: %v", err)
	}
}

// ---- Revocation.IsRevoked against the fake system redis ----

func revocationClaims() *Claims {
	signed := float64(1_700_000_000_000)
	imp := float64(77)
	return &Claims{Sub: json.RawMessage(`"42"`), Jti: "tok-1", Sid: "fam-1", SignedAt: &signed, ImpersonatedBy: &imp}
}

func TestIsRevokedReadsTheRegistry(t *testing.T) {
	cases := []struct {
		name string
		seed func(r *testkit.Redis)
		want bool
	}{
		{"nothing recorded", func(*testkit.Redis) {}, false},
		{"token invalid", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"}) }, true},
		{"another token invalid", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-2": "invalid"}) }, false},
		{"family invalid", func(r *testkit.Redis) { r.SetHash("session:family-state", map[string]string{"fam-1": "invalid"}) }, true},
		{"sign-out-all after signing", func(r *testkit.Redis) { r.SetString("session:all", []byte("2023-11-14T22:13:20.001Z")) }, true},
		{"sign-out-all before signing", func(r *testkit.Redis) { r.SetString("session:all", []byte("2023-11-14T22:13:19.999Z")) }, false},
		{"user cut after signing", func(r *testkit.Redis) { r.SetString("session:user-cut:42", []byte("1700000000001")) }, true},
		{"other user's cut", func(r *testkit.Redis) { r.SetString("session:user-cut:43", []byte("1700000000001")) }, false},
		{"impersonator's user cut", func(r *testkit.Redis) { r.SetString("session:user-cut:77", []byte("1700000000001")) }, true},
		{"impersonator cut", func(r *testkit.Redis) { r.SetString("session:user-cut:impersonator:77", []byte("1700000000001")) }, true},
	}
	for _, c := range cases {
		r := testkit.NewRedis()
		c.seed(r)
		failedOpen := false
		rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: func(error, string) { failedOpen = true }}
		if got := rev.IsRevoked(context.Background(), revocationClaims()); got != c.want {
			t.Errorf("%s: IsRevoked = %v, want %v", c.name, got, c.want)
		}
		if failedOpen {
			t.Errorf("%s: absent keys (redis.Nil) were reported as a failed read", c.name)
		}
		if r.Calls != 1 {
			t.Errorf("%s: %d round trips, want 1 pipelined", c.name, r.Calls)
		}
	}
}

// degradedRecorder collects OnDegraded calls.
type degradedRecorder struct {
	errs     []error
	verdicts []string
}

func (d *degradedRecorder) report(err error, verdict string) {
	d.errs = append(d.errs, err)
	d.verdicts = append(d.verdicts, verdict)
}

func (d *degradedRecorder) only(t *testing.T, name, wantVerdict, wantErr string) {
	t.Helper()
	if len(d.verdicts) != 1 || d.verdicts[0] != wantVerdict {
		t.Errorf("%s: verdicts %v, want exactly [%s]", name, d.verdicts, wantVerdict)
		return
	}
	if d.errs[0] == nil || !strings.Contains(d.errs[0].Error(), wantErr) {
		t.Errorf("%s: reported error %v, want one containing %q", name, d.errs[0], wantErr)
	}
}

// createRevocationCheck's degraded verdict: a revocation marker this process has already read still
// denies when the next read fails (deny_cached), for every marker the registry reads, whether the read
// failed outright or ran past the deadline.
func TestIsRevokedDeniesASeenRevocationWhenTheReadFails(t *testing.T) {
	markers := []struct {
		name string
		seed func(r *testkit.Redis)
	}{
		{"token invalid", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"}) }},
		{"family invalid", func(r *testkit.Redis) { r.SetHash("session:family-state", map[string]string{"fam-1": "invalid"}) }},
		{"sign-out-all after signing", func(r *testkit.Redis) { r.SetString("session:all", []byte("2023-11-14T22:13:20.001Z")) }},
		{"user cut after signing", func(r *testkit.Redis) { r.SetString("session:user-cut:42", []byte("1700000000001")) }},
		{"impersonator's user cut", func(r *testkit.Redis) { r.SetString("session:user-cut:77", []byte("1700000000001")) }},
		{"impersonator cut", func(r *testkit.Redis) { r.SetString("session:user-cut:impersonator:77", []byte("1700000000001")) }},
	}
	failures := []struct {
		name    string
		fail    func(r *testkit.Redis)
		timeout time.Duration
		wantErr string
	}{
		{"store down", func(r *testkit.Redis) { r.Err = testkit.ErrDown }, 0, "down"},
		{"store slower than the read timeout", func(r *testkit.Redis) { r.Delay = time.Second }, 20 * time.Millisecond, "deadline exceeded"},
	}
	for _, m := range markers {
		for _, f := range failures {
			name := m.name + " / " + f.name
			r := testkit.NewRedis()
			m.seed(r)
			var d degradedRecorder
			rev := &Revocation{Redis: r, Timeout: f.timeout, Markers: NewMarkerCache(0), OnDegraded: d.report}
			if !rev.IsRevoked(context.Background(), revocationClaims()) {
				t.Fatalf("%s: the healthy read did not revoke, so this case tests nothing", name)
			}
			f.fail(r)
			start := time.Now()
			if !rev.IsRevoked(context.Background(), revocationClaims()) {
				t.Errorf("%s: a revocation already read was allowed when the read failed, want deny_cached", name)
			}
			if el := time.Since(start); el > 500*time.Millisecond {
				t.Errorf("%s: took %v, the read timeout did not bound it", name, el)
			}
			d.only(t, name, VerdictDenyCached, f.wantErr)
		}
	}
}

// A session with no known marker is allowed when the read fails (allow_unknown): the record is not a
// replica, and signing everyone out during a store outage is not the policy. That includes a marker for
// ANOTHER token or user, and a cut-off older than the token.
func TestIsRevokedAllowsAnUnknownSessionWhenTheReadFails(t *testing.T) {
	cases := []struct {
		name string
		seed func(r *testkit.Redis)
	}{
		{"nothing read before", func(*testkit.Redis) {}},
		{"another token invalid", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-2": "invalid"}) }},
		{"other user's cut", func(r *testkit.Redis) { r.SetString("session:user-cut:43", []byte("1700000000001")) }},
		{"sign-out-all before signing", func(r *testkit.Redis) { r.SetString("session:all", []byte("2023-11-14T22:13:19.999Z")) }},
		{"refresh marker (not a revocation)", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-1": "refresh"}) }},
	}
	for _, c := range cases {
		r := testkit.NewRedis()
		c.seed(r)
		var d degradedRecorder
		rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report}
		other := revocationClaims()
		other.Jti, other.Sub = "tok-2", json.RawMessage(`"43"`)
		// The other token's read, so its marker (when seeded) is in the record.
		rev.IsRevoked(context.Background(), other)
		if rev.IsRevoked(context.Background(), revocationClaims()) {
			t.Fatalf("%s: revoked on a healthy read, so this case tests nothing", c.name)
		}
		r.Err = testkit.ErrDown
		if rev.IsRevoked(context.Background(), revocationClaims()) {
			t.Errorf("%s: revoked with no known marker for this session, want allow_unknown", c.name)
		}
		d.only(t, c.name, VerdictAllowUnknown, "down")
	}
}

// SESSION_REVOCATION_CACHE=off (Markers nil) is the package's `markerCache: false`: nothing is recorded,
// so even a revocation read moments ago is allowed once the read fails.
func TestIsRevokedWithoutTheRecordFailsOpen(t *testing.T) {
	r := testkit.NewRedis()
	r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"})
	var d degradedRecorder
	rev := &Revocation{Redis: r, OnDegraded: d.report}
	if !rev.IsRevoked(context.Background(), revocationClaims()) {
		t.Fatal("the healthy read did not revoke")
	}
	r.Err = testkit.ErrDown
	if rev.IsRevoked(context.Background(), revocationClaims()) {
		t.Error("revoked with the record off, want the plain fail-open")
	}
	d.only(t, "record off", VerdictAllowUnknown, "down")
}

// The record follows the store: a later read that finds the marker gone (or a token-state that is not
// `invalid`) deletes the entry, so the next failed read no longer denies.
func TestMarkerRecordFollowsTheStore(t *testing.T) {
	for _, c := range []struct {
		name  string
		clear func(r *testkit.Redis)
	}{
		{"marker removed", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{}) }},
		{"marker replaced by refresh", func(r *testkit.Redis) { r.SetHash("session:token-state", map[string]string{"tok-1": "refresh"}) }},
	} {
		r := testkit.NewRedis()
		r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"})
		var d degradedRecorder
		rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report}
		if !rev.IsRevoked(context.Background(), revocationClaims()) {
			t.Fatalf("%s: the healthy read did not revoke", c.name)
		}
		c.clear(r)
		if rev.IsRevoked(context.Background(), revocationClaims()) {
			t.Fatalf("%s: revoked after the store dropped the marker", c.name)
		}
		r.Err = testkit.ErrDown
		if rev.IsRevoked(context.Background(), revocationClaims()) {
			t.Errorf("%s: the record kept a marker the store no longer has", c.name)
		}
		d.only(t, c.name, VerdictAllowUnknown, "down")
	}
}

// One shard failing in the round trip that READ the marker: the package records each command as it
// resolves, so the marker read alongside the failed command still denies.
func TestIsRevokedPartialFailureStillAppliesTheMarkerItRead(t *testing.T) {
	r := testkit.NewRedis()
	r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"})
	r.KeyErr = func(key string) error {
		if key == "session:all" {
			return testkit.ErrDown
		}
		return nil
	}
	var d degradedRecorder
	rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report}
	if !rev.IsRevoked(context.Background(), revocationClaims()) {
		t.Error("the token-state marker read in the same round trip as a failed command was allowed")
	}
	d.only(t, "partial failure", VerdictDenyCached, "down")
}

// Pipelined reports only the FIRST command error, and an absent key is one: a user-cut read that fails
// after the token-state read found nothing must still be a failed read, answered from the record, not a
// healthy read of "no cut" that lets the session through.
func TestIsRevokedFailedCommandBehindAnAbsentOneIsAFailedRead(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("session:user-cut:42", []byte("1700000000001"))
	var d degradedRecorder
	rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report}
	if !rev.IsRevoked(context.Background(), revocationClaims()) {
		t.Fatal("the healthy read did not revoke")
	}
	r.KeyErr = func(key string) error {
		if key == "session:user-cut:42" {
			return testkit.ErrDown
		}
		return nil
	}
	// token-state (first in the pipeline) answers redis.Nil, so Pipelined's own error is redis.Nil.
	if !rev.IsRevoked(context.Background(), revocationClaims()) {
		t.Error("a failed user-cut read behind an absent token state was read as no cut")
	}
	d.only(t, "nil then failure", VerdictDenyCached, "down")
}

// In a failed round trip go-redis can leave a command with no error and no value without having
// answered it; that must not count as a read, or it would delete a marker the record holds.
func TestObservedIgnoresAnUnansweredCommandInAFailedBatch(t *testing.T) {
	unanswered := redis.NewStringCmd(context.Background(), "get", "k")
	if got := observed(unanswered, true); got.ok {
		t.Error("an unanswered command in a failed batch was taken as an answer")
	}
	if got := observed(unanswered, false); got != (reply{ok: true, present: true}) {
		t.Errorf("an empty value in a successful batch = %+v, want an answered empty value", got)
	}
	if got := observed(redis.NewStringResult("", redis.Nil), true); got != (reply{ok: true}) {
		t.Errorf("a nil reply in a failed batch = %+v, want answered and absent", got)
	}
	if got := observed(redis.NewStringResult("tok", nil), true); got != (reply{value: "tok", ok: true, present: true}) {
		t.Errorf("a value in a failed batch = %+v, want answered", got)
	}
	if got := observed(redis.NewStringResult("", testkit.ErrDown), false); got.ok {
		t.Error("a failed command was taken as an answer")
	}
}

// The record's bound is REVOCATION_MARKER_CACHE_MAX_ENTRIES, least recently used evicted first (a lookup
// counts as a use); there is no time-based expiry.
func TestMarkerCacheBoundIsLeastRecentlyUsed(t *testing.T) {
	if MarkerCacheMaxEntries != 20_000 {
		t.Fatalf("MarkerCacheMaxEntries = %d, want 20000 (REVOCATION_MARKER_CACHE_MAX_ENTRIES)", MarkerCacheMaxEntries)
	}
	if got := NewMarkerCache(0).max; got != 20_000 {
		t.Fatalf("default bound = %d, want 20000", got)
	}
	m := NewMarkerCache(3)
	m.record("a", "1", true)
	m.record("b", "2", true)
	m.record("c", "3", true)
	if m.lookup("a") != "1" { // a becomes the most recently used; b is now the oldest
		t.Fatal("a missing")
	}
	m.record("d", "4", true)
	if m.Len() != 3 {
		t.Fatalf("len = %d, want 3 (bounded)", m.Len())
	}
	if m.lookup("b") != "" {
		t.Error("b (least recently used) was kept past the bound")
	}
	for _, k := range []string{"a", "c", "d"} {
		if m.lookup(k) == "" {
			t.Errorf("%s evicted, want only b evicted", k)
		}
	}
	m.record("c", "", false) // an absent read deletes
	if m.lookup("c") != "" || m.Len() != 2 {
		t.Errorf("an absent read did not delete the entry (len %d)", m.Len())
	}
}

// The bound applies to what the check records: with room for one entry, the second revoked token read
// evicts the first, which a failed read then allows (as the package's record would).
func TestIsRevokedRecordBoundEvictsTheOldestMarker(t *testing.T) {
	r := testkit.NewRedis()
	r.SetHash("session:token-state", map[string]string{"tok-1": "invalid", "tok-2": "invalid"})
	var d degradedRecorder
	rev := &Revocation{Redis: r, Markers: NewMarkerCache(1), OnDegraded: d.report}
	first := revocationClaims()
	first.ImpersonatedBy, first.Sid = nil, ""
	second := revocationClaims()
	second.ImpersonatedBy, second.Sid, second.Jti = nil, "", "tok-2"
	// No user-cut or sign-out-all values are seeded, so the only entries recorded are the two tokens.
	rev.IsRevoked(context.Background(), first)
	rev.IsRevoked(context.Background(), second)
	r.Err = testkit.ErrDown
	if rev.IsRevoked(context.Background(), first) {
		t.Error("the evicted marker still denied")
	}
	if !rev.IsRevoked(context.Background(), second) {
		t.Error("the marker held within the bound did not deny")
	}
	if len(d.verdicts) != 2 || d.verdicts[0] != VerdictAllowUnknown || d.verdicts[1] != VerdictDenyCached {
		t.Errorf("verdicts %v, want [allow_unknown deny_cached]", d.verdicts)
	}
}

func TestIsRevokedWithoutJtiReadsNothing(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("session:user-cut:42", []byte("9999999999999"))
	c := revocationClaims()
	c.Jti = ""
	if (&Revocation{Redis: r}).IsRevoked(context.Background(), c) || r.Calls != 0 {
		t.Fatalf("no jti: want not revoked and no read, got %d round trips", r.Calls)
	}
}

// ---- Resolver.Resolve end to end over the fakes ----

type resolveFixture struct {
	now      time.Time
	key      keyPair
	cache    *testkit.Redis
	sys      *testkit.Redis
	r        *Resolver
	reports  []error
	verdicts []string
}

func newResolveFixture(t *testing.T) *resolveFixture {
	t.Helper()
	f := &resolveFixture{now: time.Now(), key: newKey(t, "k1"), cache: testkit.NewRedis(), sys: testkit.NewRedis()}
	_, srv := newSwitchable(t, f.key)
	f.r = &Resolver{
		Verifier: &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return f.now }},
		Revocation: &Revocation{Redis: f.sys, Markers: NewMarkerCache(0), OnDegraded: func(err error, verdict string) {
			f.reports = append(f.reports, err)
			f.verdicts = append(f.verdicts, verdict)
		}},
		Sessions:    &hydrate.PackedReader{Redis: f.cache, Prefix: "ns:"},
		CookieNames: FixedCookieNames("__Secure-civ-token", "__Host-civ-token"),
	}
	return f
}

func (f *resolveFixture) session(t *testing.T, id int, v map[string]any) {
	t.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	f.cache.SetString("ns:session:data2:"+strconv.Itoa(id), b)
}

func (f *resolveFixture) token(t *testing.T, mut func(map[string]any)) string {
	t.Helper()
	c := baseClaims(f.now)
	if mut != nil {
		mut(c)
	}
	return sign(t, f.key, "ES256", c)
}

func request(headers map[string]string, target string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestResolve(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a", "isModerator": true})
	f.session(t, 43, map[string]any{"id": 43, "username": "viewer-b", "bannedAt": time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)})
	good := f.token(t, nil)
	banned := f.token(t, func(m map[string]any) { m["sub"] = "43"; m["jti"] = "tok-43" })
	unknownUser := f.token(t, func(m map[string]any) { m["sub"] = "44"; m["jti"] = "tok-44" })
	revoked := f.token(t, func(m map[string]any) { m["jti"] = "tok-revoked" })
	f.sys.SetHash("session:token-state", map[string]string{"tok-revoked": "invalid"})
	f.session(t, 60, map[string]any{"id": 60, "username": "memorialized-c", "memorialized": true})
	f.session(t, 61, map[string]any{"id": 61, "username": "viewer-d", "memorialized": false})
	memorialized := f.token(t, func(m map[string]any) { m["sub"] = "60"; m["jti"] = "tok-60" })
	impersonatingMemorialized := f.token(t, func(m map[string]any) {
		m["sub"], m["jti"] = "60", "tok-60-imp"
		m["impersonatedBy"], m["impExp"] = 7, f.now.Add(time.Hour).UnixMilli()
	})
	notMemorialized := f.token(t, func(m map[string]any) { m["sub"] = "61"; m["jti"] = "tok-61" })

	type want struct {
		id        int
		moderator bool
		banned    bool
		reason    string // fallback reason; "" with id 0 = signed out
	}
	cases := []struct {
		name    string
		headers map[string]string
		target  string
		want    want
	}{
		{"no cookie", nil, "/x", want{}},
		{"bearer", map[string]string{"Authorization": "Bearer abc"}, "/x", want{reason: "bearer-token"}},
		{"api key query token", nil, "/x?token=abc", want{reason: "bearer-token"}},
		{"bearer wins over a valid cookie", map[string]string{"Authorization": "Bearer abc", "Cookie": "__Secure-civ-token=" + good}, "/x", want{reason: "bearer-token"}},
		{"shared-slot cookie", map[string]string{"Cookie": "a=1; __Secure-civ-token=" + good}, "/x", want{id: 42, moderator: true}},
		{"host-slot cookie", map[string]string{"Cookie": "__Host-civ-token=" + good}, "/x", want{id: 42, moderator: true}},
		{"both slots: the first name read wins", map[string]string{"Cookie": "__Secure-civ-token=" + good + "; __Host-civ-token=not.a.token"}, "/x", want{id: 42, moderator: true}},
		{"unconfigured cookie name ignored", map[string]string{"Cookie": "civ-token=" + good}, "/x", want{}},
		{"invalid token", map[string]string{"Cookie": "__Secure-civ-token=not.a.token"}, "/x", want{}},
		{"expired token", map[string]string{"Cookie": "__Secure-civ-token=" + f.token(t, func(m map[string]any) { m["exp"] = f.now.Add(-time.Minute).Unix() })}, "/x", want{}},
		{"revoked", map[string]string{"Cookie": "__Secure-civ-token=" + revoked}, "/x", want{}},
		{"banned", map[string]string{"Cookie": "__Secure-civ-token=" + banned}, "/x", want{id: 43, banned: true}},
		{"memorialized", map[string]string{"Cookie": "__Secure-civ-token=" + memorialized}, "/x", want{}},
		{"memorialized, impersonated by a moderator", map[string]string{"Cookie": "__Secure-civ-token=" + impersonatingMemorialized}, "/x", want{id: 60}},
		{"memorialized false", map[string]string{"Cookie": "__Secure-civ-token=" + notMemorialized}, "/x", want{id: 61}},
		{"session miss", map[string]string{"Cookie": "__Secure-civ-token=" + unknownUser}, "/x", want{reason: "session-cache-miss"}},
	}
	for _, c := range cases {
		u, err := f.r.Resolve(context.Background(), request(c.headers, c.target))
		reason := fallback.Reason(err)
		if err != nil && reason == "" {
			t.Errorf("%s: non-fallback error %v", c.name, err)
			continue
		}
		if reason != c.want.reason {
			t.Errorf("%s: fallback %q, want %q", c.name, reason, c.want.reason)
			continue
		}
		if c.want.id == 0 {
			if u != nil {
				t.Errorf("%s: user %+v, want signed out", c.name, u)
			}
			continue
		}
		if u == nil || u.ID != c.want.id || u.IsModerator != c.want.moderator || u.Banned != c.want.banned {
			t.Errorf("%s: user %+v, want %+v", c.name, u, c.want)
		}
	}
	if len(f.reports) != 0 {
		t.Fatalf("revocation failed open %d times on a healthy store: %v", len(f.reports), f.reports)
	}
}

// A sysredis outage keeps a valid session with no known revocation signed in (allow_unknown), as the
// app does.
func TestResolveRevocationOutageAllowsAnUnknownSession(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a"})
	f.sys.Err = testkit.ErrDown
	u, err := f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=" + f.token(t, nil)}, "/x"))
	if err != nil || u == nil || u.ID != 42 {
		t.Fatalf("got %+v, %v; want user 42", u, err)
	}
	if len(f.reports) != 1 || !errors.Is(f.reports[0], testkit.ErrDown) || f.verdicts[0] != VerdictAllowUnknown {
		t.Fatalf("degraded reports = %v %v, want the one outage with allow_unknown", f.reports, f.verdicts)
	}
}

// ...but a token this process has already seen revoked stays signed out through the outage
// (deny_cached), as the app's createRevocationCheck does.
func TestResolveRevocationOutageKeepsASeenRevocationSignedOut(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a"})
	tok := f.token(t, func(m map[string]any) { m["jti"] = "tok-revoked" })
	f.sys.SetHash("session:token-state", map[string]string{"tok-revoked": "invalid"})
	req := func() (*SessionUser, error) {
		return f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=" + tok}, "/x"))
	}
	if u, err := req(); err != nil || u != nil {
		t.Fatalf("healthy store: got %+v, %v; want signed out", u, err)
	}
	f.sys.Err = testkit.ErrDown
	if u, err := req(); err != nil || u != nil {
		t.Fatalf("outage: got %+v, %v; want signed out (deny_cached)", u, err)
	}
	if len(f.verdicts) != 1 || f.verdicts[0] != VerdictDenyCached {
		t.Fatalf("verdicts %v, want [deny_cached]", f.verdicts)
	}
}

// Mod Lead ruling 2026-11-27: a moderator or impersonation session whose revocation read failed is not
// answered here; the Node path decides it (retry once after a fast error, else refuse the request).
func TestResolveRevocationOutageHandsAnElevatedSessionToNode(t *testing.T) {
	cases := []struct {
		name string
		user map[string]any
		mut  func(map[string]any)
	}{
		{"moderator", map[string]any{"id": 42, "username": "viewer-a", "isModerator": true}, nil},
		{"impersonation", map[string]any{"id": 42, "username": "viewer-a"}, func(m map[string]any) {
			m["impersonatedBy"] = 77
			m["impExp"] = time.Now().Add(time.Hour).UnixMilli()
		}},
	}
	for _, c := range cases {
		f := newResolveFixture(t)
		f.session(t, 42, c.user)
		tok := f.token(t, c.mut)
		req := func() (*SessionUser, error) {
			return f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=" + tok}, "/x"))
		}
		if u, err := req(); err != nil || u == nil || u.ID != 42 {
			t.Fatalf("%s healthy store: got %+v, %v; want user 42", c.name, u, err)
		}
		f.sys.Err = testkit.ErrDown
		if u, err := req(); u != nil || fallback.Reason(err) != "revocation-unconfirmed" {
			t.Fatalf("%s outage: got %+v, %v; want the revocation-unconfirmed fallback", c.name, u, err)
		}
	}
}

// staleFixture is a Verifier on a hand-moved clock over a switchable JWKS, with stale drops counted.
type staleFixture struct {
	now    time.Time
	j      *switchableJWKS
	v      *Verifier
	stales []time.Duration
	key    keyPair
}

func newStaleFixture(t *testing.T) *staleFixture {
	t.Helper()
	f := &staleFixture{now: time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC), key: newKey(t, "k1")}
	j, srv := newSwitchable(t, f.key)
	f.j = j
	f.v = &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return f.now },
		MaxStaleness: 30 * time.Minute, OnStale: func(age time.Duration) { f.stales = append(f.stales, age) }}
	if err := f.v.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *staleFixture) verifies(t *testing.T) bool {
	t.Helper()
	_, err := f.v.Verify(context.Background(), sign(t, f.key, "ES256", baseClaims(f.now)))
	return err == nil
}

// Keep-last-good holds only within MaxStaleness: past it the set is dropped once, every session then
// verifies as signed out, and the first successful fetch restores it.
func TestJWKSMaxStalenessFailsClosed(t *testing.T) {
	f := newStaleFixture(t)
	t0 := f.now
	f.j.fail(http.StatusBadGateway, "down")
	f.now = t0.Add(29 * time.Minute)
	if !f.verifies(t) || len(f.stales) != 0 {
		t.Fatalf("within the window: verifies=false or %d stale drops, want the last good key kept", len(f.stales))
	}
	f.now = t0.Add(31 * time.Minute)
	if f.verifies(t) {
		t.Fatal("31 min after the last good fetch (limit 30): still verifies, want fail closed")
	}
	if len(f.stales) != 1 || f.stales[0] != 31*time.Minute {
		t.Fatalf("stale drops = %v, want one, aged 31m", f.stales)
	}
	f.now = f.now.Add(time.Minute)
	if f.verifies(t) || len(f.stales) != 1 {
		t.Fatalf("still down: want no verify and no second drop report, got %d drops", len(f.stales))
	}
	f.j.set(f.key) // the hub recovers
	f.now = f.now.Add(time.Minute)
	if !f.verifies(t) {
		t.Fatal("after the hub recovered: the refetched key does not verify")
	}
	if len(f.stales) != 1 {
		t.Fatalf("stale drops = %d after recovery, want 1", len(f.stales))
	}
}

// A non-empty successful fetch resets the staleness clock.
func TestJWKSSuccessfulFetchResetsStaleness(t *testing.T) {
	f := newStaleFixture(t)
	t0 := f.now
	f.now = t0.Add(25 * time.Minute)
	if err := f.v.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.j.fail(http.StatusBadGateway, "down")
	f.now = t0.Add(50 * time.Minute) // 50 min after the first fetch, 25 after the last good one
	if !f.verifies(t) || len(f.stales) != 0 {
		t.Fatal("25 min after a good fetch: want verified, no drop")
	}
	f.now = t0.Add(56 * time.Minute)
	if f.verifies(t) || len(f.stales) != 1 {
		t.Fatalf("31 min after the last good fetch: want fail closed and one drop, got %d", len(f.stales))
	}
}

// An empty successful set keeps the last good keys, but does not extend the window.
func TestJWKSEmptySetKeepsLastGoodOnlyWithinTheWindow(t *testing.T) {
	f := newStaleFixture(t)
	t0 := f.now
	f.j.fail(0, `{"keys":[]}`)
	f.now = t0.Add(10 * time.Minute)
	if err := f.v.refresh(context.Background()); err == nil || !strings.Contains(err.Error(), "no usable signing keys") {
		t.Fatalf("empty set: err = %v, want the no-usable-keys error", err)
	}
	if !f.verifies(t) {
		t.Fatal("empty set within the window: the last good key was dropped")
	}
	f.now = t0.Add(31 * time.Minute)
	if f.verifies(t) || len(f.stales) != 1 {
		t.Fatalf("31 min after the last NON-EMPTY fetch: want fail closed, got %d drops", len(f.stales))
	}
}

func TestJWKSMaxStalenessDefaultsToThreeIntervals(t *testing.T) {
	if got := (&Verifier{}).maxStaleness(); got != 30*time.Minute {
		t.Fatalf("default = %v, want 30m (3 × the 10 min refresh)", got)
	}
	if got := (&Verifier{RefreshInterval: time.Minute}).maxStaleness(); got != 3*time.Minute {
		t.Fatalf("with a 1 min refresh = %v, want 3m", got)
	}
	if got := (&Verifier{RefreshInterval: time.Minute, MaxStaleness: 7 * time.Minute}).maxStaleness(); got != 7*time.Minute {
		t.Fatalf("explicit = %v, want 7m", got)
	}
}

// Each resolved session reports the slot its cookie was read from; a signed-out request reports none.
func TestResolveReportsTheCookieSlot(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a"})
	good := f.token(t, nil)
	var slots []string
	f.r.OnSlot = func(slot string) { slots = append(slots, slot) }
	for _, cookie := range []string{
		"__Secure-civ-token=" + good,
		"__Host-civ-token=" + good,
		"__Secure-civ-token=not.a.token",
	} {
		if _, err := f.r.Resolve(context.Background(), request(map[string]string{"Cookie": cookie}, "/x")); err != nil {
			t.Fatalf("%s: %v", cookie, err)
		}
	}
	if want := []string{"shared", "host"}; !slices.Equal(slots, want) {
		t.Fatalf("slots %v, want %v", slots, want)
	}
}

// Mod Lead ruling 2026-11-27, as createRevocationCheck: one retry after a fast connection-level error,
// none after the deadline or any other error.
func TestIsRevokedRetriesOnceAfterAFastError(t *testing.T) {
	reset := errors.New("read tcp 10.0.0.1:6379: connection reset by peer")
	failFirst := func(r *testkit.Redis, n int) {
		seen := 0
		r.KeyErr = func(key string) error {
			if key != "session:token-state" {
				return nil
			}
			seen++
			if seen <= n {
				return reset
			}
			return nil
		}
	}
	noDelay := func() time.Duration { return 0 }

	r := testkit.NewRedis()
	r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"})
	failFirst(r, 1)
	var d degradedRecorder
	rev := &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report, RetryDelay: noDelay}
	if revoked, failed := rev.Check(context.Background(), revocationClaims()); !revoked || failed {
		t.Fatalf("reset then answer: revoked=%v failed=%v, want the store's verdict", revoked, failed)
	}
	if r.Calls != 2 || len(d.verdicts) != 0 {
		t.Fatalf("reset then answer: %d round trips, verdicts %v; want 2 and none", r.Calls, d.verdicts)
	}

	r = testkit.NewRedis()
	failFirst(r, 2)
	d = degradedRecorder{}
	rev = &Revocation{Redis: r, Markers: NewMarkerCache(0), OnDegraded: d.report, RetryDelay: noDelay}
	if revoked, failed := rev.Check(context.Background(), revocationClaims()); revoked || !failed {
		t.Fatalf("two resets: revoked=%v failed=%v, want allowed from the markers", revoked, failed)
	}
	if r.Calls != 2 {
		t.Fatalf("two resets: %d round trips, want 2", r.Calls)
	}
	d.only(t, "two resets", VerdictAllowUnknown, "connection reset")

	for _, c := range []struct {
		name    string
		fail    func(r *testkit.Redis)
		timeout time.Duration
	}{
		{"deadline", func(r *testkit.Redis) { r.Delay = time.Second }, 20 * time.Millisecond},
		{"closed client", func(r *testkit.Redis) { r.Err = redis.ErrClosed }, 0},
		{"other error", func(r *testkit.Redis) { r.Err = testkit.ErrDown }, 0},
	} {
		r := testkit.NewRedis()
		c.fail(r)
		rev := &Revocation{Redis: r, Timeout: c.timeout, Markers: NewMarkerCache(0), RetryDelay: noDelay}
		if _, failed := rev.Check(context.Background(), revocationClaims()); !failed || r.Calls != 1 {
			t.Fatalf("%s: failed=%v after %d round trips, want a failed read and no retry", c.name, failed, r.Calls)
		}
	}
}

// After a retry fails, the process stops retrying for RetryCooldown, then retries again.
func TestIsRevokedStopsRetryingForTheCooldownAfterARetryFails(t *testing.T) {
	r := testkit.NewRedis()
	r.Err = errors.New("read tcp 10.0.0.1:6379: connection reset by peer")
	rev := &Revocation{Redis: r, RetryDelay: func() time.Duration { return 0 }, RetryCooldown: 50 * time.Millisecond}
	rev.Check(context.Background(), revocationClaims())
	if r.Calls != 2 {
		t.Fatalf("first failure: %d round trips, want 2 (one retry)", r.Calls)
	}
	rev.Check(context.Background(), revocationClaims())
	if r.Calls != 3 {
		t.Fatalf("inside the cool-down: %d round trips, want 3 (no retry)", r.Calls)
	}
	time.Sleep(60 * time.Millisecond)
	rev.Check(context.Background(), revocationClaims())
	if r.Calls != 5 {
		t.Fatalf("after the cool-down: %d round trips, want 5 (retrying again)", r.Calls)
	}
}

// A request that ends during the backoff never retried, so it does not pause retries for the process.
func TestIsRevokedARequestEndedInTheBackoffDoesNotPauseRetries(t *testing.T) {
	r := testkit.NewRedis()
	r.Err = errors.New("read tcp 10.0.0.1:6379: connection reset by peer")
	rev := &Revocation{Redis: r, RetryDelay: func() time.Duration { return time.Second }, RetryCooldown: time.Hour}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	rev.Check(ctx, revocationClaims())
	if r.Calls != 1 {
		t.Fatalf("ended in the backoff: %d round trips, want 1", r.Calls)
	}
	rev.RetryDelay = func() time.Duration { return 0 }
	rev.Check(context.Background(), revocationClaims())
	if r.Calls != 3 {
		t.Fatalf("next failure: %d round trips, want 3 (it still retries)", r.Calls)
	}
}
