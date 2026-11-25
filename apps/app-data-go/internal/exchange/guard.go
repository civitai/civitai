package exchange

import (
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

// The per-address budget for exchanges of hub tokens this replica has not seen exchanged: a burst of
// NewTokenBurst, refilled one every NewTokenEvery (20 a minute). A token the hub issued an exchange for
// is never charged again (knownMemory), so a viewer pays once per token per replica start; the budget
// only binds an address presenting many different tokens, which is what a flood of made-up ones is.
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

// The bounds of the guard's three maps. Past MaxKnownTokens a successful token is not remembered (it is
// charged again on its next exchange); past MaxRememberedRefusals (block.go, the same bound) a refusal
// is not remembered (the hub is asked again); past MaxThrottledAddresses a new address is admitted
// untracked: the hub's own per-subject limit is the backstop then, and a flood of addresses never
// refuses a viewer here.
const (
	MaxKnownTokens        = 50_000
	MaxThrottledAddresses = 50_000
)

// The outcomes Guard.Observe reports (metrics.GuardOutcomes): a hub token not sent to the hub.
const (
	GuardThrottled  = "throttled"  // the address has spent its budget for new tokens
	GuardRemembered = "remembered" // the hub refused this token within refusalMemory
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
//   - a token the hub refused is answered that refusal again for refusalMemory, the hub not asked;
//   - a token not seen exchanged here is charged to the viewer's address (ClientIP of the context), a
//     budget of NewTokenBurst refilled every NewTokenEvery; past it the exchange is ThrottledError and
//     the hub is not asked. A request with no address is not charged (ClientIPHeader).
//
// Entries are keyed by the SHA-256 of the whole token; no token is stored.
type Guard struct {
	// Hub is the exchange guarded (Exchanger.Exchange).
	Hub func(ctx context.Context, subject string) (Token, error)
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Observe is told each exchange not sent (GuardThrottled, GuardRemembered). Nil is none.
	Observe func(outcome string)

	mu      sync.Mutex
	known   map[[sha256.Size]byte]time.Time
	refused map[[sha256.Size]byte]remembered
	addrs   map[string]*allowance
	swept   time.Time
}

type remembered struct {
	err   error
	until time.Time
}

// allowance is an address's budget: tokens left at `at`.
type allowance struct {
	left float64
	at   time.Time
}

// Exchange is Hub's exchange of subject, unless subject was refused within refusalMemory or the
// viewer's address has spent its budget for new tokens.
func (g *Guard) Exchange(ctx context.Context, subject string) (Token, error) {
	k := sha256.Sum256([]byte(subject))
	now := g.now()
	g.mu.Lock()
	if g.known == nil {
		g.known = map[[sha256.Size]byte]time.Time{}
		g.refused = map[[sha256.Size]byte]remembered{}
		g.addrs = map[string]*allowance{}
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
	if until, ok := g.known[k]; !ok || !now.Before(until) {
		if wait := g.charge(ClientIP(ctx), now); wait > 0 {
			g.mu.Unlock()
			g.observe(GuardThrottled)
			return Token{}, &ThrottledError{RetryAfter: wait}
		}
	}
	g.mu.Unlock()

	tok, err := g.Hub(ctx, subject)

	g.mu.Lock()
	defer g.mu.Unlock()
	switch {
	case err == nil:
		delete(g.refused, k)
		if _, ok := g.known[k]; ok || len(g.known) < MaxKnownTokens {
			g.known[k] = now.Add(knownMemory)
		}
	case errors.Is(err, ErrRefused):
		delete(g.known, k)
		if len(g.refused) < MaxRememberedRefusals {
			g.refused[k] = remembered{err: err, until: now.Add(refusalMemory)}
		}
	}
	return tok, err
}

// charge takes one from ip's budget at now: zero when it had one (or ip is untracked), else how long
// until it has. g.mu is held.
func (g *Guard) charge(ip string, now time.Time) time.Duration {
	if ip == "" {
		return 0
	}
	a := g.addrs[ip]
	if a == nil {
		if len(g.addrs) >= MaxThrottledAddresses {
			return 0
		}
		a = &allowance{left: NewTokenBurst, at: now}
		g.addrs[ip] = a
	}
	a.left = min(float64(NewTokenBurst), a.left+float64(now.Sub(a.at))/float64(NewTokenEvery))
	a.at = now
	if a.left >= 1 {
		a.left--
		return 0
	}
	return time.Duration((1 - a.left) * float64(NewTokenEvery))
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
	full := time.Duration(NewTokenBurst) * NewTokenEvery
	for ip, a := range g.addrs {
		if now.Sub(a.at) >= full {
			delete(g.addrs, ip)
		}
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
