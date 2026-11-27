package cache

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// What each kind holds, by the id its key name is the HMAC of (CACHE-DESIGN.md, "What is cached"):
//
//   - block:    SHA-256(the block token)                        → blockValue, or a claim
//   - user:     SHA-256(the hub token)                          → userValue
//   - overlay:  SHA-256(the token) ‖ 0 ‖ schema                 → a hash, one field per storage key → session.SavedOverlay
//   - snapshot: SHA-256(the token) ‖ 0 ‖ schema ‖ 0 ‖ region    → snapshotValue
//
// Every value is JSON, sealed (Cache). Its `v` is valueVersion: a value of another version is a miss.
const valueVersion = 1

// ---- user tokens ----

// userValue is an exchanged hub token, and when the hub last exchanged its subject.
type userValue struct {
	V       int       `json:"v"`
	Access  string    `json:"access"`
	Expires time.Time `json:"expires"`
	Checked time.Time `json:"checked"`
}

// Tokens caches the exchange of hub tokens (exchange.KindHub; block tokens are Blocks'), so a stream
// that opens after a restart need not ask the hub again. A cached token is answered only while the
// hub's last exchange of its subject is younger than Recheck, the re-check window a live stream is
// already served in (DESIGN.md, "Token lifetime"), and while it has more than Margin left; otherwise
// the hub is asked, as without a cache. Its Checked tells the stream when its re-check is due.
type Tokens struct {
	C *Cache
	// Exchange is the exchange the cache stands in front of (exchange.Router.Exchange).
	Exchange func(ctx context.Context, subject string) (exchange.Token, error)
	// Recheck and Margin: see the type. Recheck must be positive for anything to be answered.
	Recheck, Margin time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

func (t *Tokens) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

// Open is the exchange of subject for a stream that opens: from the cache when it may be, else the
// hub's (Fresh).
func (t *Tokens) Open(ctx context.Context, subject string) (exchange.Token, error) {
	if exchange.KindOf(subject) != exchange.KindHub {
		return t.Exchange(ctx, subject)
	}
	id := sha256.Sum256([]byte(subject))
	if raw, ok := t.C.Get(ctx, KindUser, id[:]); ok {
		var v userValue
		now := t.now()
		if json.Unmarshal(raw, &v) == nil && v.V == valueVersion && v.Access != "" &&
			now.Before(v.Expires.Add(-t.Margin)) && !v.Checked.After(now) && now.Sub(v.Checked) < t.Recheck {
			return exchange.Token{Access: v.Access, Expires: v.Expires, Checked: v.Checked}, nil
		}
	}
	return t.Fresh(ctx, subject)
}

// Fresh is the hub's exchange of subject, never a cached one: a hub token's answer replaces what the
// cache holds for it, and a refusal deletes it.
func (t *Tokens) Fresh(ctx context.Context, subject string) (exchange.Token, error) {
	tok, err := t.Exchange(ctx, subject)
	if exchange.KindOf(subject) != exchange.KindHub {
		return tok, err
	}
	id := sha256.Sum256([]byte(subject))
	switch {
	case err == nil:
		now := t.now()
		raw, _ := json.Marshal(userValue{V: valueVersion, Access: tok.Access, Expires: tok.Expires, Checked: now})
		// Never past the token's own expiry.
		t.C.Put(ctx, KindUser, id[:], raw, tok.Expires.Sub(now))
	case errors.Is(err, exchange.ErrRefused):
		t.C.Delete(ctx, KindUser, id[:])
	}
	return tok, err
}

// Forget drops the cached exchange of the token whose SHA-256 is id (session.Options.Forget).
func (t *Tokens) Forget(id [sha256.Size]byte) {
	t.C.Delete(context.Background(), KindUser, id[:])
}

// ---- block tokens ----

// blockValue is one block token's exchange: the token the hub issued, or its refusal.
type blockValue struct {
	V       int       `json:"v"`
	Access  string    `json:"access,omitempty"`
	Expires time.Time `json:"expires,omitzero"`
	Status  int       `json:"status,omitempty"`
	Code    string    `json:"code,omitempty"`
}

// The block-exchange timings (Blocks): a claim is held at most BlockClaimTTL (well past one hub call,
// which the exchange client bounds at seconds, so it never lapses while its holder is still asking), and
// a process that finds another's claim polls every BlockPoll for its answer, for at most BlockWait.
// A refusal is remembered BlockRefusalTTL, as exchange.BlockCache remembers one.
const (
	BlockClaimTTL   = 30 * time.Second
	BlockWait       = 6 * time.Second
	BlockPoll       = 50 * time.Millisecond
	BlockRefusalTTL = exchange.MaxTokenLife + time.Minute
)

// Blocks is exchange.SharedBlocks over a Cache: one block token's exchange is claimed with SET NX
// before the hub is asked, and the hub's answer replaces the claim, so no two processes sharing the
// cache both spend it.
type Blocks struct {
	C *Cache
	// Wait and Poll override BlockWait and BlockPoll (tests); zero is the default.
	Wait, Poll time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

func (b *Blocks) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// result reads a stored answer; done is false for a claim (or anything unreadable).
func blockResult(raw []byte) (exchange.SharedBegin, bool) {
	var v blockValue
	switch {
	case IsClaim(raw) || json.Unmarshal(raw, &v) != nil || v.V != valueVersion:
		return exchange.SharedBegin{}, false
	case v.Access != "":
		return exchange.SharedBegin{State: exchange.SharedIssued, Token: exchange.Token{Access: v.Access, Expires: v.Expires}}, true
	case v.Status != 0:
		return exchange.SharedBegin{State: exchange.SharedRefused, Refusal: &exchange.RefusedError{Status: v.Status, Code: v.Code}}, true
	}
	return exchange.SharedBegin{}, false
}

// Begin implements exchange.SharedBlocks.
func (b *Blocks) Begin(ctx context.Context, id [sha256.Size]byte) exchange.SharedBegin {
	if raw, ok := b.C.Get(ctx, KindBlock, id[:]); ok {
		if r, done := blockResult(raw); done {
			return r
		}
		return b.wait(ctx, id)
	}
	cl, state := b.C.Claim(ctx, KindBlock, id[:], BlockClaimTTL)
	switch state {
	case ClaimWon:
		return exchange.SharedBegin{State: exchange.SharedClaimed, Claim: cl}
	case ClaimHeld:
		return b.wait(ctx, id)
	}
	return exchange.SharedBegin{State: exchange.SharedUnavailable}
}

// wait polls for the answer of another process's claim. It never asks the hub itself: the other
// process may have spent the block token's one exchange already. No answer in time is SharedPending.
func (b *Blocks) wait(ctx context.Context, id [sha256.Size]byte) exchange.SharedBegin {
	wait, poll := b.Wait, b.Poll
	if wait <= 0 {
		wait = BlockWait
	}
	if poll <= 0 {
		poll = BlockPoll
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	tick := time.NewTicker(poll)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return exchange.SharedBegin{State: exchange.SharedPending}
		case <-t.C:
			return exchange.SharedBegin{State: exchange.SharedPending}
		case <-tick.C:
		}
		raw, ok := b.C.Get(ctx, KindBlock, id[:])
		if !ok {
			// Released (its holder's exchange failed), or the cache cannot be read: no answer here.
			return exchange.SharedBegin{State: exchange.SharedPending}
		}
		if r, done := blockResult(raw); done {
			return r
		}
	}
}

// Issued implements exchange.SharedBlocks: the issued token replaces the claim, until it expires.
// Written whether or not the claim is still there: an issued token is the one true answer.
func (b *Blocks) Issued(ctx context.Context, claim any, tok exchange.Token) {
	cl, ok := claim.(Claim)
	if !ok {
		return
	}
	raw, _ := json.Marshal(blockValue{V: valueVersion, Access: tok.Access, Expires: tok.Expires})
	b.C.Replace(ctx, KindBlock, cl, raw, tok.Expires.Sub(b.now()))
}

// Refused implements exchange.SharedBlocks: the refusal replaces the claim, only while the claim is
// this process's (a refusal never replaces another's issued token).
func (b *Blocks) Refused(ctx context.Context, claim any, refusal *exchange.RefusedError) {
	cl, ok := claim.(Claim)
	if !ok || refusal == nil {
		return
	}
	raw, _ := json.Marshal(blockValue{V: valueVersion, Status: refusal.Status, Code: refusal.Code})
	b.C.Finish(ctx, KindBlock, cl, raw, BlockRefusalTTL)
}

// Release implements exchange.SharedBlocks: the claim is deleted, only while it is this process's.
func (b *Blocks) Release(ctx context.Context, claim any) {
	if cl, ok := claim.(Claim); ok {
		b.C.Release(ctx, KindBlock, cl)
	}
}

// ---- snapshots ----

// snapshotValue is a private stream's saved records and the cursor they are complete at.
type snapshotValue struct {
	V       int               `json:"v"`
	Schema  string            `json:"schema"`
	Cursor  string            `json:"cursor"`
	Records []registry.Entity `json:"records"`
}

// Snapshots is session.Snapshots over a Cache.
type Snapshots struct{ C *Cache }

func snapshotID(k session.SnapshotKey) []byte {
	id := append([]byte{}, k.Token[:]...)
	id = append(append(id, 0), k.Schema...)
	for _, r := range k.Region {
		id = append(append(id, 0), r...)
	}
	return id
}

// Load implements session.Snapshots.
func (s Snapshots) Load(ctx context.Context, k session.SnapshotKey) (session.Saved, bool) {
	raw, ok := s.C.Get(ctx, KindSnapshot, snapshotID(k))
	if !ok {
		return session.Saved{}, false
	}
	var v snapshotValue
	if json.Unmarshal(raw, &v) != nil || v.V != valueVersion || v.Schema != k.Schema || v.Cursor == "" {
		return session.Saved{}, false
	}
	return session.Saved{Cursor: v.Cursor, Records: v.Records}, true
}

// Save implements session.Snapshots.
func (s Snapshots) Save(ctx context.Context, k session.SnapshotKey, saved session.Saved, ttl time.Duration) {
	raw, err := json.Marshal(snapshotValue{V: valueVersion, Schema: k.Schema, Cursor: saved.Cursor, Records: saved.Records})
	if err != nil {
		return // never: entities are JSON already
	}
	s.C.Put(ctx, KindSnapshot, snapshotID(k), raw, ttl)
}

// Drop implements session.Snapshots.
func (s Snapshots) Drop(ctx context.Context, k session.SnapshotKey) {
	s.C.Delete(ctx, KindSnapshot, snapshotID(k))
}

// ---- overlays ----

// overlayValue is one acknowledged write (session.SavedOverlay).
type overlayValue struct {
	V       int             `json:"v"`
	Key     string          `json:"key"`
	Seq     int64           `json:"seq"`
	Deleted bool            `json:"deleted,omitempty"`
	URN     string          `json:"urn,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Version int64           `json:"version,omitempty"`
	Until   time.Time       `json:"until"`
}

// Overlays is session.OverlayStore over a Cache: one hash per (token, schema), one field per storage
// key, the hash living as long as its newest overlay.
type Overlays struct {
	C *Cache
	// Max bounds the fields one hash holds (a stream's MaxRecords).
	Max int
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

func overlayID(token [sha256.Size]byte, schema string) []byte {
	return append(append(append([]byte{}, token[:]...), 0), schema...)
}

// Load implements session.OverlayStore.
func (o Overlays) Load(ctx context.Context, token [sha256.Size]byte, schema string) []session.SavedOverlay {
	var out []session.SavedOverlay
	for _, raw := range o.C.HAll(ctx, KindOverlay, overlayID(token, schema)) {
		var v overlayValue
		if json.Unmarshal(raw, &v) != nil || v.V != valueVersion {
			continue
		}
		out = append(out, session.SavedOverlay{Ack: session.Ack{Key: v.Key, Seq: v.Seq, Deleted: v.Deleted, URN: v.URN,
			Body: v.Body, Version: v.Version}, Until: v.Until})
	}
	return out
}

// Save implements session.OverlayStore, in the background (Cache.Go): it never delays the write.
func (o Overlays) Save(token [sha256.Size]byte, schema string, s session.SavedOverlay) {
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	ttl := s.Until.Sub(now())
	raw, err := json.Marshal(overlayValue{V: valueVersion, Key: s.Key, Seq: s.Seq, Deleted: s.Deleted, URN: s.URN,
		Body: s.Body, Version: s.Version, Until: s.Until})
	if err != nil || ttl <= 0 {
		return
	}
	o.C.Go(func() {
		o.C.HPut(context.Background(), KindOverlay, overlayID(token, schema), []byte(s.Key), raw, ttl, max(1, o.Max))
	})
}

// Drop implements session.OverlayStore.
func (o Overlays) Drop(ctx context.Context, token [sha256.Size]byte, schema string) {
	o.C.Delete(ctx, KindOverlay, overlayID(token, schema))
}
