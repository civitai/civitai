package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The JWKS fetch is never waited on by a Check that does not need it (blockverify.go key): a held, usable
// key answers at once while a due refresh runs, and Checks that do need the fetch share one.

// heldJWKS serves keys, but while held each request blocks until released; it counts fetches and signals
// each one's arrival on entered.
type heldJWKS struct {
	mu      sync.Mutex
	keys    []map[string]string
	hold    chan struct{}
	entered chan struct{}
	fetches atomic.Int32
	url     string
}

func newHeldJWKS(t *testing.T, keys ...map[string]string) *heldJWKS {
	t.Helper()
	s := &heldJWKS{keys: keys, entered: make(chan struct{}, 64)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.fetches.Add(1)
		s.entered <- struct{}{}
		s.mu.Lock()
		hold := s.hold
		s.mu.Unlock()
		if hold != nil {
			<-hold
		}
		s.mu.Lock()
		keys := s.keys
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
	}))
	// Release a held request before the server closes, or Close waits on it.
	t.Cleanup(srv.Close)
	t.Cleanup(s.release)
	s.url = srv.URL
	return s
}

// holdNext makes every request from now on block until release, and serves keys once released.
func (s *heldJWKS) holdNext(keys ...map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hold, s.keys = make(chan struct{}), keys
}

func (s *heldJWKS) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hold != nil {
		close(s.hold)
		s.hold = nil
	}
}

func (s *heldJWKS) waitEntered(t *testing.T) {
	t.Helper()
	select {
	case <-s.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the JWKS fetch never started")
	}
}

// 🔴 A refresh that is due but slow does not hold up a Check whose kid is held: it is answered from the held
// set while the refresh runs. (Before this, key held v.mu across the fetch, so every Check waited on it.)
func TestASlowRefreshDoesNotBlockACachedKid(t *testing.T) {
	testKeys(t)
	s := newHeldJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := &BlockVerifier{JWKSURL: s.url, Now: c.now}
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	s.waitEntered(t)

	c.add(JWKSRefresh)
	s.holdNext(jwk(&siteKey.PublicKey, siteKid))
	tok := siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})
	done := make(chan error, 1)
	go func() { done <- v.Check(context.Background(), tok) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cached kid during a refresh: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a Check for a held kid waited on the JWKS refresh")
	}
	// The refresh did start, and is still in flight.
	s.waitEntered(t)
	if n := s.fetches.Load(); n != 2 {
		t.Fatalf("fetches %d; want 2 (the warm-up and the refresh)", n)
	}
	// A second cached-kid Check while it is still held does not start another fetch, and does not wait.
	go func() { done <- v.Check(context.Background(), tok) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second cached Check: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a second Check for a held kid waited on the JWKS refresh")
	}
	if n := s.fetches.Load(); n != 2 {
		t.Fatalf("fetches %d; want 2", n)
	}
	s.release()
}

