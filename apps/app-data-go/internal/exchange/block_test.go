package exchange

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A block token's shape, as the site signs one: header.payload.signature, base64url.
const blockA = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJibGstYSJ9.c2lnLWE"

func TestKindOfRoutesByPrefixAndShapeOnly(t *testing.T) {
	for token, want := range map[string]Kind{
		"civitai_abc":                   KindHub,
		"civitai_a.b.c":                 KindHub, // the prefix wins
		blockA:                          KindBlock,
		"a.b.c":                         KindBlock,
		"A-_9.b.c":                      KindBlock,
		"a.b":                           KindOther,
		"a.b.c.d":                       KindOther,
		"a..c":                          KindOther,
		".b.c":                          KindOther,
		"a.b.":                          KindOther,
		"a.b+c.d":                       KindOther,
		"a.b=.c":                        KindOther, // padding is not base64url's JWS form
		"a.b/c.d":                       KindOther,
		"opaque-token-without-any-dots": KindOther,
		"":                              KindOther,
	} {
		if got := KindOf(token); got != want {
			t.Errorf("KindOf(%q) = %v, want %v", token, got, want)
		}
	}
}

// The block exchange's request: the same client and resource as the user exchange, the block-token
// subject type, AppDataRead.
func TestExchangeBlockSendsTheBlockTokenSubjectType(t *testing.T) {
	var form url.Values
	var id string
	e := hub(t, func(w http.ResponseWriter, r *http.Request) {
		id, _, _ = r.BasicAuth()
		_ = r.ParseForm()
		form = r.PostForm
		_, _ = io.WriteString(w, `{"access_token":"eyJblock-exchanged","expires_in":300}`)
	})
	tok, err := e.ExchangeBlock(context.Background(), blockA)
	if err != nil {
		t.Fatal(err)
	}
	want := url.Values{
		"grant_type": {GrantType}, "subject_token": {blockA}, "subject_token_type": {"urn:civitai:token-type:block-token"},
		"resource": {"https://apps.invalid"}, "scope": {"AppDataRead"},
	}
	if form.Encode() != want.Encode() || id != "relay+client" {
		t.Fatalf("form %v, client %q", form, id)
	}
	if tok.Access != "eyJblock-exchanged" || !tok.Expires.Equal(time.Unix(1_700_000_300, 0)) {
		t.Fatalf("%+v", tok)
	}
}

func TestRefusalCodes(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{&RefusedError{Status: 400, Code: "invalid_grant"}, "invalid_grant"},
		{fmt.Errorf("wrapped: %w", &RefusedError{Status: 401, Code: "invalid_client"}), "invalid_client"},
		{&RefusedError{Status: 400, Code: "none"}, "other"},
		{&RefusedError{Status: 400, Code: "something_new"}, "other"},
		{errors.New("exchange: token endpoint unreachable"), "none"},
		{nil, "none"},
	} {
		if got := RefusalCode(tc.err); got != tc.want {
			t.Errorf("RefusalCode(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
	// A refusal reads exactly as it did before it carried its code.
	if got := (&RefusedError{Status: 400, Code: "invalid_grant"}).Error(); got != "exchange: the hub refused the exchange (HTTP 400, invalid_grant)" {
		t.Fatalf("%q", got)
	}
	if !errors.Is(&RefusedError{}, ErrRefused) {
		t.Fatal("a RefusedError is not ErrRefused")
	}
}

// fakeBlockHub counts exchanges per block token and answers what the test set for it.
type fakeBlockHub struct {
	mu     sync.Mutex
	calls  map[string]int
	answer map[string]error
	life   time.Duration
	now    func() time.Time
	gate   chan struct{} // when set, every exchange waits for it
}

func (f *fakeBlockHub) Exchange(ctx context.Context, subject string) (Token, error) {
	f.mu.Lock()
	f.calls[subject]++
	err, gate := f.answer[subject], f.gate
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return Token{}, ctx.Err()
		}
	}
	if err != nil {
		return Token{}, err
	}
	return Token{Access: "x." + subject, Expires: f.now().Add(f.life)}, nil
}

func (f *fakeBlockHub) count(subject string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[subject]
}

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type observed struct {
	mu  sync.Mutex
	got []string
}

func (o *observed) observe(outcome, code string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.got = append(o.got, outcome+"/"+code)
}

func (o *observed) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return fmt.Sprint(o.got)
}

