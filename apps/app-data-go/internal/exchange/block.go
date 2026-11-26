package exchange

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"sync"
	"time"
)

// HubTokenPrefix starts every OAuth access token the hub issues (apps/auth OAUTH_TOKEN_PREFIX). The
// hub's user exchange looks its subject up among its own access tokens (user-exchange.ts, step 5), so
// only such a token can be exchanged as a user's token.
const HubTokenPrefix = "civitai_"

// Kind is what a bearer token is, as far as the exchange is concerned.
type Kind int

const (
	// KindOther is neither: never sent to the hub.
	KindOther Kind = iota
	// KindHub is one of the hub's own access tokens: the user exchange.
	KindHub
	// KindBlock has the shape of an App Block token (a JWS in compact form): the block exchange, when
	// it is on. The shape only routes the token; the hub alone decides whether it is one.
	KindBlock
)

// KindOf classifies token. Nothing is decoded or trusted: a hub token by its prefix, a block token by
// its compact-JWS shape (three non-empty base64url segments).
func KindOf(token string) Kind {
	if strings.HasPrefix(token, HubTokenPrefix) {
		return KindHub
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return KindOther
	}
	for _, p := range parts {
		if p == "" || strings.Trim(p, base64URL) != "" {
			return KindOther
		}
	}
	return KindBlock
}

// base64URL is the alphabet of a JWS compact segment (RFC 7515: base64url, no padding).
const base64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// ErrNotExchangeable is a token the Router sends nowhere: neither a hub token nor, with the block
// exchange on, a block token. Not a refusal by the hub, which was not asked.
var ErrNotExchangeable = errors.New("exchange: this token is not exchanged")

// Router is THE one place that decides which tokens are exchanged, and how: the HTTP handler asks
// Accepts before it opens a stream, and the stream calls Exchange, so the two cannot disagree. Blocks
// nil is the block exchange off (APP_DATA_BLOCK_EXCHANGE).
type Router struct {
	// User is the user exchange (Exchanger.Exchange).
	User func(ctx context.Context, subject string) (Token, error)
	// Blocks is the block exchange's cache; nil is off.
	Blocks *BlockCache
}

// Accepts reports whether token is one Exchange sends to the hub: a hub token always, a block token
// only with the block exchange on.
func (r *Router) Accepts(token string) bool {
	switch KindOf(token) {
	case KindHub:
		return true
	case KindBlock:
		return r.Blocks != nil
	default:
		return false
	}
}

// Exchange sends a hub token to the user exchange and, with the block exchange on, a block token to
// the block cache. Any other token, a block token with it off included, is sent nowhere: a block
// token never reaches the user exchange.
func (r *Router) Exchange(ctx context.Context, subject string) (Token, error) {
	switch {
	case KindOf(subject) == KindHub:
		return r.User(ctx, subject)
	case KindOf(subject) == KindBlock && r.Blocks != nil:
		return r.Blocks.Exchange(ctx, subject)
	default:
		return Token{}, ErrNotExchangeable
	}
}

// MaxTokenLife is the longest an exchanged token lives (the hub's EXCHANGED_TOKEN_MAX_TTL). A block
// exchange's answer is held to it whatever expires_in says.
const MaxTokenLife = 15 * time.Minute

// blockMemory is how long a block token is remembered after its exchange. The hub refuses a block
// token older than 15 minutes (with 30 s of clock tolerance) and only exchanges a token it has never
// exchanged, so past this no exchange of a remembered token could succeed anyway.
const blockMemory = MaxTokenLife + time.Minute

// MaxBlockTokens bounds how many block tokens the cache holds a token for (or is exchanging) at
// once. Only a token the hub issued stays, so tokens the hub refuses can never fill it.
const MaxBlockTokens = 10_000

// MaxRememberedRefusals bounds the refusals remembered, kept apart from the issued tokens: any
// token of the right shape is sent to the hub, so refusals are what a flood of made-up tokens
// produces. Past it a refusal is not remembered (the hub is asked again for that token, and refuses
// again); a flood never evicts, or locks out, an issued token.
const MaxRememberedRefusals = 1_000

