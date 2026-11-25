package exchange

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

// guardHub is a fake user exchange: it issues a token for the subjects in valid and refuses every other
// as the hub refuses an unknown one (invalid_grant). asked counts the calls, by subject.
type guardHub struct {
	mu    sync.Mutex
	valid map[string]bool
	asked map[string]int
}

func (h *guardHub) exchange(_ context.Context, subject string) (Token, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.asked[subject]++
	if !h.valid[subject] {
		return Token{}, &RefusedError{Status: 400, Code: "invalid_grant"}
	}
	return Token{Access: "x." + subject, Expires: time.Unix(1_700_000_900, 0)}, nil
}

func (h *guardHub) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.asked {
		n += c
	}
	return n
}

func newGuard() (*Guard, *guardHub, *time.Time) {
	h := &guardHub{valid: map[string]bool{"civitai_alice": true, "civitai_bob": true}, asked: map[string]int{}}
	now := time.Unix(1_700_000_000, 0)
	g := &Guard{Hub: h.exchange, Now: func() time.Time { return now }}
	return g, h, &now
}

func from(ip string) context.Context { return WithClientIP(context.Background(), ip) }

func TestTheGuardThrottlesAnAddressPresentingManyNewTokens(t *testing.T) {
	g, h, now := newGuard()
	var outcomes []string
	g.Observe = func(o string) { outcomes = append(outcomes, o) }
	const attacker = "198.51.100.7"
	throttled := 0
	for i := range 100 {
		_, err := g.Exchange(from(attacker), fmt.Sprintf("civitai_made-up-%03d", i))
		var te *ThrottledError
		switch {
		case errors.As(err, &te):
			throttled++
			if errors.Is(err, ErrRefused) || te.RetryAfter <= 0 || te.RetryAfter > NewTokenEvery ||
				te.Error() != "exchange: too many new tokens from this address (retry in 3s)" {
				t.Fatalf("throttled answer %v", err)
			}
		case !errors.Is(err, ErrRefused):
			t.Fatalf("made-up token %d: %v", i, err)
		}
	}
	if n := h.total(); n != NewTokenBurst || throttled != 100-NewTokenBurst {
		t.Fatalf("🔴 the hub was asked %d times (throttled %d), want the burst %d", n, throttled, NewTokenBurst)
	}
	if len(outcomes) != throttled || outcomes[0] != GuardThrottled {
		t.Fatalf("observed %d %v", len(outcomes), outcomes[:1])
	}
	// Another address has its own budget.
	if _, err := g.Exchange(from("203.0.113.5"), "civitai_alice"); err != nil {
		t.Fatal(err)
	}
	// The attacker's budget refills one token per NewTokenEvery, and only that.
	*now = now.Add(NewTokenEvery)
	for i, want := range []int{1, 0} {
		before := h.total()
		_, _ = g.Exchange(from(attacker), fmt.Sprintf("civitai_after-%d", i))
		if got := h.total() - before; got != want {
			t.Fatalf("after one refill, call %d reached the hub %d times, want %d", i, got, want)
		}
	}
	// A request no address was named for is not charged.
	before := h.total()
	for i := range 3 * NewTokenBurst {
		_, _ = g.Exchange(context.Background(), fmt.Sprintf("civitai_internal-%03d", i))
	}
	if got := h.total() - before; got != 3*NewTokenBurst {
		t.Fatalf("with no address, %d of %d reached the hub", got, 3*NewTokenBurst)
	}
}

func TestTheGuardNeverThrottlesATokenTheHubExchanged(t *testing.T) {
	g, h, _ := newGuard()
	const shared = "198.51.100.7" // one address, a viewer and a flood behind it
	if _, err := g.Exchange(from(shared), "civitai_alice"); err != nil {
		t.Fatal(err)
	}
	for i := range 2 * NewTokenBurst {
		_, _ = g.Exchange(from(shared), fmt.Sprintf("civitai_made-up-%03d", i))
	}
	// The address is spent, but alice's token was exchanged here: still sent.
	if _, err := g.Exchange(from(shared), "civitai_alice"); err != nil {
		t.Fatalf("🔴 a token the hub exchanged was throttled: %v", err)
	}
	if h.asked["civitai_alice"] != 2 {
		t.Fatalf("alice asked %d, want 2", h.asked["civitai_alice"])
	}
	// Control: a token new to this replica, from the same address, is throttled.
	var te *ThrottledError
	if _, err := g.Exchange(from(shared), "civitai_bob"); !errors.As(err, &te) {
		t.Fatalf("a new token from a spent address: %v, want ThrottledError", err)
	}
}