func newBlockCache() (*BlockCache, *fakeBlockHub, *testClock, *observed) {
	c := &testClock{t: time.Unix(1_700_000_000, 0)}
	h := &fakeBlockHub{calls: map[string]int{}, answer: map[string]error{}, life: 15 * time.Minute, now: c.now}
	o := &observed{}
	return &BlockCache{Hub: h.Exchange, Margin: 30 * time.Second, Now: c.now, Observe: o.observe}, h, c, o
}

// 🔴 The hub refuses a second exchange of one block token, so one is never asked for: every later
// call, from any stream of that token, is handed the token the first one got.
func TestABlockTokenIsExchangedOnceAndItsTokenReused(t *testing.T) {
	bc, h, c, o := newBlockCache()
	first, err := bc.Exchange(context.Background(), blockA)
	if err != nil || first.Access != "x."+blockA {
		t.Fatalf("%+v, %v", first, err)
	}
	c.add(5 * time.Minute)
	again, err := bc.Exchange(context.Background(), blockA)
	if err != nil || again != first {
		t.Fatalf("%+v, %v; want the first token again", again, err)
	}
	if n := h.count(blockA); n != 1 {
		t.Fatalf("the hub was asked %d times for one block token, want 1", n)
	}
	// Another block token is its own exchange: entries never cross.
	other, err := bc.Exchange(context.Background(), "b.b.b")
	if err != nil || other.Access != "x.b.b.b" || h.count("b.b.b") != 1 {
		t.Fatalf("%+v, %v", other, err)
	}
	if got := o.String(); got != "[issued/none reused/none issued/none]" {
		t.Fatalf("observed %s", got)
	}
}

// Concurrent streams of one block token (two collections opened at once) share one exchange.
// waitForWaiters waits (bounded) until n calls have joined the exchange of subject in flight.
func waitForWaiters(t *testing.T, bc *BlockCache, subject string, n int) {
	t.Helper()
	k := sha256.Sum256([]byte(subject))
	deadline := time.Now().Add(2 * time.Second)
	for {
		bc.mu.Lock()
		got := 0
		if e := bc.entries[k]; e != nil {
			got = e.waiters
		}
		bc.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d calls waiting on the exchange, want %d", got, n)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestConcurrentCallsShareOneExchange(t *testing.T) {
	bc, h, _, _ := newBlockCache()
	h.gate = make(chan struct{})
	var wg sync.WaitGroup
	var ok atomic.Int32
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tok, err := bc.Exchange(context.Background(), blockA); err == nil && tok.Access == "x."+blockA {
				ok.Add(1)
			}
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for h.count(blockA) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	waitForWaiters(t, bc, blockA, 7) // every other call is waiting on the one exchange
	close(h.gate)
	wg.Wait()
	if n := h.count(blockA); n != 1 || ok.Load() != 8 {
		t.Fatalf("%d exchanges, %d answered; want 1 and 8", n, ok.Load())
	}
}

// A refusal is remembered: the hub is not asked again for that block token.
func TestARefusalIsRememberedNotAskedAgain(t *testing.T) {
	bc, h, c, o := newBlockCache()
	h.answer[blockA] = &RefusedError{Status: 400, Code: "invalid_grant"}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want a refusal", err)
	}
	c.add(10 * time.Minute)
	if _, err := bc.Exchange(context.Background(), blockA); RefusalCode(err) != "invalid_grant" {
		t.Fatalf("got %v, want the remembered refusal", err)
	}
	if n := h.count(blockA); n != 1 {
		t.Fatalf("the hub was asked %d times, want 1", n)
	}
	if got := o.String(); got != "[refused/invalid_grant remembered/invalid_grant]" {
		t.Fatalf("observed %s", got)
	}
}

// A failure issued nothing (and the hub gives a claim it made back), so it is not remembered: the
// next call asks again and can succeed.
func TestAFailureIsForgottenSoALaterCallRetries(t *testing.T) {
	bc, h, _, o := newBlockCache()
	h.answer[blockA] = errors.New("exchange: token endpoint answered HTTP 503 (temporarily_unavailable)")
	if _, err := bc.Exchange(context.Background(), blockA); err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want a failure", err)
	}
	if issued, refused := bc.Len(); issued != 0 || refused != 0 {
		t.Fatal("a failure was remembered")
	}
	h.mu.Lock()
	delete(h.answer, blockA)
	h.mu.Unlock()
	if tok, err := bc.Exchange(context.Background(), blockA); err != nil || tok.Access != "x."+blockA {
		t.Fatalf("%+v, %v", tok, err)
	}
	if n := h.count(blockA); n != 2 {
		t.Fatalf("%d exchanges, want 2", n)
	}
	if got := o.String(); got != "[failed/none issued/none]" {
		t.Fatalf("observed %s", got)
	}
}