// sweepEvery is how often the expired entries are forgotten: a scan of both maps, at most once per
// interval, so a full cache answers in O(1).
const sweepEvery = time.Minute

// Why a block token's exchange was not made. Neither is a refusal by the hub, so a live stream that
// re-checks and gets one keeps serving until its own expiry closes it.
var (
	// ErrSpent is a block token whose one exchange happened and whose exchanged token is (about to
	// be) expired. The hub would refuse it as a replay; it is not asked.
	ErrSpent = errors.New("exchange: the block token's exchanged token has expired; it cannot be exchanged again")
	// ErrBlockCacheFull is MaxBlockTokens held and none forgettable yet.
	ErrBlockCacheFull = errors.New("exchange: too many block tokens remembered")
)

// The outcomes BlockCache.Observe reports (metrics.BlockOutcomes).
const (
	BlockIssued     = "issued"     // the hub issued a token
	BlockReused     = "reused"     // a token issued earlier for the same block token was handed out
	BlockRefused    = "refused"    // the hub refused the exchange
	BlockRemembered = "remembered" // an earlier refusal was answered again, the hub not asked
	BlockFailed     = "failed"     // the hub could not be asked or did not answer (no token issued)
	BlockSpent      = "spent"      // ErrSpent
	BlockFull       = "full"       // ErrBlockCacheFull
	// BlockUnverifiable: the token could not be checked here (ErrBlockUnverifiable: the site's JWKS
	// could not be fetched); not sent to the hub, not remembered.
	BlockUnverifiable = "unverifiable"
	// BlockRateLimited: the hub answered 429, or an earlier 429's wait was still running so the hub
	// was not asked (RateLimitedError). No token issued, not remembered.
	BlockRateLimited = "rate_limited"
)

// BlockCache makes at most one successful exchange per App Block token: the hub refuses a second
// one (it claims the block token's `jti`), so a token it issued is handed to every stream of that
// block token until it expires, and a refusal is remembered (up to MaxRememberedRefusals, apart from
// the issued tokens) rather than asked again. Only a failure
// (the hub unreachable, a 5xx, a timeout: no token issued, and the hub gives a claim it made back) is
// forgotten, so a later read may try again.
//
// Entries are keyed by the SHA-256 of the whole token, never by a claim read from it: nothing here
// decodes a block token, and a token that merely reuses another's `jti` can never be handed the
// other's exchanged token.
type BlockCache struct {
	// Hub is the exchange (Exchanger.ExchangeBlock).
	Hub func(ctx context.Context, subject string) (Token, error)
	// Verify checks a block token before Hub is called (BlockVerifier.Check): a token it refuses (an
	// ErrRefused, code `local`) is remembered like a hub refusal, and one it cannot check
	// (ErrBlockUnverifiable) is forgotten; neither is sent to the hub. Nil sends every token.
	Verify func(ctx context.Context, subject string) error
	// Margin: a token issued earlier is handed out only while it has more than this left (the
	// stream's expiry margin, so a stream is never opened with a token about to be closed for it).
	Margin time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Observe is told each exchange's outcome and, for a refusal, the hub's code (RefusalCode;
	// `none` otherwise). Nil is none. Never a token.
	Observe func(outcome, code string)

	mu      sync.Mutex
	entries map[[sha256.Size]byte]*blockEntry // issued, or being exchanged
	refused map[[sha256.Size]byte]*blockEntry // refusals remembered
	swept   time.Time
}

type blockEntry struct {
	done   chan struct{} // closed once the exchange returned
	tok    Token
	err    error
	forget time.Time // zero while the exchange runs
	// waiters is how many calls have waited on this exchange (an observable for tests; c.mu held).
	waiters int
}

// Exchange returns the token exchanged for subject, an App Block token, exchanging it at the hub only
// if it never was. Concurrent calls for one block token share one exchange.
func (c *BlockCache) Exchange(ctx context.Context, subject string) (Token, error) {
	k := sha256.Sum256([]byte(subject))
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[[sha256.Size]byte]*blockEntry{}
		c.refused = map[[sha256.Size]byte]*blockEntry{}
	}
	if r := c.refused[k]; r != nil && c.now().Before(r.forget) {
		c.mu.Unlock()
		return c.again(r)
	}
	e := c.entries[k]
	if e == nil {
		now := c.now()
		if now.Sub(c.swept) >= sweepEvery {
			c.forget(now)
			c.swept = now
		}
		if len(c.entries) >= MaxBlockTokens {
			c.mu.Unlock()
			c.observe(BlockFull, nil)
			return Token{}, ErrBlockCacheFull
		}
		e = &blockEntry{done: make(chan struct{})}
		c.entries[k] = e
		c.mu.Unlock()
		return c.first(ctx, k, e, subject, now)
	}
	e.waiters++
	c.mu.Unlock()
	select {
	case <-e.done:
	case <-ctx.Done():
		return Token{}, ctx.Err()
	}
	return c.again(e)
}