func TestTheGuardRemembersARefusalForAWhile(t *testing.T) {
	g, h, now := newGuard()
	var outcomes []string
	g.Observe = func(o string) { outcomes = append(outcomes, o) }
	first, err := g.Exchange(from("198.51.100.7"), "civitai_made-up")
	if !errors.Is(err, ErrRefused) || first != (Token{}) {
		t.Fatalf("first: %v", err)
	}
	// Asked again, from any address, many times: the hub is not, and no budget is charged.
	for range 3 * NewTokenBurst {
		_, err = g.Exchange(from("198.51.100.7"), "civitai_made-up")
		if !errors.Is(err, ErrRefused) || RefusalCode(err) != "invalid_grant" {
			t.Fatalf("remembered: %v", err)
		}
	}
	if h.asked["civitai_made-up"] != 1 || len(outcomes) != 3*NewTokenBurst || outcomes[0] != GuardRemembered {
		t.Fatalf("🔴 the hub was asked %d times for one refused token (observed %d)", h.asked["civitai_made-up"], len(outcomes))
	}
	if _, err := g.Exchange(from("198.51.100.7"), "civitai_alice"); err != nil {
		t.Fatalf("the address was charged for remembered refusals: %v", err)
	}
	// Past refusalMemory, the hub is asked again.
	*now = now.Add(refusalMemory)
	_, _ = g.Exchange(from("198.51.100.8"), "civitai_made-up")
	if h.asked["civitai_made-up"] != 2 {
		t.Fatalf("after the memory: asked %d, want 2", h.asked["civitai_made-up"])
	}
}

// Only the hub's refusal is remembered: a failure or a 429 says nothing about the token.
func TestTheGuardRemembersOnlyRefusals(t *testing.T) {
	calls := 0
	g := &Guard{Hub: func(context.Context, string) (Token, error) {
		calls++
		if calls%2 == 1 {
			return Token{}, &RateLimitedError{RetryAfter: time.Second}
		}
		return Token{}, errors.New("exchange: token endpoint unreachable")
	}}
	for range 4 {
		_, _ = g.Exchange(context.Background(), "civitai_alice")
	}
	if calls != 4 {
		t.Fatalf("hub asked %d times, want 4", calls)
	}
}

func TestTheGuardsMapsAreBounded(t *testing.T) {
	g, _, now := newGuard()
	g.Hub = func(_ context.Context, subject string) (Token, error) {
		return Token{Access: "x"}, nil
	}
	for i := range MaxKnownTokens + 10 {
		_, _ = g.Exchange(context.Background(), fmt.Sprintf("civitai_%d", i))
	}
	for i := range MaxThrottledAddresses + 10 {
		g.mu.Lock()
		g.charge(fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255), *now)
		g.mu.Unlock()
	}
	g.mu.Lock()
	known, addrs := len(g.known), len(g.addrs)
	g.mu.Unlock()
	if known != MaxKnownTokens || addrs != MaxThrottledAddresses {
		t.Fatalf("known %d addresses %d", known, addrs)
	}
	// A sweep past every memory empties them.
	*now = now.Add(knownMemory)
	_, _ = g.Exchange(context.Background(), "civitai_last")
	g.mu.Lock()
	known, addrs = len(g.known), len(g.addrs)
	g.mu.Unlock()
	if known != 1 || addrs != 0 {
		t.Fatalf("after the sweep: known %d addresses %d", known, addrs)
	}
}

