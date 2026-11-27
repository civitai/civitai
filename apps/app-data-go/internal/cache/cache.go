// Package cache is the optional shared cache behind the service's in-memory state: exchanged block
// and hub tokens, acknowledged writes (overlays) and private streams' snapshots, held in a valkey
// instance (APP_DATA_CACHE_URL) so a restarted process starts warm (CACHE-DESIGN.md).
//
// FAIL OPEN. The cache is never needed: unset, nothing here runs and the service behaves as it does
// without one. Set, every operation is bounded by a short timeout, and any error, timeout or value
// that cannot be read is a miss (a read) or a no-op (a write); nothing here returns an error to its
// caller. After BreakerFailures consecutive failures a circuit breaker stops calling valkey for
// BreakerCooldown, so a valkey that is down costs at most one timeout per operation until it trips,
// and nothing after. Nothing at start waits for valkey: the first connection is made by the first
// operation.
//
// FAIL OPEN NEVER SKIPS A CHECK. What is read back grants nothing the in-memory path would not: each
// caller re-applies the checks the in-memory state was held to (CACHE-DESIGN.md, "What a hit may do").
//
// AT REST. Every value is sealed with AES-256-GCM under a key derived from APP_DATA_CACHE_KEY, with
// the value's key name as additional data, so a value moved under another name does not open. Every
// key name is `adg:<format>:<kind>:<HMAC-SHA256 of the kind and the caller's id, hex>`: no token, user,
// app or collection appears in a name. A value or name of another format or key (a rotation) is a
// miss.
package cache

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Format is the version of the key names and the value format: a key name carries it and a value
// starts with it, so a process of another format reads every key as a miss.
const Format = 1

// MinSecretBytes is the shortest APP_DATA_CACHE_KEY accepted (256 bits).
const MinSecretBytes = 32

// The breaker: BreakerFailures consecutive failed operations open it for BreakerCooldown; then one
// operation is let through, and its success closes it again.
const (
	BreakerFailures = 5
	BreakerCooldown = 30 * time.Second
)

// Kind names what a key holds. Each is one fixed word: it is a metric label and part of a key name.
type Kind string

// The kinds (metrics.CacheKinds).
const (
	KindBlock    Kind = "block"    // an exchanged App Block token, a refusal, or a claim on its exchange
	KindUser     Kind = "user"     // an exchanged hub token
	KindOverlay  Kind = "overlay"  // a token's acknowledged writes to one collection
	KindSnapshot Kind = "snapshot" // a private stream's records and cursor
)

// The `op` values of Observe (metrics.CacheOps).
const (
	OpGet   = "get"
	OpSet   = "set"
	OpClaim = "claim"
	OpDel   = "del"
)

// The `outcome` values of Observe (metrics.CacheOutcomes): a get's hit or miss; `invalid`, a value
// that did not open (another key or format, or garbage), read as a miss; a set's or del's `ok`; a
// claim `won` or `held` by another; `error`, valkey failed or timed out; `skipped_breaker`, not
// asked while the breaker is open.
const (
	OutcomeHit     = "hit"
	OutcomeMiss    = "miss"
	OutcomeInvalid = "invalid"
	OutcomeOK      = "ok"
	OutcomeWon     = "won"
	OutcomeHeld    = "held"
	OutcomeError   = "error"
	OutcomeSkipped = "skipped_breaker"
)

// ErrMiss is a Store's answer for a key that holds nothing.
var ErrMiss = errors.New("cache: no such key")

// Store is the valkey client (RESP): every call is bounded by its context, and any error but ErrMiss
// is a failure.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, val []byte, ttl time.Duration) error
	// SetNX sets key only if it holds nothing; false when it held something.
	SetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error)
	Del(ctx context.Context, key string) error
	// SwapIf sets key to val only while it holds exactly expect; false when it held anything else.
	SwapIf(ctx context.Context, key string, expect, val []byte, ttl time.Duration) (bool, error)
	// DelIf deletes key only while it holds exactly expect.
	DelIf(ctx context.Context, key string, expect []byte) error
	// HSet sets one field of a hash, while it holds fewer than maxFields others, and sets the hash's
	// time to live to ttl.
	HSet(ctx context.Context, key, field string, val []byte, ttl time.Duration, maxFields int) error
	// HGetAll answers every field of a hash; an empty map for a key that holds nothing.
	HGetAll(ctx context.Context, key string) (map[string][]byte, error)
}

