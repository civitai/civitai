package exchange

import (
	"container/list"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// ClientIPHeader is the edge's header naming the viewer's address. Cloudflare sets it on every request
// it forwards and replaces any value the client sent, as it replaces the region headers this service
// already trusts on the same precondition (WRITES-DESIGN.md, "Region"). A request without it did not
// come through the edge (an in-cluster caller, such as the site's shadow read). Such a request is not
// throttled per address (Guard) and no address is forwarded to the hub for it.
const ClientIPHeader = "CF-Connecting-IP"

// ClientIPFrom is the viewer's address from the edge's header, canonical, or "" when the header is
// absent or not one address.
func ClientIPFrom(h http.Header) string {
	addr, err := netip.ParseAddr(strings.TrimSpace(h.Get(ClientIPHeader)))
	if err != nil {
		return ""
	}
	return addr.Unmap().String()
}

type clientIPKey struct{}

// WithClientIP is ctx carrying ip, the viewer's address (ClientIPFrom); "" carries none.
func WithClientIP(ctx context.Context, ip string) context.Context {
	if ip == "" {
		return ctx
	}
	return context.WithValue(ctx, clientIPKey{}, ip)
}

// ClientIP is the viewer's address ctx carries, or "".
func ClientIP(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	return ip
}

// budgetKey is the budget ip is charged to: an IPv4 address itself, an IPv6 address its /64. One host
// is routinely handed a whole /64 and may use any address in it, so a per-address key would hand it a
// fresh burst per address. An ip that does not parse is its own key. The hub is still told ip itself
// (Exchanger.Exchange).
func budgetKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is4() {
		return addr.String()
	}
	return netip.PrefixFrom(addr, 64).Masked().String()
}

// The per-address budget for lookups of hub tokens this replica has not seen exchanged: a burst of
// NewTokenBurst, refilled one every NewTokenEvery (20 a minute). An address is an IPv4 address or an
// IPv6 /64 (budgetKey). A token is charged before the hub is asked, so the budget bounds how many
// distinct unproven tokens an address can have the hub look up, concurrent or not; the charge is given
// back when the hub exchanges the token, or when the hub was never asked (its per-client hold). So only
// tokens the hub could not exchange stay charged: many viewers with real tokens behind one address
// never spend it, a flood of made-up tokens does. A token the hub exchanged is never charged again
// (knownMemory).
const (
	NewTokenBurst = 20
	NewTokenEvery = 3 * time.Second
)

// knownMemory is how long a token the hub exchanged is exempt from the per-address budget. The hub's
// answers for it are its own (a re-check that the hub refuses closes the stream as before).
const knownMemory = time.Hour

// refusalMemory is how long a token the hub refused is answered that refusal again without asking the
// hub. Short: an app re-enabled or a grant re-made is seen again within it.
const refusalMemory = 2 * time.Minute

// The bounds of the guard's maps. Past MaxKnownTokens a successful token is not remembered (it is
// charged again on its next exchange, and given the charge back); past MaxRememberedRefusals (block.go,
// the same bound) a refusal is not remembered (the hub is asked again). At MaxThrottledAddresses a new
// address takes the place of the address charged least recently: never admitted untracked, which would
// turn the throttle off for every address once one flood filled the table. The address dropped is the
// one whose budget has refilled the longest, so it loses at most a partial refill.
const (
	MaxKnownTokens        = 50_000
	MaxThrottledAddresses = 50_000
)

// The outcomes Guard.Observe reports (metrics.GuardOutcomes): a hub token not sent to the hub.
const (
	GuardThrottled  = "throttled"  // the address has spent its budget for new tokens
	GuardRemembered = "remembered" // the hub refused this token within refusalMemory
	GuardJoined     = "joined"     // the same token's exchange was in flight: its answer was shared
)

// ThrottledError is an exchange not made because the viewer's address has presented too many tokens
// this replica has not seen exchanged. Not a refusal (the token may be fine) and not the hub's 429: it
// holds back nothing but this address's new tokens.
type ThrottledError struct {
	RetryAfter time.Duration
}

func (e *ThrottledError) Error() string {
	return fmt.Sprintf("exchange: too many new tokens from this address (retry in %s)", e.RetryAfter)
}