func TestClientIPFromTheEdgeHeader(t *testing.T) {
	cases := map[string]string{
		"203.0.113.5":           "203.0.113.5",
		" 2001:db8::1 ":         "2001:db8::1",
		"::ffff:203.0.113.5":    "203.0.113.5",
		"":                      "",
		"203.0.113.5, 10.0.0.1": "",
		"not-an-address":        "",
		"203.0.113.5:443":       "",
	}
	for in, want := range cases {
		h := http.Header{}
		if in != "" {
			h.Set(ClientIPHeader, in)
		}
		if got := ClientIPFrom(h); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestTheExchangeForwardsTheViewersAddressOnly(t *testing.T) {
	var got []string
	e := hub(t, func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("X-Forwarded-For"))
		_, _ = io.WriteString(w, `{"access_token":"eyJexchanged","expires_in":900}`)
	})
	_, _ = e.Exchange(WithClientIP(context.Background(), "203.0.113.5"), "civitai_user-token")
	_, _ = e.Exchange(WithClientIP(context.Background(), ""), "civitai_user-token")
	if len(got) != 2 || got[0] != "203.0.113.5" || got[1] != "" {
		t.Fatalf("X-Forwarded-For %q", got)
	}
}

// madeUp is n exchanges of distinct made-up tokens named prefix-i, each from the address at(i); it is
// how many reached the hub.
func madeUp(g *Guard, h *guardHub, prefix string, n int, at func(i int) string) int {
	before := h.total()
	for i := range n {
		_, _ = g.Exchange(from(at(i)), fmt.Sprintf("%s-%03d", prefix, i))
	}
	return h.total() - before
}

// One host holds a whole IPv6 /64: its addresses share one budget. Two /64s do not, and IPv4 stays per
// address. The hub is still told the viewer's own address, not the prefix.
func TestTheGuardChargesAnIPv6AddressToItsSlash64(t *testing.T) {
	g, h, _ := newGuard()
	var forwarded []string
	hub := g.Hub
	g.Hub = func(ctx context.Context, subject string) (Token, error) {
		forwarded = append(forwarded, ClientIP(ctx))
		return hub(ctx, subject)
	}
	// 3×burst addresses of one /64, each with one made-up token.
	sent := madeUp(g, h, "civitai_v6", 3*NewTokenBurst, func(i int) string { return fmt.Sprintf("2001:db8:1:2::%x", i+1) })
	if sent != NewTokenBurst {
		t.Fatalf("🔴 one /64 rotating its addresses reached the hub %d times, want the burst %d", sent, NewTokenBurst)
	}
	if forwarded[0] != "2001:db8:1:2::1" || forwarded[NewTokenBurst-1] != "2001:db8:1:2::14" {
		t.Fatalf("the hub was told %q … %q, want each viewer's own address", forwarded[0], forwarded[NewTokenBurst-1])
	}
	// Another /64 of the same /48 has its own budget.
	if sent := madeUp(g, h, "civitai_v6-other", 1, func(int) string { return "2001:db8:1:3::1" }); sent != 1 {
		t.Fatalf("another /64 was charged to the first: reached the hub %d times, want 1", sent)
	}
	// IPv4 neighbours do not share one.
	g4, h4, _ := newGuard()
	if sent := madeUp(g4, h4, "civitai_v4", 3*NewTokenBurst, func(i int) string { return fmt.Sprintf("198.51.100.%d", i+1) }); sent != 3*NewTokenBurst {
		t.Fatalf("IPv4 addresses shared a budget: %d of %d reached the hub", sent, 3*NewTokenBurst)
	}
	// An address that does not parse is its own budget, as it was named.
	if sent := madeUp(g4, h4, "civitai_odd", 3*NewTokenBurst, func(int) string { return "not-an-address" }); sent != NewTokenBurst {
		t.Fatalf("an unparsed address: %d reached the hub, want the burst %d", sent, NewTokenBurst)
	}
}

// A full address table never admits a new address untracked: that would turn the throttle off for
// everyone once one attacker filled it. The least recently charged address makes room.
func TestAFullAddressTableStillThrottlesANewAddress(t *testing.T) {
	g, h, now := newGuard()
	_, _ = g.Exchange(context.Background(), "civitai_alice") // the maps exist
	for i := range MaxThrottledAddresses {
		g.mu.Lock()
		g.charge(fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255), *now)
		g.mu.Unlock()
		if i == 0 {
			*now = now.Add(time.Millisecond) // 10.0.0.0 is the least recently charged
		}
	}
	sent := madeUp(g, h, "civitai_late", 3*NewTokenBurst, func(int) string { return "203.0.113.200" })
	if sent != NewTokenBurst {
		t.Fatalf("🔴 a new address past a full table reached the hub %d times, want the burst %d", sent, NewTokenBurst)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	_, oldest := g.addrs["10.0.0.0"]
	_, newer := g.addrs["10.0.0.1"]
	if len(g.addrs) != MaxThrottledAddresses || oldest || !newer {
		t.Fatalf("table %d (bound %d), oldest kept %v, the next kept %v", len(g.addrs), MaxThrottledAddresses, oldest, newer)
	}
}