// Options configure a Cache.
type Options struct {
	// Timeout bounds each operation.
	Timeout time.Duration
	// Observe is told each operation's kind, op and outcome (metrics); nil is none.
	Observe func(kind Kind, op, outcome string)
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// MaxAsync bounds the writes in flight in the background (Go); past it one is dropped.
	MaxAsync int
}

// Cache is the fail-open cache. A nil *Cache is valid: every read misses and every write does
// nothing, without a call anywhere.
type Cache struct {
	store   Store
	aead    cipher.AEAD
	nameKey []byte
	opts    Options
	async   chan struct{}

	mu       sync.Mutex
	failures int
	openTill time.Time
	probing  bool
}

// New is a cache over store, its values sealed under keys derived from secret (at least
// MinSecretBytes).
func New(store Store, secret []byte, opts Options) (*Cache, error) {
	if len(secret) < MinSecretBytes {
		return nil, errors.New("cache: the key is too short")
	}
	block, err := aes.NewCipher(derive(secret, "app-data-go cache seal"))
	if err != nil {
		return nil, err // never: the derived key is 32 bytes
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err // never: AES has a 16-byte block
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.MaxAsync <= 0 {
		opts.MaxAsync = 64
	}
	return &Cache{store: store, aead: aead, nameKey: derive(secret, "app-data-go cache name"), opts: opts,
		async: make(chan struct{}, opts.MaxAsync)}, nil
}

// derive is a 32-byte key of its own for label, from secret.
func derive(secret []byte, label string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(label))
	return mac.Sum(nil)
}

// Name is the valkey key name of (kind, id): the format and the kind in clear, the id only as an HMAC.
func (c *Cache) Name(kind Kind, id []byte) string {
	mac := hmac.New(sha256.New, c.nameKey)
	mac.Write([]byte(kind))
	mac.Write([]byte{0})
	mac.Write(id)
	return "adg:" + string(rune('0'+Format)) + ":" + string(kind) + ":" + hex.EncodeToString(mac.Sum(nil))
}

// seal is the stored form of plain under name: the format, the nonce, then the sealed bytes.
func (c *Cache) seal(name string, plain []byte) []byte {
	nonce := make([]byte, c.aead.NonceSize(), 1+c.aead.NonceSize()+len(plain)+c.aead.Overhead())
	_, _ = rand.Read(nonce) // never fails (crypto/rand)
	out := append([]byte{Format}, nonce...)
	return c.aead.Seal(out, nonce, plain, []byte(name))
}

// open is plain from its stored form under name; false for anything that does not open.
func (c *Cache) open(name string, sealed []byte) ([]byte, bool) {
	n := c.aead.NonceSize()
	if len(sealed) < 1+n+c.aead.Overhead() || sealed[0] != Format {
		return nil, false
	}
	plain, err := c.aead.Open(nil, sealed[1:1+n], sealed[1+n:], []byte(name))
	return plain, err == nil
}

// allow reports whether valkey may be asked now: false while the breaker is open. Past the cooldown
// one call at a time is let through (half open) until one succeeds.
func (c *Cache) allow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failures < BreakerFailures {
		return true
	}
	if c.opts.Now().Before(c.openTill) || c.probing {
		return false
	}
	c.probing = true
	return true
}

// done records an operation's result for the breaker.
func (c *Cache) done(failed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probing = false
	if !failed {
		c.failures = 0
		return
	}
	c.failures++
	if c.failures >= BreakerFailures {
		c.openTill = c.opts.Now().Add(BreakerCooldown)
	}
}

// BreakerOpen reports whether the breaker is open now (the cache is not being asked). False for a nil
// Cache.
func (c *Cache) BreakerOpen() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failures >= BreakerFailures
}

