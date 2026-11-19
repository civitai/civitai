package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/hydrate"
	"github.com/civitai/civitai/apps/beacon-go/internal/testkit"
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
		rev := &Revocation{Redis: r, OnReadError: func(error) { failedOpen = true }}
		if got, err := rev.IsRevoked(context.Background(), revocationClaims()); got != c.want || err != nil {
			t.Errorf("%s: IsRevoked = %v, %v; want %v, nil", c.name, got, err, c.want)
		}
		if failedOpen {
			t.Errorf("%s: absent keys (redis.Nil) were reported as a failed read", c.name)
		}
		if r.Calls != 1 {
			t.Errorf("%s: %d round trips, want 1 pipelined", c.name, r.Calls)
		}
	}
}

func TestIsRevokedReportsAFailedRead(t *testing.T) {
	// A revoked token, but the registry cannot be read: no decision, the error returned and reported.
	for _, c := range []struct {
		name    string
		r       *testkit.Redis
		timeout time.Duration
		wantErr string
	}{
		{"store down", func() *testkit.Redis { r := testkit.NewRedis(); r.Err = testkit.ErrDown; return r }(), 0, "down"},
		{"store slower than the read timeout", func() *testkit.Redis { r := testkit.NewRedis(); r.Delay = time.Second; return r }(), 20 * time.Millisecond, "deadline exceeded"},
	} {
		c.r.SetHash("session:token-state", map[string]string{"tok-1": "invalid"})
		var reported error
		rev := &Revocation{Redis: c.r, Timeout: c.timeout, OnReadError: func(err error) { reported = err }}
		start := time.Now()
		revoked, err := rev.IsRevoked(context.Background(), revocationClaims())
		if revoked || err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: IsRevoked = %v, %v; want false and an error containing %q", c.name, revoked, err, c.wantErr)
		}
		if reported == nil || !strings.Contains(reported.Error(), c.wantErr) {
			t.Errorf("%s: OnReadError got %v, want an error containing %q", c.name, reported, c.wantErr)
		}
		if el := time.Since(start); el > 500*time.Millisecond {
			t.Errorf("%s: took %v, the read timeout did not bound it", c.name, el)
		}
	}
}

func TestIsRevokedWithoutJtiReadsNothing(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("session:user-cut:42", []byte("9999999999999"))
	c := revocationClaims()
	c.Jti = ""
	if revoked, err := (&Revocation{Redis: r}).IsRevoked(context.Background(), c); revoked || err != nil || r.Calls != 0 {
		t.Fatalf("no jti: want not revoked and no read, got %d round trips", r.Calls)
	}
}

// ---- Resolver.Resolve end to end over the fakes ----

type resolveFixture struct {
	now     time.Time
	key     keyPair
	cache   *testkit.Redis
	sys     *testkit.Redis
	r       *Resolver
	reports []error
}

func newResolveFixture(t *testing.T) *resolveFixture {
	t.Helper()
	f := &resolveFixture{now: time.Now(), key: newKey(t, "k1"), cache: testkit.NewRedis(), sys: testkit.NewRedis()}
	_, srv := newSwitchable(t, f.key)
	f.r = &Resolver{
		Verifier: &Verifier{Issuer: issuer, JWKSURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return f.now }},
		Revocation: &Revocation{Redis: f.sys, OnReadError: func(err error) {
			f.reports = append(f.reports, err)
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
		{"both slots", map[string]string{"Cookie": "__Secure-civ-token=" + good + "; __Host-civ-token=" + good}, "/x", want{reason: "multiple-session-cookies"}},
		{"unconfigured cookie name ignored", map[string]string{"Cookie": "civ-token=" + good}, "/x", want{}},
		{"invalid token", map[string]string{"Cookie": "__Secure-civ-token=not.a.token"}, "/x", want{}},
		{"expired token", map[string]string{"Cookie": "__Secure-civ-token=" + f.token(t, func(m map[string]any) { m["exp"] = f.now.Add(-time.Minute).Unix() })}, "/x", want{}},
		{"revoked", map[string]string{"Cookie": "__Secure-civ-token=" + revoked}, "/x", want{}},
		{"banned", map[string]string{"Cookie": "__Secure-civ-token=" + banned}, "/x", want{id: 43, banned: true}},
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

// A sysredis outage is not guessed through: the Node app would still deny revocations its marker
// cache has seen, so the request falls back (revocation-unavailable), and the read error is reported.
func TestResolveRevocationOutageFallsBack(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a"})
	f.sys.Err = testkit.ErrDown
	u, err := f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=" + f.token(t, nil)}, "/x"))
	if u != nil || fallback.Reason(err) != "revocation-unavailable" {
		t.Fatalf("got %+v, %v; want the revocation-unavailable fallback", u, err)
	}
	if len(f.reports) != 1 || !errors.Is(f.reports[0], testkit.ErrDown) {
		t.Fatalf("read-error reports = %v, want the one outage", f.reports)
	}
}

// Before the first key fetch has landed (it is in flight, so the unknown-kid refetch is rate-limited)
// a signed-in request is not written as signed out: it falls back (jwks-unavailable). Once the set is
// loaded the same request resolves.
func TestResolveBeforeTheFirstKeyFetchFallsBack(t *testing.T) {
	f := newResolveFixture(t)
	f.session(t, 42, map[string]any{"id": 42, "username": "viewer-a"})
	tok := f.token(t, nil)
	// The fetch Run starts at boot: lastFetch is stamped, no key set has arrived yet.
	f.r.Verifier.lastFetch = f.now
	req := request(map[string]string{"Cookie": "__Secure-civ-token=" + tok}, "/x")
	u, err := f.r.Resolve(context.Background(), req)
	if u != nil || fallback.Reason(err) != "jwks-unavailable" {
		t.Fatalf("cold start: got %+v, %v; want the jwks-unavailable fallback", u, err)
	}
	// A first fetch that FAILS also leaves no key set: still a fallback, never signed out.
	f.r.Verifier.lastFetch = time.Time{}
	f.r.Verifier.JWKSURL = "http://127.0.0.1:1/jwks"
	if u, err := f.r.Resolve(context.Background(), req); u != nil || fallback.Reason(err) != "jwks-unavailable" {
		t.Fatalf("failed first fetch: got %+v, %v; want the jwks-unavailable fallback", u, err)
	}
	// An invalid token is still signed out, whatever the key state: it fails before any key is needed.
	if u, err := f.r.Resolve(context.Background(), request(map[string]string{"Cookie": "__Secure-civ-token=not.a.token"}, "/x")); u != nil || err != nil {
		t.Fatalf("garbage token: got %+v, %v; want signed out", u, err)
	}
}

// Past MaxStaleness the key set is dropped: a signed-in request then falls back rather than being
// written as signed out.
func TestResolveWithAStaleKeySetFallsBack(t *testing.T) {
	f := newStaleFixture(t)
	f.j.fail(http.StatusBadGateway, "down")
	f.now = f.now.Add(31 * time.Minute)
	_, err := f.v.Verify(context.Background(), sign(t, f.key, "ES256", baseClaims(f.now)))
	if !errors.Is(err, ErrNoKeys) {
		t.Fatalf("stale key set: err = %v, want ErrNoKeys", err)
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
