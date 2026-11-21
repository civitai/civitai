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


// Route is the exchange a stream calls: a block token goes to blocks, any other token to user. With
// blocks nil (the block exchange off) it is user itself, so nothing changes.
func Route(user func(context.Context, string) (Token, error), blocks *BlockCache) func(context.Context, string) (Token, error) {
	if blocks == nil {
		return user
	}
	return func(ctx context.Context, subject string) (Token, error) {
		if KindOf(subject) == KindBlock {
			return blocks.Exchange(ctx, subject)
		}
		return user(ctx, subject)
	}
}

// MaxTokenLife is the longest an exchanged token lives (the hub's EXCHANGED_TOKEN_MAX_TTL). A block
// exchange's answer is held to it whatever expires_in says.
const MaxTokenLife = 15 * time.Minute

// blockMemory is how long a block token is remembered after its exchange. The hub refuses a block
// token older than 15 minutes (with 30 s of clock tolerance) and only exchanges a token it has never
// exchanged, so past this no exchange of a remembered token could succeed anyway.
const blockMemory = MaxTokenLife + time.Minute

// MaxBlockTokens bounds how many block tokens the cache remembers at once.
const MaxBlockTokens = 10_000

// Why a block token's exchange was not made. Neither is a refusal by the hub, so a live stream that
// re-checks and gets one keeps serving until its own expiry closes it.
var (
	// ErrSpent is a block token whose one exchange happened and whose exchanged token is (about to
	// be) expired. The hub would refuse it as a replay; it is not asked.
	ErrSpent = errors.New("exchange: the block token's exchanged token has expired; it cannot be exchanged again")
	// ErrBlockCacheFull is MaxBlockTokens remembered and none forgettable yet.
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
)

// BlockCache makes at most one successful exchange per App Block token: the hub refuses a second
// one (it claims the block token's `jti`), so a token it issued is handed to every stream of that
// block token until it expires, and a refusal is remembered rather than asked again. Only a failure
// (the hub unreachable, a 5xx, a timeout: no token issued, and the hub gives a claim it made back) is
// forgotten, so a later read may try again.
//
// Entries are keyed by the SHA-256 of the whole token, never by a claim read from it: nothing here
// decodes a block token, and a token that merely reuses another's `jti` can never be handed the
// other's exchanged token.
type BlockCache struct {
	// Hub is the exchange (Exchanger.ExchangeBlock).
	Hub func(ctx context.Context, subject string) (Token, error)
	// Margin: a token issued earlier is handed out only while it has more than this left (the
	// stream's expiry margin, so a stream is never opened with a token about to be closed for it).
	Margin time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Observe is told each exchange's outcome and, for a refusal, the hub's code (RefusalCode;
	// `none` otherwise). Nil is none. Never a token.
	Observe func(outcome, code string)

	mu      sync.Mutex
	entries map[[sha256.Size]byte]*blockEntry
	swept   time.Time
}

type blockEntry struct {
	done   chan struct{} // closed once the exchange returned
	tok    Token
	err    error
	forget time.Time // zero while the exchange runs
}

// Exchange returns the token exchanged for subject, an App Block token, exchanging it at the hub only
// if it never was. Concurrent calls for one block token share one exchange.
func (c *BlockCache) Exchange(ctx context.Context, subject string) (Token, error) {
	k := sha256.Sum256([]byte(subject))
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[[sha256.Size]byte]*blockEntry{}
	}
	e := c.entries[k]
	if e == nil {
		now := c.now()
		// Forgetting scans every entry: done when full, and otherwise at most once a minute.
		if len(c.entries) >= MaxBlockTokens || now.Sub(c.swept) >= time.Minute {
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
	tok, err := c.Hub(ctx, subject)
	c.mu.Lock()
	switch {
	case err == nil:
		if limit := start.Add(MaxTokenLife); tok.Expires.After(limit) {
			tok.Expires = limit
		}
		e.tok, e.forget = tok, start.Add(blockMemory)
	case errors.Is(err, ErrRefused):
		e.err, e.forget = err, start.Add(blockMemory)
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
	for k, e := range c.entries {
		if !e.forget.IsZero() && !now.Before(e.forget) {
			delete(c.entries, k)
		}
	}
}

// Len is how many block tokens are remembered (or being exchanged) now.
func (c *BlockCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
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