// call runs one store operation under the breaker and the timeout: false when it was not run, or
// failed. The caller's cancellation does not reach it (only the timeout bounds it), so a read that
// gave up never counts as valkey failing.
func (c *Cache) call(ctx context.Context, kind Kind, op string, fn func(ctx context.Context) error) (skipped bool, err error) {
	if !c.allow() {
		c.observe(kind, op, OutcomeSkipped)
		return true, nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.opts.Timeout)
	defer cancel()
	err = fn(ctx)
	c.done(err != nil && !errors.Is(err, ErrMiss))
	return false, err
}

func (c *Cache) observe(kind Kind, op, outcome string) {
	if c.opts.Observe != nil {
		c.opts.Observe(kind, op, outcome)
	}
}

// Get is the value (kind, id) holds; false on a miss, an error, or a value that does not open.
func (c *Cache) Get(ctx context.Context, kind Kind, id []byte) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	name := c.Name(kind, id)
	var raw []byte
	skipped, err := c.call(ctx, kind, OpGet, func(ctx context.Context) error {
		var err error
		raw, err = c.store.Get(ctx, name)
		return err
	})
	switch {
	case skipped:
		return nil, false
	case errors.Is(err, ErrMiss):
		c.observe(kind, OpGet, OutcomeMiss)
		return nil, false
	case err != nil:
		c.observe(kind, OpGet, OutcomeError)
		return nil, false
	}
	plain, ok := c.open(name, raw)
	if !ok {
		c.observe(kind, OpGet, OutcomeInvalid)
		return nil, false
	}
	c.observe(kind, OpGet, OutcomeHit)
	return plain, true
}

// Put stores value under (kind, id) for ttl; a ttl that is not positive stores nothing.
func (c *Cache) Put(ctx context.Context, kind Kind, id, value []byte, ttl time.Duration) {
	if c == nil || ttl <= 0 {
		return
	}
	name := c.Name(kind, id)
	sealed := c.seal(name, value)
	c.result(ctx, kind, OpSet, func(ctx context.Context) error { return c.store.Set(ctx, name, sealed, ttl) })
}

// Delete removes (kind, id).
func (c *Cache) Delete(ctx context.Context, kind Kind, id []byte) {
	if c == nil {
		return
	}
	name := c.Name(kind, id)
	c.result(ctx, kind, OpDel, func(ctx context.Context) error { return c.store.Del(ctx, name) })
}

// result runs a write and observes ok or error (or the skip).
func (c *Cache) result(ctx context.Context, kind Kind, op string, fn func(ctx context.Context) error) {
	skipped, err := c.call(ctx, kind, op, fn)
	switch {
	case skipped:
	case err != nil:
		c.observe(kind, op, OutcomeError)
	default:
		c.observe(kind, op, OutcomeOK)
	}
}

// Go runs fn in the background, bounded by MaxAsync writes in flight (past it fn is dropped, as a
// failed write would be). For writes a request must not wait on.
func (c *Cache) Go(fn func()) {
	if c == nil {
		return
	}
	select {
	case c.async <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-c.async }()
		fn()
	}()
}

// ClaimState is what Claim found.
type ClaimState int

const (
	// ClaimUnavailable: valkey could not be asked (an error, or the breaker open). Fail open: the
	// caller goes on as without a cache.
	ClaimUnavailable ClaimState = iota
	// ClaimWon: the key held nothing, and now holds this caller's claim.
	ClaimWon
	// ClaimHeld: the key holds something else (another's claim, or a result).
	ClaimHeld
)

// Claim is one caller's hold on a key (SetNX): its stored form, to finish or release only that hold.
type Claim struct {
	name   string
	sealed []byte
}

// Claim sets (kind, id) to a claim of this caller's for ttl, only if it holds nothing.
func (c *Cache) Claim(ctx context.Context, kind Kind, id []byte, ttl time.Duration) (Claim, ClaimState) {
	if c == nil {
		return Claim{}, ClaimUnavailable
	}
	name := c.Name(kind, id)
	marker := make([]byte, 16)
	_, _ = rand.Read(marker)
	cl := Claim{name: name, sealed: c.seal(name, append([]byte(claimPrefix), marker...))}
	var won bool
	skipped, err := c.call(ctx, kind, OpClaim, func(ctx context.Context) error {
		var err error
		won, err = c.store.SetNX(ctx, name, cl.sealed, ttl)
		return err
	})
	switch {
	case skipped:
		return Claim{}, ClaimUnavailable
	case err != nil:
		c.observe(kind, OpClaim, OutcomeError)
		return Claim{}, ClaimUnavailable
	case !won:
		c.observe(kind, OpClaim, OutcomeHeld)
		return Claim{}, ClaimHeld
	}
	c.observe(kind, OpClaim, OutcomeWon)
	return cl, ClaimWon
}