// A 429 (or its hold) is a failure, forgotten like one, but counted rate_limited, not failed, so a
// hold does not read as a hub outage.
func TestARateLimitedExchangeIsForgottenAndCountedAsRateLimited(t *testing.T) {
	bc, h, _, o := newBlockCache()
	h.answer[blockA] = &RateLimitedError{RetryAfter: 60 * time.Second}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.As(err, new(*RateLimitedError)) || errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want a RateLimitedError", err)
	}
	if issued, refused := bc.Len(); issued != 0 || refused != 0 {
		t.Fatal("a rate-limited exchange was remembered")
	}
	h.mu.Lock()
	delete(h.answer, blockA)
	h.mu.Unlock()
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatal(err)
	}
	if got := o.String(); got != "[rate_limited/none issued/none]" {
		t.Fatalf("observed %s", got)
	}
}

// Callers waiting on an exchange that fails get its error; one whose own deadline passes first gets
// that instead.
func TestWaitersGetTheFailureOrTheirOwnDeadline(t *testing.T) {
	bc, h, _, _ := newBlockCache()
	h.gate = make(chan struct{})
	h.answer[blockA] = errors.New("exchange: token endpoint unreachable")
	firstErr := make(chan error, 1)
	go func() {
		_, err := bc.Exchange(context.Background(), blockA)
		firstErr <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for h.count(blockA) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := bc.Exchange(ctx, blockA); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a waiter past its deadline got %v", err)
	}
	waiter := make(chan error, 1)
	go func() {
		_, err := bc.Exchange(context.Background(), blockA)
		waiter <- err
	}()
	waitForWaiters(t, bc, blockA, 2) // the timed-out waiter and this one
	close(h.gate)
	if err := <-firstErr; err == nil || err.Error() != "exchange: token endpoint unreachable" {
		t.Fatalf("first: %v", err)
	}
	if err := <-waiter; err == nil || err.Error() != "exchange: token endpoint unreachable" {
		t.Fatalf("waiter: %v", err)
	}
	if n := h.count(blockA); n != 1 {
		t.Fatalf("%d exchanges, want 1", n)
	}
}

// 🔴 The ≤15-minute life: a reused token is handed out only while it has more than the margin left,
// and never again after; the hub is not asked for a second one. Fixture: the hub issues 60 s, the
// margin is 30 s, so the boundary is at 30 s; measured at 29 s and 30 s.
func TestAReusedTokenIsHandedOutOnlyWithinItsLife(t *testing.T) {
	bc, h, c, o := newBlockCache()
	h.life = time.Minute
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatal(err)
	}
	c.add(29 * time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatalf("within its life: %v", err)
	}
	c.add(time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrSpent) || errors.Is(err, ErrRefused) {
		t.Fatalf("at its margin: %v, want ErrSpent (not a refusal)", err)
	}
	if n := h.count(blockA); n != 1 {
		t.Fatalf("%d exchanges, want 1", n)
	}
	if got := o.String(); got != "[issued/none reused/none spent/none]" {
		t.Fatalf("observed %s", got)
	}
}

// Whatever expires_in says, an exchanged token is held to 15 minutes.
func TestAnAnswerIsHeldToFifteenMinutes(t *testing.T) {
	bc, h, c, _ := newBlockCache()
	h.life = time.Hour
	tok, err := bc.Exchange(context.Background(), blockA)
	if err != nil || !tok.Expires.Equal(time.Unix(1_700_000_000, 0).Add(15*time.Minute)) {
		t.Fatalf("%+v, %v", tok, err)
	}
	c.add(15*time.Minute - 31*time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatalf("before the cap's margin: %v", err)
	}
	c.add(time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrSpent) {
		t.Fatalf("at the cap's margin: %v", err)
	}
}

// The issued tokens are bounded: full, a new block token is not exchanged (and the full answer
// scans nothing); entries are forgotten at the first sweep once no exchange of their token could
// succeed, which frees the room. Fixture: memory 16 min, a sweep at most once a minute.
func TestTheCacheIsBoundedAndForgets(t *testing.T) {
	bc, h, c, o := newBlockCache()
	bc.Observe = nil
	for i := range MaxBlockTokens {
		if _, err := bc.Exchange(context.Background(), fmt.Sprintf("h.p%d.s", i)); err != nil {
			t.Fatal(err)
		}
	}
	bc.Observe = o.observe
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrBlockCacheFull) {
		t.Fatalf("got %v, want ErrBlockCacheFull", err)
	}
	if h.count(blockA) != 0 {
		t.Fatal("a full cache asked the hub")
	}
	c.add(16*time.Minute - time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrBlockCacheFull) {
		t.Fatalf("forgot before its memory ended: %v", err)
	}
	c.add(30 * time.Second) // past the memory, but the last sweep was 30 s ago
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrBlockCacheFull) {
		t.Fatalf("swept twice within a minute: %v", err)
	}
	c.add(45 * time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatalf("after the memory ended and a sweep: %v", err)
	}
	if issued, _ := bc.Len(); issued != 1 {
		t.Fatalf("%d held, want 1", issued)
	}
	if got := o.String(); got != "[full/none full/none full/none issued/none]" {
		t.Fatalf("observed %s", got)
	}
}

