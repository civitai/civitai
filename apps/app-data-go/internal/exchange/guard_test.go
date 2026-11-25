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
			if errors.Is(err, ErrRefused) || te.RetryAfter <= 0 || te.RetryAfter > NewTokenEvery {
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
	_, _ = e.Exchange(context.Background(), "civitai_user-token")
	if len(got) != 2 || got[0] != "203.0.113.5" || got[1] != "" {
		t.Fatalf("X-Forwarded-For %q", got)
	}
}