// first makes the exchange and records its outcome.
func (c *BlockCache) first(ctx context.Context, k [sha256.Size]byte, e *blockEntry, subject string, start time.Time) (Token, error) {
	var tok Token
	var err error
	if c.Verify != nil {
		err = c.Verify(ctx, subject)
	}
	if err == nil {
		tok, err = c.Hub(ctx, subject)
	}
	c.mu.Lock()
	switch {
	case err == nil:
		if limit := start.Add(MaxTokenLife); tok.Expires.After(limit) {
			tok.Expires = limit
		}
		e.tok, e.forget = tok, start.Add(blockMemory)
	case errors.Is(err, ErrRefused):
		// Out of the issued tokens' map either way; remembered only while there is room.
		e.err, e.forget = err, start.Add(blockMemory)
		delete(c.entries, k)
		if len(c.refused) < MaxRememberedRefusals {
			c.refused[k] = e
		}
	default:
		// No token was issued: forgotten, so a later read may try again. Callers waiting on this
		// exchange get its error.
		e.err = err
		delete(c.entries, k)
	}
	close(e.done)
	c.mu.Unlock()
	switch {
	case err == nil:
		c.observe(BlockIssued, nil)
	case errors.Is(err, ErrRefused):
		c.observe(BlockRefused, err)
	case errors.Is(err, ErrBlockUnverifiable):
		c.observe(BlockUnverifiable, nil)
	case errors.As(err, new(*RateLimitedError)):
		c.observe(BlockRateLimited, nil)
	default:
		c.observe(BlockFailed, nil)
	}
	return tok, err
}

// again answers from an exchange already made.
func (c *BlockCache) again(e *blockEntry) (Token, error) {
	switch {
	case errors.Is(e.err, ErrRefused):
		c.observe(BlockRemembered, e.err)
		return Token{}, e.err
	case e.err != nil:
		// A failure another call was waiting on; already observed once.
		return Token{}, e.err
	case !c.now().Before(e.tok.Expires.Add(-c.Margin)):
		c.observe(BlockSpent, nil)
		return Token{}, ErrSpent
	}
	c.observe(BlockReused, nil)
	return e.tok, nil
}

// forget drops every entry past its memory. c.mu is held.
func (c *BlockCache) forget(now time.Time) {
	for _, m := range []map[[sha256.Size]byte]*blockEntry{c.entries, c.refused} {
		for k, e := range m {
			if !e.forget.IsZero() && !now.Before(e.forget) {
				delete(m, k)
			}
		}
	}
}

// Len is how many block tokens the cache holds a token for (or is exchanging) now, and how many
// refusals it remembers.
func (c *BlockCache) Len() (issued, refused int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries), len(c.refused)
}

func (c *BlockCache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *BlockCache) observe(outcome string, err error) {
	if c.Observe != nil {
		c.Observe(outcome, RefusalCode(err))
	}
}