// claimPrefix starts a claim's plain value, so IsClaim tells it from a result.
const claimPrefix = "\x00claim:"

// IsClaim reports whether plain, a value Get answered, is a claim rather than a result.
func IsClaim(plain []byte) bool {
	return len(plain) >= len(claimPrefix) && string(plain[:len(claimPrefix)]) == claimPrefix
}

// Finish replaces cl's claim with value for ttl, only while the key still holds that claim.
func (c *Cache) Finish(ctx context.Context, kind Kind, cl Claim, value []byte, ttl time.Duration) {
	if c == nil || cl.name == "" || ttl <= 0 {
		return
	}
	sealed := c.seal(cl.name, value)
	c.result(ctx, kind, OpSet, func(ctx context.Context) error {
		_, err := c.store.SwapIf(ctx, cl.name, cl.sealed, sealed, ttl)
		return err
	})
}

// Replace sets cl's key to value for ttl, whether or not the key still holds cl's claim.
func (c *Cache) Replace(ctx context.Context, kind Kind, cl Claim, value []byte, ttl time.Duration) {
	if c == nil || cl.name == "" || ttl <= 0 {
		return
	}
	sealed := c.seal(cl.name, value)
	c.result(ctx, kind, OpSet, func(ctx context.Context) error { return c.store.Set(ctx, cl.name, sealed, ttl) })
}

// Release deletes cl's claim, only while the key still holds it.
func (c *Cache) Release(ctx context.Context, kind Kind, cl Claim) {
	if c == nil || cl.name == "" {
		return
	}
	c.result(ctx, kind, OpDel, func(ctx context.Context) error { return c.store.DelIf(ctx, cl.name, cl.sealed) })
}

// HPut stores value as field (named by fieldID, as an HMAC) of the hash (kind, id), whose time to live
// becomes ttl, while the hash holds fewer than maxFields other fields.
func (c *Cache) HPut(ctx context.Context, kind Kind, id, fieldID, value []byte, ttl time.Duration, maxFields int) {
	if c == nil || ttl <= 0 {
		return
	}
	name := c.Name(kind, id)
	field := c.Name(kind, append(append(append([]byte{}, id...), 0), fieldID...))
	sealed := c.seal(name+"#"+field, value)
	c.result(ctx, kind, OpSet, func(ctx context.Context) error {
		return c.store.HSet(ctx, name, field, sealed, ttl, maxFields)
	})
}

// HAll is every field of the hash (kind, id) that opens; nil on a miss or an error. A field that does
// not open is left out.
func (c *Cache) HAll(ctx context.Context, kind Kind, id []byte) [][]byte {
	if c == nil {
		return nil
	}
	name := c.Name(kind, id)
	var raw map[string][]byte
	skipped, err := c.call(ctx, kind, OpGet, func(ctx context.Context) error {
		var err error
		raw, err = c.store.HGetAll(ctx, name)
		return err
	})
	switch {
	case skipped:
		return nil
	case err != nil:
		c.observe(kind, OpGet, OutcomeError)
		return nil
	case len(raw) == 0:
		c.observe(kind, OpGet, OutcomeMiss)
		return nil
	}
	out := make([][]byte, 0, len(raw))
	invalid := false
	for field, sealed := range raw {
		plain, ok := c.open(name+"#"+field, sealed)
		if !ok {
			invalid = true
			continue
		}
		out = append(out, plain)
	}
	if invalid {
		c.observe(kind, OpGet, OutcomeInvalid)
	}
	if len(out) == 0 {
		return nil
	}
	c.observe(kind, OpGet, OutcomeHit)
	return out
}