// Guard sits in front of the user exchange (Exchanger.Exchange), so a flood of made-up `civitai_`
// tokens costs this service neither the hub's per-client budget nor its hold:
//
//   - a token the hub refused as a subject (subjectRefusal) is answered that refusal again for
//     refusalMemory, the hub not asked;
//   - concurrent exchanges of one token are one call to the hub, its answer shared (GuardJoined);
//   - a token not seen exchanged here is charged to the viewer's address (ClientIP of the context,
//     budgetKey), a budget of NewTokenBurst refilled every NewTokenEvery; past it the exchange is
//     ThrottledError and the hub is not asked. A request with no address is not charged
//     (ClientIPHeader).
//
// Entries are keyed by the SHA-256 of the whole token; no token is stored.
type Guard struct {
	// Hub is the exchange guarded (Exchanger.Exchange).
	Hub func(ctx context.Context, subject string) (Token, error)
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Observe is told each exchange not sent (GuardThrottled, GuardRemembered, GuardJoined). Nil is none.
	Observe func(outcome string)

	mu      sync.Mutex
	known   map[[sha256.Size]byte]time.Time
	refused map[[sha256.Size]byte]remembered
	// addrs holds each tracked address's element of recent, which runs from the most recently charged
	// (front) to the least (back).
	addrs    map[string]*list.Element
	recent   *list.List
	inflight map[[sha256.Size]byte]*flight
	swept    time.Time
}

type remembered struct {
	err   error
	until time.Time
}

// allowance is an address's budget: tokens left at `at`, its last charge.
type allowance struct {
	key  string
	left float64
	at   time.Time
}

// flight is one exchange at the hub, awaited by the exchanges of the same token that came after it.
type flight struct {
	done chan struct{}
	tok  Token
	err  error
}

// NewRouter is the Router the user exchange user is served through, behind a Guard telling observe
// (nil: none) each exchange not sent; and the Guard. main and the api tests both build it here, so the
// guard a test exercises is the one served. The block exchange (Router.Blocks) is set by the caller.
func NewRouter(user func(ctx context.Context, subject string) (Token, error), observe func(outcome string)) (*Router, *Guard) {
	g := &Guard{Hub: user, Observe: observe}
	return &Router{User: g.Exchange}, g
}

// Exchange is Hub's exchange of subject, unless subject was refused within refusalMemory, the same
// subject's exchange is in flight (its answer is this one's), or the viewer's address has spent its
// budget for new tokens.
func (g *Guard) Exchange(ctx context.Context, subject string) (Token, error) {
	k := sha256.Sum256([]byte(subject))
	g.mu.Lock()
	// Read under the lock, so the charges' times never run backwards (charge, sweep).
	now := g.now()
	if g.known == nil {
		g.known = map[[sha256.Size]byte]time.Time{}
		g.refused = map[[sha256.Size]byte]remembered{}
		g.addrs = map[string]*list.Element{}
		g.recent = list.New()
		g.inflight = map[[sha256.Size]byte]*flight{}
	}
	if now.Sub(g.swept) >= sweepEvery {
		g.sweep(now)
		g.swept = now
	}
	if r, ok := g.refused[k]; ok && now.Before(r.until) {
		g.mu.Unlock()
		g.observe(GuardRemembered)
		return Token{}, r.err
	}
	if f, ok := g.inflight[k]; ok {
		g.mu.Unlock()
		g.observe(GuardJoined)
		select {
		case <-f.done:
			// The first caller's own context ended its call: that says nothing of this one's.
			if (errors.Is(f.err, context.Canceled) || errors.Is(f.err, context.DeadlineExceeded)) && ctx.Err() == nil {
				return g.Exchange(ctx, subject)
			}
			return f.tok, f.err
		case <-ctx.Done():
			return Token{}, ctx.Err()
		}
	}
	var charged *allowance
	if until, ok := g.known[k]; !ok || !now.Before(until) {
		var wait time.Duration
		if charged, wait = g.charge(ClientIP(ctx), now); wait > 0 {
			g.mu.Unlock()
			g.observe(GuardThrottled)
			return Token{}, &ThrottledError{RetryAfter: wait}
		}
	}
	f := &flight{done: make(chan struct{})}
	g.inflight[k] = f
	g.mu.Unlock()

	f.tok, f.err = g.Hub(ctx, subject)

	g.mu.Lock()
	delete(g.inflight, k)
	switch {
	case f.err == nil:
		delete(g.refused, k)
		if _, ok := g.known[k]; ok || len(g.known) < MaxKnownTokens {
			g.known[k] = now.Add(knownMemory)
		}
		charged.refund()
	case subjectRefusal(f.err):
		delete(g.known, k)
		if len(g.refused) < MaxRememberedRefusals {
			g.refused[k] = remembered{err: f.err, until: now.Add(refusalMemory)}
		}
	case held(f.err):
		charged.refund()
	}
	g.mu.Unlock()
	close(f.done)
	return f.tok, f.err
}

