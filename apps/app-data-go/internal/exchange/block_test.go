package exchange

import (
	"context"
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
	time.Sleep(20 * time.Millisecond) // let the others reach the wait
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
	if bc.Len() != 0 {
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
	time.Sleep(20 * time.Millisecond)
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

// The cache is bounded: full, a new block token is not exchanged; entries are forgotten once no
// exchange of their token could succeed, which frees the room.
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
	c.add(time.Second)
	if _, err := bc.Exchange(context.Background(), blockA); err != nil {
		t.Fatalf("after the memory ended: %v", err)
	}
	if bc.Len() != 1 {
		t.Fatalf("%d remembered, want 1", bc.Len())
	}
	if got := o.String(); got != "[full/none full/none issued/none]" {
		t.Fatalf("observed %s", got)
	}
}

func TestRouteSendsOnlyBlockTokensToTheBlockExchange(t *testing.T) {
	var user []string
	userEx := func(_ context.Context, s string) (Token, error) {
		user = append(user, s)
		return Token{Access: "u"}, nil
	}
	// Off: the user exchange itself, whatever the token.
	off := Route(userEx, nil)
	for _, s := range []string{"civitai_a", blockA} {
		if tok, _ := off(context.Background(), s); tok.Access != "u" {
			t.Fatalf("off routed %q elsewhere", s)
		}
	}
	bc, h, _, _ := newBlockCache()
	bc.Now = nil // the real clock
	on := Route(userEx, bc)
	if tok, _ := on(context.Background(), "civitai_b"); tok.Access != "u" {
		t.Fatal("a hub token left the user exchange")
	}
	if tok, err := on(context.Background(), blockA); err != nil || tok.Access != "x."+blockA {
		t.Fatalf("%+v, %v", tok, err)
	}
	if fmt.Sprint(user) != "[civitai_a "+blockA+" civitai_b]" || h.count(blockA) != 1 {
		t.Fatalf("user exchange saw %v, block exchange %d", user, h.count(blockA))
	}
}