// 🔴 A flood of made-up tokens of the block-token shape (each refused by the hub) never locks a real
// block token out: refusals are kept apart from issued tokens, and only MaxRememberedRefusals of them.
func TestAFloodOfRefusedTokensNeverLocksOutARealOne(t *testing.T) {
	bc, h, _, _ := newBlockCache()
	bc.Observe = nil
	const flood = MaxBlockTokens + MaxRememberedRefusals + 500
	for i := range flood {
		tok := fmt.Sprintf("g.%d.g", i)
		h.answer[tok] = &RefusedError{Status: 400, Code: "invalid_grant"}
		if _, err := bc.Exchange(context.Background(), tok); !errors.Is(err, ErrRefused) {
			t.Fatalf("garbage %d: %v", i, err)
		}
	}
	issued, refused := bc.Len()
	if issued != 0 || refused != MaxRememberedRefusals {
		t.Fatalf("held %d issued, %d refusals; want 0 and %d", issued, refused, MaxRememberedRefusals)
	}
	if tok, err := bc.Exchange(context.Background(), blockA); err != nil || tok.Access != "x."+blockA {
		t.Fatalf("a real block token after the flood: %+v, %v", tok, err)
	}
	// A remembered refusal is not asked again; one past the cap is (and is refused again).
	if _, err := bc.Exchange(context.Background(), "g.0.g"); !errors.Is(err, ErrRefused) || h.count("g.0.g") != 1 {
		t.Fatalf("remembered refusal: %v, asked %d", err, h.count("g.0.g"))
	}
	last := fmt.Sprintf("g.%d.g", flood-1)
	if _, err := bc.Exchange(context.Background(), last); !errors.Is(err, ErrRefused) || h.count(last) != 2 {
		t.Fatalf("unremembered refusal: %v, asked %d", err, h.count(last))
	}
}

// 🔴 The Router is the one place deciding what is exchanged: Accepts and Exchange agree, and a block
// token never reaches the user exchange, whether the block exchange is on or off.
func TestTheRouterSendsABlockTokenOnlyToTheBlockExchange(t *testing.T) {
	var user []string
	userEx := func(_ context.Context, s string) (Token, error) {
		user = append(user, s)
		return Token{Access: "u"}, nil
	}
	off := &Router{User: userEx}
	if !off.Accepts("civitai_a") || off.Accepts(blockA) || off.Accepts("opaque") {
		t.Fatal("off: Accepts")
	}
	if tok, _ := off.Exchange(context.Background(), "civitai_a"); tok.Access != "u" {
		t.Fatal("off: a hub token left the user exchange")
	}
	for _, s := range []string{blockA, "opaque"} {
		if _, err := off.Exchange(context.Background(), s); !errors.Is(err, ErrNotExchangeable) {
			t.Fatalf("off: %q: %v, want ErrNotExchangeable", s, err)
		}
	}
	bc, h, _, _ := newBlockCache()
	bc.Now = nil // the real clock
	on := &Router{User: userEx, Blocks: bc}
	if !on.Accepts("civitai_b") || !on.Accepts(blockA) || on.Accepts("opaque") {
		t.Fatal("on: Accepts")
	}
	if tok, _ := on.Exchange(context.Background(), "civitai_b"); tok.Access != "u" {
		t.Fatal("on: a hub token left the user exchange")
	}
	if tok, err := on.Exchange(context.Background(), blockA); err != nil || tok.Access != "x."+blockA {
		t.Fatalf("%+v, %v", tok, err)
	}
	if _, err := on.Exchange(context.Background(), "opaque"); !errors.Is(err, ErrNotExchangeable) {
		t.Fatalf("on: opaque: %v", err)
	}
	if fmt.Sprint(user) != "[civitai_a civitai_b]" || h.count(blockA) != 1 {
		t.Fatalf("user exchange saw %v, block exchange %d", user, h.count(blockA))
	}
}