// subjectRefusal reports whether err is the hub refusing the subject token itself (apps/auth
// user-exchange.ts): `invalid_grant` (not found, expired, its user or app not admitted) or
// `invalid_scope` (outside the user's grant). Only those are remembered per token. The hub's other
// refusals are of this service's client or request (`invalid_client`, `invalid_target`,
// `invalid_request`), or ambiguous (`unauthorized_client` is the relay not listed as well as the app):
// remembering them per token would keep refusing every viewer after the client is fixed.
func subjectRefusal(err error) bool {
	var re *RefusedError
	return errors.As(err, &re) && (re.Code == "invalid_grant" || re.Code == "invalid_scope")
}

// held reports whether err is the hub's per-client hold (RateLimitedError, not Scoped): the subject was
// not looked up. The hub's per-viewer 429 (Scoped) follows lookups made, and stays charged.
func held(err error) bool {
	var rl *RateLimitedError
	return errors.As(err, &rl) && !rl.Scoped
}

// charge takes one from the budget of ip's address (budgetKey) at now: the allowance charged (nil for
// a request with no address) and zero, or how long until it has one. At MaxThrottledAddresses the
// address charged least recently is dropped for a new one. g.mu is held.
func (g *Guard) charge(ip string, now time.Time) (*allowance, time.Duration) {
	if ip == "" {
		return nil, 0
	}
	key := budgetKey(ip)
	el := g.addrs[key]
	if el == nil {
		if len(g.addrs) >= MaxThrottledAddresses {
			oldest := g.recent.Back()
			g.recent.Remove(oldest)
			delete(g.addrs, oldest.Value.(*allowance).key)
		}
		el = g.recent.PushFront(&allowance{key: key, left: NewTokenBurst, at: now})
		g.addrs[key] = el
	}
	g.recent.MoveToFront(el)
	a := el.Value.(*allowance)
	a.left = min(float64(NewTokenBurst), a.left+float64(now.Sub(a.at))/float64(NewTokenEvery))
	a.at = now
	if a.left >= 1 {
		a.left--
		return a, 0
	}
	return nil, time.Duration((1 - a.left) * float64(NewTokenEvery))
}

// refund gives back a charge. On a nil allowance (nothing charged) it does nothing; on one dropped from
// the table since, it changes nothing that is read. g.mu is held.
func (a *allowance) refund() {
	if a != nil {
		a.left = min(float64(NewTokenBurst), a.left+1)
	}
}

// sweep forgets what has expired, and each address whose budget is full again. g.mu is held.
func (g *Guard) sweep(now time.Time) {
	for k, until := range g.known {
		if !now.Before(until) {
			delete(g.known, k)
		}
	}
	for k, r := range g.refused {
		if !now.Before(r.until) {
			delete(g.refused, k)
		}
	}
	// recent runs from the latest charge to the oldest: the full budgets are at its back.
	full := time.Duration(NewTokenBurst) * NewTokenEvery
	for el := g.recent.Back(); el != nil && now.Sub(el.Value.(*allowance).at) >= full; el = g.recent.Back() {
		g.recent.Remove(el)
		delete(g.addrs, el.Value.(*allowance).key)
	}
}

func (g *Guard) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func (g *Guard) observe(outcome string) {
	if g.Observe != nil {
		g.Observe(outcome)
	}
}