// Many viewers behind one address (an office, a carrier NAT) each present a token the hub exchanges:
// none of them is charged, so the address's budget is left for tokens the hub cannot find.
func TestTokensTheHubExchangesAreNotChargedToTheAddress(t *testing.T) {
	g, h, _ := newGuard()
	const shared = "198.51.100.7"
	for i := range 3 * NewTokenBurst {
		h.valid[fmt.Sprintf("civitai_viewer-%03d", i)] = true
	}
	for i := range 3 * NewTokenBurst {
		if _, err := g.Exchange(from(shared), fmt.Sprintf("civitai_viewer-%03d", i)); err != nil {
			t.Fatalf("🔴 viewer %d behind a shared address: %v", i, err)
		}
	}
	// The budget is whole: the burst of made-up tokens, and no more.
	if sent := madeUp(g, h, "civitai_made-up", 2*NewTokenBurst, func(int) string { return shared }); sent != NewTokenBurst {
		t.Fatalf("after %d exchanged viewers, %d made-up tokens reached the hub, want the burst %d", 3*NewTokenBurst, sent, NewTokenBurst)
	}
}

// heldHub is a fake user exchange answering every call the hub's 429: per client (the Exchanger's
// hold) or, scoped, per viewer. calls counts them.
type heldHub struct {
	scoped bool
	calls  int
}

func (h *heldHub) exchange(context.Context, string) (Token, error) {
	h.calls++
	return Token{}, &RateLimitedError{RetryAfter: time.Second, Scoped: h.scoped}
}

// While the hub holds every exchange (its per-client 429), no subject is looked up, so nothing is
// charged. The hub's per-viewer 429 on subjects it could not find follows lookups made: charged.
func TestAnExchangeTheHubHoldsIsNotCharged(t *testing.T) {
	g, h, _ := newGuard()
	held := &heldHub{}
	g.Hub = held.exchange
	for i := range 3 * NewTokenBurst {
		_, _ = g.Exchange(from("198.51.100.7"), fmt.Sprintf("civitai_held-%03d", i))
	}
	if held.calls != 3*NewTokenBurst {
		t.Fatalf("🔴 %d of %d held exchanges were let through: the hold was charged to the address", held.calls, 3*NewTokenBurst)
	}
	g.Hub = h.exchange
	if sent := madeUp(g, h, "civitai_made-up", 2*NewTokenBurst, func(int) string { return "198.51.100.7" }); sent != NewTokenBurst {
		t.Fatalf("after the hold, %d made-up tokens reached the hub, want the burst %d", sent, NewTokenBurst)
	}
	// Control: the per-viewer 429 is charged.
	g2, _, _ := newGuard()
	missed := &heldHub{scoped: true}
	g2.Hub = missed.exchange
	for i := range 3 * NewTokenBurst {
		_, _ = g2.Exchange(from("198.51.100.7"), fmt.Sprintf("civitai_missed-%03d", i))
	}
	if missed.calls != NewTokenBurst {
		t.Fatalf("the hub's per-viewer 429 was let through %d times, want the burst %d", missed.calls, NewTokenBurst)
	}
}

// blockingHub is a fake user exchange that waits for release (or the call's context) before it
// answers as h does; entered counts the calls.
type blockingHub struct {
	h       *guardHub
	release chan struct{}
	mu      sync.Mutex
	entered int
}

func (b *blockingHub) exchange(ctx context.Context, subject string) (Token, error) {
	b.mu.Lock()
	b.entered++
	b.mu.Unlock()
	select {
	case <-b.release:
	case <-ctx.Done():
		return Token{}, ctx.Err()
	}
	return b.h.exchange(ctx, subject)
}

func (b *blockingHub) calls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.entered
}