// 🔴 Concurrent Checks naming a kid not held all wait on ONE fetch and all get its answer: here the rotated-in
// key, so every one verifies. Without the shared fetch only the first caller fetches and the rest, inside
// JWKSRefetchEvery, answer ErrBlockUnverifiable at once.
//
// INVARIANT GUARD, not regression coverage: the old key() held the lock across the fetch, which serialised
// these callers into the same outcome, so this passes on it too. It goes red when a caller that needs the
// fetch does not join the one in flight.
func TestConcurrentUnknownKidsShareOneFetch(t *testing.T) {
	testKeys(t)
	s := newHeldJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := &BlockVerifier{JWKSURL: s.url, Now: c.now}
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	s.waitEntered(t)

	c.add(JWKSRefetchEvery)
	s.holdNext(jwk(&siteKey.PublicKey, siteKid), jwk(&nextKey.PublicKey, nextKid))
	rotated := sign(t, nextKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": nextKid}, claimsAt(c.now()))

	const n = 8
	results := make(chan error, n)
	for range n {
		go func() { results <- v.Check(context.Background(), rotated) }()
	}
	s.waitEntered(t)
	// While the fetch is held, nobody has an answer: each is waiting on it.
	select {
	case err := <-results:
		t.Fatalf("a Check answered before the fetch it needs: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	s.release()
	for i := range n {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("check %d: %v", i, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("check %d never answered", i)
		}
	}
	if got := s.fetches.Load(); got != 2 {
		t.Fatalf("fetches %d; want 2 (the warm-up and one shared refetch)", got)
	}
}

// A caller whose context ends while it waits on the fetch gets ErrBlockUnverifiable at once; the fetch
// itself is shared, so it carries on and its result is kept for the next Check.
func TestACancelledWaiterLeavesTheSharedFetchRunning(t *testing.T) {
	testKeys(t)
	s := newHeldJWKS(t)
	s.holdNext(jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := &BlockVerifier{JWKSURL: s.url, Now: c.now}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- v.Check(ctx, siteToken(t, nil)) }()
	s.waitEntered(t)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, ErrBlockUnverifiable) {
			t.Fatalf("%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a cancelled waiter kept waiting")
	}
	s.release()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := v.Check(context.Background(), siteToken(t, nil)); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("the shared fetch's key set was never kept: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := s.fetches.Load(); got != 1 {
		t.Fatalf("fetches %d; want 1", got)
	}
}

// settle waits for the fetch in flight, if any, to finish; it reports whether there was one. The fetch is
// started under the lock inside key, so one Check started has set v.inflight by the time Check returns.
func settle(t *testing.T, v *BlockVerifier) bool {
	t.Helper()
	v.mu.Lock()
	f := v.inflight
	v.mu.Unlock()
	if f == nil {
		return false
	}
	select {
	case <-f.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the JWKS fetch never finished")
	}
	return true
}

// 🔴 A caller that joins a fetch already running when it arrived does not get a refusal for a kid that fetch
// did not return: the fetch may predate a key rotated in since, and a refusal is remembered (BlockCache).
// It gets ErrBlockUnverifiable, which is not. (A fetch the caller started itself still refuses an unknown
// kid: TestAnUnknownKidIsRefetchedThenRefused.)
func TestJoiningAnEarlierFetchDoesNotRefuseAnUnknownKid(t *testing.T) {
	testKeys(t)
	s := newHeldJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := &BlockVerifier{JWKSURL: s.url, Now: c.now}
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	s.waitEntered(t)

	// A due refresh starts, from a Check for the held kid, and is held.
	c.add(JWKSRefresh)
	s.holdNext(jwk(&siteKey.PublicKey, siteKid))
	if err := v.Check(context.Background(), siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})); err != nil {
		t.Fatal(err)
	}
	s.waitEntered(t)

	// A token naming a kid the refresh will not return arrives after it started, and joins it.
	c.add(time.Second)
	unknown := sign(t, forgerKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": forgerKid}, claimsAt(c.now()))
	done := make(chan error, 1)
	go func() { done <- v.Check(context.Background(), unknown) }()
	select {
	case err := <-done:
		t.Fatalf("answered before the fetch it joined: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	s.release()
	select {
	case err := <-done:
		if !errors.Is(err, ErrBlockUnverifiable) || errors.Is(err, ErrRefused) {
			t.Fatalf("want ErrBlockUnverifiable (forgotten), got %v (reason %q)", err, localReason(err))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never answered")
	}
	if n := s.fetches.Load(); n != 2 {
		t.Fatalf("fetches %d; want 2", n)
	}
}

// A held kid checked while the set is fresh (older than JWKSRefetchEvery, younger than JWKSRefresh) starts
// no fetch. Measured at both ends of that span.
func TestNoRefreshWhileTheKeySetIsFresh(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := verifier(s, c)
	if err := v.Check(context.Background(), siteToken(t, nil)); err != nil {
		t.Fatal(err)
	}
	for _, step := range []time.Duration{JWKSRefetchEvery, JWKSRefresh - JWKSRefetchEvery - time.Second} {
		c.add(step)
		tok := siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})
		if err := v.Check(context.Background(), tok); err != nil {
			t.Fatalf("at +%v: %v", c.now().Sub(verifyNow), err)
		}
		if settle(t, v) {
			t.Fatalf("at +%v: a refresh started while the set is fresh", c.now().Sub(verifyNow))
		}
		if n := s.fetches.Load(); n != 1 {
			t.Fatalf("at +%v: fetches %d; want 1", c.now().Sub(verifyNow), n)
		}
	}
}

// panicOnce panics on its first round trip, then serves through the default transport.
type panicOnce struct{ calls atomic.Int32 }

func (p *panicOnce) RoundTrip(r *http.Request) (*http.Response, error) {
	if p.calls.Add(1) == 1 {
		panic("boom")
	}
	return http.DefaultTransport.RoundTrip(r)
}

// A fetch that panics is settled as a failed fetch: the waiting Check gets ErrBlockUnverifiable, nothing is
// left in flight, and the next allowed fetch runs and verifies.
func TestAPanickingFetchIsAFailedFetch(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	c := &clock{t: verifyNow}
	v := &BlockVerifier{JWKSURL: s.url, Now: c.now, HTTP: &http.Client{Transport: &panicOnce{}}}
	if err := v.Check(context.Background(), siteToken(t, nil)); !errors.Is(err, ErrBlockUnverifiable) {
		t.Fatalf("%v", err)
	}
	v.mu.Lock()
	left := v.inflight
	v.mu.Unlock()
	if left != nil {
		t.Fatal("the panicked fetch is still in flight")
	}
	c.add(JWKSRefetchEvery)
	tok := siteToken(t, map[string]any{"iat": c.now().Unix(), "exp": c.now().Unix() + 900})
	if err := v.Check(context.Background(), tok); err != nil {
		t.Fatalf("after the panic: %v", err)
	}
	if n := s.fetches.Load(); n != 1 {
		t.Fatalf("server fetches %d; want 1 (the panicked one never reached it)", n)
	}
}
