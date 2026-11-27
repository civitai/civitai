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
//   - block:    SHA-256(the block token)                        → blockValue
//   - user:     SHA-256(the hub token)                          → userValue
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

// blockValue is the token the hub issued for one block token.
type blockValue struct {
	V       int       `json:"v"`
	Access  string    `json:"access"`
	Expires time.Time `json:"expires"`
}

// Blocks is exchange.SharedBlocks over a Cache: a block token's exchanged token, saved when the hub
// issues it and read before the hub is asked, so a restarted process (or another one) does not spend
// the block token's one exchange again. There is no claim: two processes that both miss both ask the
// hub, and the second is refused as a replay, as without the cache (CACHE-DESIGN.md).
type Blocks struct {
	C *Cache
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// Load implements exchange.SharedBlocks.
func (b *Blocks) Load(ctx context.Context, id [sha256.Size]byte) (exchange.Token, bool) {
	raw, ok := b.C.Get(ctx, KindBlock, id[:])
	if !ok {
		return exchange.Token{}, false
	}
	var v blockValue
	if json.Unmarshal(raw, &v) != nil || v.V != valueVersion || v.Access == "" {
		return exchange.Token{}, false
	}
	return exchange.Token{Access: v.Access, Expires: v.Expires}, true
}

// Save implements exchange.SharedBlocks: the token lives until it expires, never longer.
func (b *Blocks) Save(ctx context.Context, id [sha256.Size]byte, tok exchange.Token) {
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	raw, _ := json.Marshal(blockValue{V: valueVersion, Access: tok.Access, Expires: tok.Expires})
	b.C.Put(ctx, KindBlock, id[:], raw, tok.Expires.Sub(now()))
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