// A first load opens several streams at once, each exchanging the same new token: one hub call, one
// charge (and that one refunded, as the hub exchanged the token).
func TestConcurrentExchangesOfOneTokenAreOneHubCall(t *testing.T) {
	g, h, _ := newGuard()
	b := &blockingHub{h: h, release: make(chan struct{})}
	g.Hub = b.exchange
	var mu sync.Mutex
	var outcomes []string
	g.Observe = func(o string) { mu.Lock(); outcomes = append(outcomes, o); mu.Unlock() }
	const streams = 8
	errs := make(chan error, streams)
	var wg sync.WaitGroup
	for range streams {
		wg.Go(func() {
			tok, err := g.Exchange(from("198.51.100.7"), "civitai_alice")
			if err == nil && tok.Access != "x.civitai_alice" {
				err = fmt.Errorf("token %q", tok.Access)
			}
			errs <- err
		})
	}
	// Wait (bounded) until every stream is either at the hub or waiting on another's call.
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		mu.Lock()
		joined := len(outcomes)
		mu.Unlock()
		if b.calls()+joined >= streams {
			break
		}
	}
	close(b.release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := b.calls(); n != 1 {
		t.Fatalf("🔴 %d concurrent exchanges of one token made %d hub calls, want 1", streams, n)
	}
	if len(outcomes) != streams-1 || outcomes[0] != "joined" {
		t.Fatalf("observed %v, want %d joined", outcomes, streams-1)
	}
	// Nothing stayed charged: the address has its whole burst for made-up tokens.
	g.Hub = h.exchange
	if sent := madeUp(g, h, "civitai_made-up", 2*NewTokenBurst, func(int) string { return "198.51.100.7" }); sent != NewTokenBurst {
		t.Fatalf("%d made-up tokens reached the hub after the concurrent exchange, want the burst %d", sent, NewTokenBurst)
	}
}

// A caller waiting on another's call for the same token stops waiting when its own context ends.
func TestAWaitingExchangeEndsWithItsContext(t *testing.T) {
	g, h, _ := newGuard()
	b := &blockingHub{h: h, release: make(chan struct{})}
	g.Hub = b.exchange
	leader := make(chan error, 1)
	go func() {
		_, err := g.Exchange(from("198.51.100.7"), "civitai_alice")
		leader <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if b.calls() > 0 {
			break
		}
	}
	ctx, cancel := context.WithCancel(from("198.51.100.8"))
	cancel()
	if _, err := g.Exchange(ctx, "civitai_alice"); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled waiter: %v", err)
	}
	close(b.release)
	if err := <-leader; err != nil {
		t.Fatal(err)
	}
}

// Distinct made-up tokens sent at once from one address are bounded as when sent one by one: the
// charge is taken before the hub is asked. (An invariant guard: it held before the refund too.)
func TestConcurrentMadeUpTokensFromOneAddressAreStillBounded(t *testing.T) {
	g, h, _ := newGuard()
	var wg sync.WaitGroup
	for i := range 3 * NewTokenBurst {
		wg.Go(func() { _, _ = g.Exchange(from("198.51.100.7"), fmt.Sprintf("civitai_made-up-%03d", i)) })
	}
	wg.Wait()
	if n := h.total(); n != NewTokenBurst {
		t.Fatalf("🔴 %d concurrent made-up tokens reached the hub %d times, want the burst %d", 3*NewTokenBurst, n, NewTokenBurst)
	}
}

// Only a refusal of the subject token is remembered for it. A refusal of this service's own client
// (its secret, its listing for the resource) or of the request says nothing about the token: answering
// it from memory would keep refusing every viewer after the client is fixed.
func TestOnlyARefusalOfTheSubjectIsRemembered(t *testing.T) {
	for code, remembered := range map[string]bool{
		"invalid_grant": true, "invalid_scope": true,
		"invalid_client": false, "unauthorized_client": false, "invalid_target": false, "invalid_request": false,
	} {
		calls := 0
		g := &Guard{Hub: func(context.Context, string) (Token, error) {
			calls++
			return Token{}, &RefusedError{Status: 400, Code: code}
		}}
		for range 3 {
			if _, err := g.Exchange(context.Background(), "civitai_alice"); RefusalCode(err) != code {
				t.Fatalf("%s: answered %v", code, err)
			}
		}
		if want := map[bool]int{true: 1, false: 3}[remembered]; calls != want {
			t.Errorf("🔴 %s: the hub was asked %d times for 3 exchanges, want %d", code, calls, want)
		}
	}
}
