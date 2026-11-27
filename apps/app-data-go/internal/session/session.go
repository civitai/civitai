// Package session holds the per-user registry streams: one lazy, short-lived stream per (bearer
// token, collection schema), opened with a token exchanged from THAT user's token, so the origin (the
// registry adapter) stays the only judge of what the user may read. Decided on
// civitai/civitai-registry#49, option (a).
//
// EXCHANGE. A stream's goroutine first exchanges the user's hub token at the hub, as this service's
// relay client (package exchange), and subscribes to the adapter with the exchanged token only. The
// user's own token goes to the hub's exchange endpoint and nowhere else on this path; the goroutine
// uses it for that call only: the user's token reaches nothing else from here.
//
// ISOLATION. A stream and its cache are keyed by the SHA-256 of the token that opened it together
// with the schema. Nothing here decodes a token or knows whose it is: two tokens are two keys, so a
// record one token's stream received can only ever be read back with that same token. Two tokens of
// the same user are two streams too (the auth extension, Relays rule 2: an authorized stream
// belongs to one consumer). No token is stored: a stream's goroutine holds the user's token for its
// first exchange, and a re-check uses the reading request's own token, which hashes to the same key.
//
// LIFECYCLE. A stream opens on the first read for its key and is closed when no read has used it
// for IdleTTL, MaxAge after it opened, or ExpiryMargin before its exchanged token expires, whichever
// comes first, or when it fails. The adapter ends a stream whose token expired (`invalid_token`), so
// a stream never outlives its token here either: the next read opens a new one with a new exchange
// and a fresh snapshot (DESIGN.md, "Token lifetime").
//
// REVOCATION OF THE USER'S TOKEN. The exchanged token stays valid after the user's own token is
// revoked, so a live stream re-checks the user's token by exchanging it again, on the read path: a
// read that finds the last check older than Recheck runs one before it is answered. A refusal closes
// the stream, drops its cache and answers ErrRefused (the caller reads REST); a failure (the hub
// unreachable, a 5xx, a timeout) is not a revocation, so the stream keeps serving until the next
// check. So a revoked user token is served from cache for at most Recheck after its revocation, and
// only to reads holding that very token. A read is
// answered from the cache only once the stream has sent `Live` (the snapshot is complete); before
// that the read waits, bounded by its context, and then gives up so the caller can read REST
// instead. A stream that has made one read give up is STALLED: later reads do not wait on it (a slow
// snapshot; DESIGN.md, "No relay stall") and do not count as use,
// so an idle stall is closed by IdleTTL.
//
// NOT PRIVATE. Only the adapter's private feed is in this service's contract. A stream whose `Live`
// carries a cursor of any other feed (a shared collection is served by the public feed) is closed
// unread (ErrNotPrivate), and its key is not reopened for NotPrivateCooldown: those reads are REST's.
//
// CHANGES. After `Live` the stream keeps following: an `Upsert` replaces a record, a `Delete` removes
// it. A grant the user revokes reaches the stream as a `Delete` of each record it covered (the auth
// extension's origin rule 4), so the cache drops them as soon as the adapter's next poll sends them.
//
// CAPS. At most MaxStreams streams in this manager and MaxPerToken per token, and, with a Budget,
// what the process's managers hold together. A read that would open a stream over any of them is
// refused with ErrCapacity or ErrTokenCapacity and opens nothing; the caller reads REST. A stream whose cache outgrows MaxRecords or MaxBytes is closed (ErrTooLarge).
// A key whose stream failed is not reopened for Cooldown, so a broken registry is not asked again on
// every read.
//
// Everything below is on only with the writes on (OverlayTTL > 0). Off, the stream's seqs and heads
// are not read, and every stream behaves exactly as above.
//
// READ-YOUR-WRITES (WRITES-DESIGN.md, "Read-your-writes: two sequences, base and overlay"). The
// stream's records are the BASE; each write the store acknowledged for this token (Ack) is an OVERLAY
// over it, by storage key, at the write's `seq`. They are never merged, so dropping an overlay shows
// the base again, never a vanished record. An ack applies only at or above the overlay's and the
// base's seq for that key, and above the stream's head (the head says every write at or below it is
// already in what the stream sent). A delete leaves a delete marker. An overlay is dropped when an
// upsert of its key carries a seq at or above it, when the head reaches it, when the stream deletes
// its URN (a moderator hide after the write wins; a Delete of another URN, the old row of a
// re-created key, does not), or OverlayTTL after it was set. An upsert without a seq (an adapter
// before body format k2) orders nothing. A stream that holds nothing and names no head (one the
// origin refused) is answered as it is, overlays or not: an empty answer is what sends the caller to
// REST, and an overlay must not turn a refusal into a one-record list.
//
// THE FLOOR. A read may name minSeq, the highest seq the client was acknowledged for the app. It is
// met when the stream's head is at or above it, or, for a block token only, when an overlay this
// replica holds for that token's stream of this collection is (a block token's writes are served by
// this replica only; a hub token's may have landed on another). Otherwise the stream is reopened at
// most once per (token, schema) per ReopenEvery, and a floor still not met is ErrFloorNotMet. A
// stream that names no head cannot be compared with any floor, so its reads are answered unfloored.
//
// OTHER FEEDS. The same manager serves the adapter's other per-subscription streams (the shared
// collections' level and per-viewer streams, package shared): Options.Accept names the cursors of the
// feed it reads (a Live of any other is ErrNotPrivate, "not this feed"), Options.SubscribeMeta the
// `meta` a subscription names, and View answers the stream's latest `meta` beside its records. An
// `end` naming a reason is an EndedError, and a key cooling down after one answers that reason too.
//
// REGION. With Options.Region on, a stream is keyed by the viewer's region too (the edge's region
// headers the reading request carried, WithRegion), and its subscription carries those headers, so
// the adapter judges the viewer's region rather than this relay's (WRITES-DESIGN.md, "Region"). A
// viewer whose region changes opens a new stream. Off (the level streams, read as a service), no
// stream carries a region, whatever the read's context holds.
//
// EXCHANGE FAILURES. Options.ClassifyExchange may name an exchange error (an ExchangeFailure): the
// stream closes with its reason, the read answers it, and so does every read of its key while it
// cools down, so a refusal that is not a network blip stays distinguishable from one.
//
// A HEAD THAT WENT BACK means the namespace's seqs restarted: the adapter ends the stream
// `cursor_expired`, and a head below the one held is treated the same. Neither is a failure: the
// stream closes with no cooldown, its overlays (numbered in the old order) are dropped, and the read
// that met it opens a fresh stream once.
//
// Everything below is on only with Options.Snapshots set (the shared cache, CACHE-DESIGN.md). Unset,
// no stream is saved or resumed.
//
// THE CONSISTENT CURSOR. A stream's records are complete at a cursor only where the adapter says so:
// at `Live`, at a `Progress`, and at the last event of a batch, the one event of a poll's changes that
// carries the poll's new cursor (private-feed.ts sends every other event of the batch with the cursor
// before it). An event carrying the cursor already held is part of a batch whose end has not arrived,
// and until it does the records are at no cursor: resuming from the earlier one would miss a `Delete`
// of an entity the batch upserted.
//
// SNAPSHOTS. A live stream's records at its consistent cursor are saved: by Sweep when they changed
// since the last save, and at an idle close and at shutdown. Each lives at most IdleTTL and never
// past its exchanged token's expiry. A stream that ended because its token or its data was refused
// (exchange_refused, revoked, invalid_token, not_private, too_large, malformed, end, cursor_expired,
// or a classified exchange failure) drops its snapshot; one whose token was refused (exchange_refused,
// revoked, invalid_token) also drops its token's cached exchange (Forget).
//
// RESUME. A stream that opens (never one reopened for a floor) loads its key's snapshot, after its
// exchange (a refused token loads nothing), and subscribes from the snapshot's cursor, asking the
// adapter to say when its first poll is sent (request meta `{"sync":1}`). The snapshot's cursor must
// be this feed's (Accept), as a Live's must, and its records within MaxRecords and MaxBytes. The
// resumed stream is NOT answered at `Live`: its records are the snapshot's until the first poll's
// changes arrive, every `Delete` the stream missed among them, so a read waits for the `Progress`
// naming `{"sync":"done"}`, as a fresh stream's reads wait for `Live`. A Live that does not promise
// one (`{"sync":"pending"}`: an adapter before it) and a refused cursor (`cursor_expired` or
// `bad_request`, before the sync) drop the snapshot, and the stream starts over from a fresh snapshot
// in the same session. The overlays (READ-YOUR-WRITES) stay in memory only: a stream that opens after
// a restart holds every committed write once it is answered, from its fresh snapshot or its resume's
// sync.
package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/sign"
)

// Region is the edge's region header values a viewer's request carried, indexed as
// sign.RegionHeaders, each "" when absent (REGION).
type Region [3]string

type regionKey struct{}

// WithRegion is ctx carrying r, the reading viewer's region.
func WithRegion(ctx context.Context, r Region) context.Context {
	if r == (Region{}) {
		return ctx
	}
	return context.WithValue(ctx, regionKey{}, r)
}

// RegionOf is the region ctx carries, or the zero Region.
func RegionOf(ctx context.Context) Region {
	r, _ := ctx.Value(regionKey{}).(Region)
	return r
}

// headers are r's values by header name, the absent ones left out; nil when all are.
func (r Region) headers() map[string]string {
	var h map[string]string
	for i, name := range sign.RegionHeaders {
		if r[i] == "" {
			continue
		}
		if h == nil {
			h = map[string]string{}
		}
		h[name] = r[i]
	}
	return h
}

// ExchangeFailure is an Exchange error Options.ClassifyExchange named (EXCHANGE FAILURES): its stream
// closes with Reason, and its reads answer it, while its key cools down too (with ErrCoolingDown).
type ExchangeFailure struct {
	Reason string
	Err    error
}

func (e *ExchangeFailure) Error() string { return e.Err.Error() }

// Unwrap makes an ExchangeFailure its Err.
func (e *ExchangeFailure) Unwrap() error { return e.Err }

// PrivateCursorPrefix starts every cursor the adapter's private feed issues
// (src/server/registry-adapter/private-feed.ts: `p1.<digest>`, or `p1.empty` for a stream that holds
// nothing). The public document feed's start `f1.` (doc-feed.ts). Read only off the adapter's own
// streams: this service subscribes to the adapter directly, so no relay rewrites its cursors.
const PrivateCursorPrefix = "p1."

// boundCursorRE is the adapter's wrapping of every cursor it sends, `b1.<24 hex binding>.<inner>`
// (src/server/registry-adapter/subscription.ts: bindCursor, BOUND_CURSOR_RE). `Live` carries it too.
var boundCursorRE = regexp.MustCompile(`^b1\.([0-9a-f]{24})\.(.+)$`)

// PrivateFeedCursor reports whether cursor, as the adapter sent it, is one its private feed issued:
// the bound wrapping, around a private-feed cursor. Anything else, a bare inner cursor included, is
// not private.
func PrivateFeedCursor(cursor string) bool {
	m := boundCursorRE.FindStringSubmatch(cursor)
	return m != nil && strings.HasPrefix(m[2], PrivateCursorPrefix)
}

// Stream is one subscription's events (registry.Stream).
type Stream interface {
	Next() (registry.Event, error)
	Close() error
}

// Subscriber opens a subscription with a bearer token.
type Subscriber interface {
	Subscribe(ctx context.Context, schema, token string) (Stream, error)
}

// ResumeSubscriber also resumes a subscription from a cursor (RESUME).
type ResumeSubscriber interface {
	SubscribeFrom(ctx context.Context, schema, token string, meta json.RawMessage, cursor string) (Stream, error)
}

// MetaSubscriber also opens a subscription naming a request `meta` (Options.SubscribeMeta).
type MetaSubscriber interface {
	SubscribeMeta(ctx context.Context, schema, token string, meta json.RawMessage) (Stream, error)
}

// ClientSubscriber opens subscriptions on a registry over its HTTP binding.
type ClientSubscriber struct{ Client *registry.Client }

// Subscribe implements Subscriber.
func (c ClientSubscriber) Subscribe(ctx context.Context, schema, token string) (Stream, error) {
	return c.SubscribeMeta(ctx, schema, token, nil)
}

// SubscribeMeta implements MetaSubscriber. The region ctx carries (a stream's, REGION) goes as the
// subscription's region headers.
func (c ClientSubscriber) SubscribeMeta(ctx context.Context, schema, token string, meta json.RawMessage) (Stream, error) {
	return c.SubscribeFrom(ctx, schema, token, meta, "")
}

// SubscribeFrom implements ResumeSubscriber: SubscribeMeta, resumed from cursor ("" is a snapshot).
func (c ClientSubscriber) SubscribeFrom(ctx context.Context, schema, token string, meta json.RawMessage, cursor string) (Stream, error) {
	s, err := c.Client.Subscribe(ctx, registry.Request{Schema: schema, Cursor: cursor, Token: token, Meta: meta, Headers: RegionOf(ctx).headers()})
	if err != nil {
		return nil, err
	}
	return s, nil
}

// SnapshotKey names one stream's saved snapshot: its token's SHA-256, its schema and its region.
type SnapshotKey struct {
	Token  [sha256.Size]byte
	Schema string
	Region Region
}

// Saved is a stream's snapshot (SNAPSHOTS): its records, complete at Cursor.
type Saved struct {
	Cursor  string
	Records []registry.Entity
}

// Snapshots keeps streams' snapshots (package cache). Every method fails open: a Load that cannot
// answer is a miss, and a Save or Drop that fails does nothing.
type Snapshots interface {
	Load(ctx context.Context, k SnapshotKey) (Saved, bool)
	Save(ctx context.Context, k SnapshotKey, s Saved, ttl time.Duration)
	Drop(ctx context.Context, k SnapshotKey)
}

// The `outcome` of a stream's resume (metrics.ResumeOutcomes): it reached the adapter's sync and
// serves; its cursor was refused, or its Live promised no sync, so it started over from a fresh
// snapshot; its snapshot could not be restored (not this feed's cursor, or past the bounds) and was
// dropped unread.
const (
	ResumeSynced        = "synced"
	ResumeCursorRefused = "cursor_refused"
	ResumeUnsupported   = "unsupported"
	ResumeDiscarded     = "discarded"
)

// syncRequest is the request meta a resume names (RESUME); syncPending and syncDone what the adapter
// answers in its Live and in the Progress that ends its first poll.
var syncRequest = json.RawMessage(`{"sync":1}`)

const (
	syncPending = "pending"
	syncDone    = "done"
)

// syncOf is the `sync` a Live or Progress meta names, or "".
func syncOf(meta json.RawMessage) string {
	var m struct {
		Sync string `json:"sync"`
	}
	if len(meta) == 0 || json.Unmarshal(meta, &m) != nil {
		return ""
	}
	return m.Sync
}

// errStartOver ends a resumed subscription that cannot go on: the stream subscribes again without a
// cursor.
var errStartOver = errors.New("session: the resume cannot continue; start over")

// EndedError is an `end` that named why the origin ended the stream (its `meta.reason`, e.g. a level
// stream's `levels_on`). It is ErrEnded.
type EndedError struct{ Reason string }

func (e *EndedError) Error() string { return ErrEnded.Error() + " (" + e.Reason + ")" }

// Unwrap makes an EndedError ErrEnded.
func (e *EndedError) Unwrap() error { return ErrEnded }

// endReasonRE is a reason this service reads: a short lowercase word, never free text.
var endReasonRE = regexp.MustCompile(`^[a-z_]{1,32}$`)

// endError is the error an `end` carrying meta stands for.
func endError(meta json.RawMessage) error {
	var m struct {
		Reason string `json:"reason"`
	}
	if len(meta) == 0 || json.Unmarshal(meta, &m) != nil || !endReasonRE.MatchString(m.Reason) {
		return ErrEnded
	}
	return &EndedError{Reason: m.Reason}
}

// Snapshot is what View answers: the records (overlays applied) and the stream's latest `meta` and
// head, as of the read.
type Snapshot struct {
	Entities []registry.Entity
	// Meta is the latest `meta` a Live or Progress carried; nil when none did.
	Meta json.RawMessage
	// Head is the latest head the stream named, when HasHead (only with OverlayTTL set).
	Head    int64
	HasHead bool
	// Lease is the stream this read OPENED, for it to release once it is done with it (Lease.Release);
	// the zero Lease when the read took a stream already open.
	Lease Lease
}

// Lease is one read's claim on the stream it opened. Release closes that stream only while it is
// still the one open for its key and no read but the opener's has taken it: a stream another read
// opened, or took, or is taking, is never closed by it.
type Lease struct {
	m *Manager
	s *session
}

// Release closes the leased stream if no other read has taken it (see Lease), at once, as an idle
// close would later: its slots go back, and its key does not cool down. The zero Lease does nothing.
func (l Lease) Release() {
	if l.s == nil {
		return
	}
	m, s := l.m, l.s
	m.mu.Lock()
	s.mu.Lock()
	mine := m.sessions[s.k] == s && s.reads == 1
	s.mu.Unlock()
	if !mine {
		m.mu.Unlock()
		return
	}
	st, ok := m.endLocked(s, CloseReleased, ErrClosed)
	m.mu.Unlock()
	if ok {
		m.finish(s, st, CloseReleased)
	}
}

// Why a read was not answered from a stream. Each is a reason to read REST instead.
var (
	ErrCapacity      = errors.New("session: the process holds its maximum of streams")
	ErrTokenCapacity = errors.New("session: this token holds its maximum of streams")
	ErrNotLive       = errors.New("session: the stream did not reach Live before the read's deadline")
	ErrStalled       = errors.New("session: the stream has not reached Live")
	ErrCoolingDown   = errors.New("session: this stream failed recently")
	ErrInvalidToken  = errors.New("session: the registry refused the token")
	ErrTooLarge      = errors.New("session: the stream outgrew its cache bounds")
	ErrRefused       = errors.New("session: the hub refused to exchange the token")
	ErrNotPrivate    = errors.New("session: the collection is not served by the private feed")
	ErrEnded         = errors.New("session: the registry ended the stream")
	ErrFailed        = errors.New("session: the stream failed")
	ErrBlockSpent    = errors.New("session: the block token's one exchange is used up")
	ErrBlockFull     = errors.New("session: the block exchange cache is full")
	ErrClosed        = errors.New("session: closed")
	// ErrCursorExpired is a stream whose head went back (see A HEAD THAT WENT BACK), met again on the
	// one fresh stream a read opens for it.
	ErrCursorExpired = errors.New("session: the stream's sequence went back")
	// ErrFloorNotMet is a read whose floor neither the stream nor a reopen met (see THE FLOOR). It is
	// not a reason to read REST for a client that sent a floor: it answers 503 and retries.
	ErrFloorNotMet = errors.New("session: the stream has not reached the read's floor")
)

// The `reason` a stream was closed for (metrics.CloseReasons).
const (
	CloseIdle         = "idle"
	CloseAge          = "age"
	CloseExpiry       = "expiry"
	CloseRefused      = "exchange_refused"
	CloseNotPrivate   = "not_private"
	CloseRevoked      = "revoked"
	CloseInvalidToken = "invalid_token"
	CloseTooLarge     = "too_large"
	CloseEnd          = "end"
	CloseMalformed    = "malformed"
	CloseError        = "error"
	CloseShutdown     = "shutdown"
	// A block token's stream that could not open: its one exchange is used up (exchange.ErrSpent),
	// or the block cache is full (exchange.ErrBlockCacheFull). Neither is a registry error.
	CloseBlockSpent = "block_spent"
	CloseBlockFull  = "block_cache_full"
	// A stream whose head went back (ErrCursorExpired), and one closed to reopen it for a read's floor.
	// Neither cools its key down.
	CloseCursorExpired = "cursor_expired"
	CloseFloorReopen   = "floor_reopen"
	// CloseReleased is a stream the read that opened it released (Lease.Release), no other read having
	// taken it: it does not cool its key down.
	CloseReleased = "released"
)

// The `outcome` of a read whose floor its stream had not met (metrics.FloorOutcomes): its reopen met
// it, or did not; or a reopen was already spent in this interval, so none was made.
const (
	FloorMet         = "met"
	FloorStillBehind = "still_behind"
	FloorSpent       = "spent"
)

// The `kind` of an acknowledgement applied as an overlay (metrics.OverlayKinds).
const (
	OverlayRecord       = "record"
	OverlayDeleteMarker = "delete_marker"
)

// Ack is one write the store acknowledged (WRITES-DESIGN.md, "Store changes"): a create's or put's
// record, or a delete's tombstone (Deleted; URN and Body unused).
type Ack struct {
	Key string
	// Seq orders the write against the stream; an ack without one is not applied.
	Seq     int64
	Deleted bool
	// URN is "" when the answer named no recordId.
	URN  string
	Body json.RawMessage
	// Version is the document's store version as the write answered it: a private overlay carries it
	// (Entity.Version, so a read-back answers the version the next write's ifVersion must name), and
	// package shared's overlays read it. CreatedAt and UpdatedAt are a shared document's only.
	Version              int64
	CreatedAt, UpdatedAt string
}

// Options bound the manager. Zero values are not defaults: main sets every field from config.
type Options struct {
	MaxStreams  int
	MaxPerToken int
	IdleTTL     time.Duration
	MaxAge      time.Duration
	MaxRecords  int
	MaxBytes    int
	// Cooldown is how long a key whose stream failed is not reopened.
	Cooldown time.Duration
	// NotPrivateCooldown is how long a key the private feed does not serve is not reopened.
	NotPrivateCooldown time.Duration
	// Exchange trades the user's hub token for a token toward the adapter (exchange.Exchanger).
	Exchange func(ctx context.Context, subject string) (exchange.Token, error)
	// ExpiryMargin closes a stream this long before its exchanged token expires.
	ExpiryMargin time.Duration
	// Recheck is how old the last check of a live stream's user token may be before a read checks it
	// again (see REVOCATION OF THE USER'S TOKEN). Zero never re-checks.
	Recheck time.Duration
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// Opened and Closed observe each stream (metrics); nil is none.
	Opened func()
	Closed func(reason string)
	// OverlayTTL is how long an acknowledged write is shown over a stream that has not caught up with
	// it: one adapter poll plus 30 s. Zero is the writes off: no ack, no floor, no head is read.
	OverlayTTL time.Duration
	// ReopenEvery bounds the floor's reopens: at most one per (token, schema) per this interval, the
	// adapter's poll.
	ReopenEvery time.Duration
	// Floor observes each read whose floor its stream had not met, by outcome (Floor*); Overlaid each
	// acknowledgement applied, by kind (Overlay*). Nil is none.
	Floor    func(outcome string)
	Overlaid func(kind string)
	// Accept reports whether a Live's cursor is one of the feed this manager reads; nil is the private
	// feed's (PrivateFeedCursor). Any other is closed unread, ErrNotPrivate.
	Accept func(cursor string) bool
	// SubscribeMeta, when set, is the request `meta` of the subscription a read for subject opens
	// (nil: none). A non-nil meta needs a Subscriber that is a MetaSubscriber.
	SubscribeMeta func(subject string) json.RawMessage
	// MaxOverlayBytes bounds one stream's overlays by size (see Ack); zero is MaxBytes.
	MaxOverlayBytes int
	// Budget, when set, is shared with the process's other managers: every stream opened here takes
	// one of its streams and Reserve of its bytes until it closes. A read that finds it spent is
	// ErrCapacity, as one over MaxStreams is.
	Budget *Budget
	// Reserve is what one stream takes from Budget's bytes: the most its cache can hold (MaxBytes,
	// plus MaxOverlayBytes where acks are applied). main sets it.
	Reserve int
	// InvalidToken, when set, is called each time the registry refuses the token a stream was
	// opened with (ErrInvalidToken): the level manager's token is this service's own, re-minted then.
	InvalidToken func()
	// Region keys each stream by the reading request's region and sends it on the subscription
	// (REGION). Off, no stream carries one.
	Region bool
	// ClassifyExchange, when set, names an Exchange error the manager does not know (EXCHANGE
	// FAILURES); nil from it, or no ClassifyExchange, leaves it ErrFailed.
	ClassifyExchange func(err error) *ExchangeFailure
	// ExchangeFresh, when set, is the exchange a re-check uses (REVOCATION OF THE USER'S TOKEN): the
	// hub's own answer, never a cached one. Nil is Exchange.
	ExchangeFresh func(ctx context.Context, subject string) (exchange.Token, error)
	// Forget, when set, is told the digest of a token the hub or the registry refused (SNAPSHOTS), so
	// a cache drops the exchange it holds for it.
	Forget func(token [sha256.Size]byte)
	// Snapshots, when set, saves streams and resumes them (SNAPSHOTS, RESUME); the Subscriber must be
	// a ResumeSubscriber for a stream to resume. Nil: nothing is saved or resumed.
	Snapshots Snapshots
	// Resumed observes each resume by outcome (Resume*); nil is none.
	Resumed func(outcome string)
}

// Budget caps what several managers hold together: the streams (one adapter subscription each) and
// the bytes their caches may reach, each stream counted at its manager's Reserve. Safe for
// concurrent use.
type Budget struct {
	maxStreams, maxBytes int

	mu             sync.Mutex
	streams, bytes int
}

// NewBudget is a budget of maxStreams streams and maxBytes bytes.
func NewBudget(maxStreams, maxBytes int) *Budget {
	return &Budget{maxStreams: maxStreams, maxBytes: maxBytes}
}

// take reserves one stream of n bytes; false when either would pass its bound.
func (b *Budget) take(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.streams >= b.maxStreams || b.bytes+n > b.maxBytes {
		return false
	}
	b.streams, b.bytes = b.streams+1, b.bytes+n
	return true
}

// give returns one stream of n bytes.
func (b *Budget) give(n int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.streams, b.bytes = b.streams-1, b.bytes-n
}

// InUse is the streams and bytes reserved now.
func (b *Budget) InUse() (streams, bytes int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.streams, b.bytes
}

type tokenID [sha256.Size]byte

type key struct {
	token  tokenID
	schema string
	// region is the viewer's (REGION); zero with Options.Region off.
	region Region
}

// Manager holds the streams.
type Manager struct {
	sub  Subscriber
	opts Options

	base   context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu       sync.Mutex
	closed   bool
	sessions map[key]*session
	perToken map[tokenID]int
	cooling  map[key]time.Time
	// coolCause is why a cooling key's stream ended, when its end named a reason (an EndedError) or
	// its exchange failed one ClassifyExchange named (an ExchangeFailure).
	coolCause map[key]error
	// reopened is when each key last reopened for a floor (ReopenEvery).
	reopened map[key]time.Time
}

// New returns a manager whose streams are opened through sub.
func New(sub Subscriber, opts Options) *Manager {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	base, cancel := context.WithCancel(context.Background())
	return &Manager{
		sub: sub, opts: opts, base: base, cancel: cancel,
		sessions: map[key]*session{}, perToken: map[tokenID]int{}, cooling: map[key]time.Time{},
		coolCause: map[key]error{}, reopened: map[key]time.Time{},
	}
}

type session struct {
	k      key
	opened time.Time
	live   chan struct{} // closed at the first Live
	done   chan struct{} // closed when the session ends
	cancel context.CancelFunc

	mu       sync.Mutex
	expires  time.Time // the exchanged token's expiry; zero until the exchange returned
	stream   Stream    // the open subscription, once Subscribe returned; closed by end
	isLive   bool
	stalled  bool
	ended    bool
	err      error
	lastRead time.Time
	// reads counts the reads (View calls) that took this stream, counted as each takes it (under the
	// manager's lock, in session): a Lease releases its stream only while this is its own one read.
	reads    int
	checked  time.Time // the last exchange of the user's token, refused or not
	checking bool      // a read is re-checking the user's token now
	records  map[string]registry.Entity
	bytes    int
	// head is the newest head the stream named (Live / Progress meta), when hasHead.
	head    int64
	hasHead bool
	// meta is the latest `meta` a Live or Progress carried.
	meta json.RawMessage
	// overlays are this token's acknowledged writes the stream has not shown yet, by storage key;
	// overlayBytes their size, bounded with the records' own bounds.
	overlays     map[string]overlay
	overlayBytes int
	// fresh: never resumed (a stream reopened for a floor wants a fresh snapshot). resumed: subscribed
	// from a snapshot's cursor and not synced yet (RESUME).
	fresh, resumed bool
	// cursor is where the records are complete, unless midBatch (THE CONSISTENT CURSOR); "" before
	// Live. dirty: the records changed since the last save.
	cursor   string
	midBatch bool
	dirty    bool
	// onEnd is what the stream's end persists (its snapshot saved, or dropped), run by finish.
	onEnd func()
}

// overlay is one acknowledged write (READ-YOUR-WRITES): a record, or a delete marker.
type overlay struct {
	seq     int64
	urn     string // the record's URN; "" when unknown
	deleted bool
	body    json.RawMessage
	version int64     // the document's store version, as the write answered it; 0 when unknown
	until   time.Time // dropped at this time, whether or not the stream caught up
}

func (o overlay) size() int { return len(o.urn) + len(o.body) }

// ReadAt returns every record the token's stream of schema holds, its overlays applied, once that
// stream has sent `Live`, opening the stream if none is open; minSeq > 0 is the read's floor. Any
// error means: nothing from the stream.
func (m *Manager) ReadAt(ctx context.Context, token, schema string, minSeq int64) ([]registry.Entity, error) {
	snap, err := m.View(ctx, token, schema, minSeq)
	return snap.Entities, err
}

// View is ReadAt, answering the stream's latest `meta` and head beside its records.
func (m *Manager) View(ctx context.Context, token, schema string, minSeq int64) (Snapshot, error) {
	k := key{token: sha256.Sum256([]byte(token)), schema: schema}
	if m.opts.Region {
		k.region = RegionOf(ctx)
	}
	// The viewer's address (exchange.ClientIP) goes with a stream this read opens, to its exchange.
	ip := exchange.ClientIP(ctx)
	for retried := false; ; retried = true {
		s, opened, err := m.session(k, token, ip) //nolint:contextcheck // a stream outlives the read that opened it: it runs on the manager's own context
		if err != nil {
			return Snapshot{}, err
		}
		ents, err := m.read(ctx, s, token)
		switch {
		case errors.Is(err, ErrCursorExpired) && !retried:
			// Only with the writes on (classify); the key has no cooldown against it.
			continue
		case err != nil:
			return Snapshot{}, err
		case minSeq > 0:
			s, ents, err = m.floor(ctx, s, token, minSeq, ents)
			if err != nil {
				return Snapshot{}, err
			}
		}
		var lease Lease
		if opened != nil && opened == s {
			lease = Lease{m: m, s: s}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return Snapshot{Entities: ents, Meta: s.meta, Head: s.head, HasHead: s.hasHead, Lease: lease}, nil
	}
}

// session takes k's stream for one read and counts the read on it, both under m.mu (so a Lease,
// deciding under m.mu, sees every read that has taken the stream), opening it when none is open;
// opened is the stream when this call opened it, else nil.
func (m *Manager) session(k key, token, ip string) (s *session, opened *session, err error) {
	now := m.opts.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, nil, ErrClosed
	}
	if s = m.sessions[k]; s == nil {
		if until, ok := m.cooling[k]; ok && now.Before(until) {
			if cause := m.coolCause[k]; cause != nil {
				return nil, nil, errors.Join(ErrCoolingDown, cause)
			}
			return nil, nil, ErrCoolingDown
		}
		if err := m.room(k); err != nil {
			return nil, nil, err
		}
		s = m.open(k, token, now, nil, ip, false) //nolint:contextcheck // a stream outlives the read that opened it: it runs on the manager's own context
		opened = s
	}
	s.mu.Lock()
	s.reads++
	s.mu.Unlock()
	return s, opened, nil
}

// room checks the caps for opening k and, when they admit it, takes its share of the Budget: open
// must follow a nil answer (end gives the share back). m.mu is held.
func (m *Manager) room(k key) error {
	switch {
	case len(m.sessions) >= m.opts.MaxStreams:
		return ErrCapacity
	case m.perToken[k.token] >= m.opts.MaxPerToken:
		return ErrTokenCapacity
	case m.opts.Budget != nil && !m.opts.Budget.take(m.opts.Reserve):
		return ErrCapacity
	}
	return nil
}

// floor answers the session the read is answered from (the reopened one, after a reopen).
func (m *Manager) floor(ctx context.Context, s *session, token string, minSeq int64, ents []registry.Entity) (*session, []registry.Entity, error) {
	s.mu.Lock()
	headless := !s.hasHead
	s.mu.Unlock()
	// Off, or with no head to compare against (a refused or empty stream): answered unfloored, as a
	// stream that could never meet a floor would otherwise answer 503 for as long as it is open.
	if !m.writesOn() || headless || m.met(s, token, minSeq) {
		return s, ents, nil
	}
	now := m.opts.Now()
	m.mu.Lock()
	if at, ok := m.reopened[s.k]; ok && now.Sub(at) < m.opts.ReopenEvery {
		m.mu.Unlock()
		m.observeFloor(FloorSpent)
		return nil, nil, ErrFloorNotMet
	}
	m.reopened[s.k] = now
	m.mu.Unlock()
	fresh, err := m.reopen(s, token, exchange.ClientIP(ctx)) //nolint:contextcheck // as session: the reopened stream runs on the manager's own context
	if err == nil {
		ents, err = m.read(ctx, fresh, token)
	}
	if err == nil {
		fresh.mu.Lock()
		headless = !fresh.hasHead
		fresh.mu.Unlock()
	}
	switch {
	case err != nil:
		m.observeFloor(FloorStillBehind)
		return nil, nil, err
	case headless:
		// The reopened stream names no head either: unfloored, as above, and not counted as met.
		return fresh, ents, nil
	case !m.met(fresh, token, minSeq):
		m.observeFloor(FloorStillBehind)
		return nil, nil, ErrFloorNotMet
	}
	m.observeFloor(FloorMet)
	return fresh, ents, nil
}

func (m *Manager) observeFloor(outcome string) {
	if m.opts.Floor != nil {
		m.opts.Floor(outcome)
	}
}

// met reports whether s meets the floor: its head, or for a block token an overlay s itself holds.
// An ack held for another collection is no evidence about this one, app-wide seqs or not.
func (m *Manager) met(s *session, token string, floor int64) bool {
	now := m.opts.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasHead && s.head >= floor {
		return true
	}
	if exchange.KindOf(token) != exchange.KindBlock {
		return false
	}
	for _, ov := range s.overlays {
		if ov.seq >= floor && now.Before(ov.until) {
			return true
		}
	}
	return false
}

// reopen closes old and opens its key again, carrying its overlays: each was committed before the new
// snapshot is read, so the snapshot drops it as it shows it.
func (m *Manager) reopen(old *session, token, ip string) (*session, error) {
	old.mu.Lock()
	carried := maps.Clone(old.overlays)
	old.mu.Unlock()
	m.end(old, CloseFloorReopen, ErrClosed)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	if s := m.sessions[old.k]; s != nil {
		// Another read reopened it first.
		return s, nil
	}
	if err := m.room(old.k); err != nil {
		return nil, err
	}
	return m.open(old.k, token, m.opts.Now(), carried, ip, true), nil
}

// Ack applies one acknowledged write of token to its open stream of schema. With none open there is
// nothing to overlay: the next read's snapshot holds the write.
func (m *Manager) Ack(token, schema string, a Ack) {
	if m.opts.OverlayTTL <= 0 || a.Seq <= 0 || a.Key == "" {
		return
	}
	id := sha256.Sum256([]byte(token))
	// Every region's stream of the token (REGION): usually one.
	var open []*session
	m.mu.Lock()
	if m.opts.Region {
		for k, s := range m.sessions {
			if k.token == id && k.schema == schema {
				open = append(open, s)
			}
		}
	} else if s := m.sessions[key{token: id, schema: schema}]; s != nil {
		open = append(open, s)
	}
	m.mu.Unlock()
	maxOverlay := m.opts.MaxOverlayBytes
	if maxOverlay <= 0 {
		maxOverlay = m.opts.MaxBytes
	}
	for _, s := range open {
		if kind, ok := s.ack(a, m.opts.Now().Add(m.opts.OverlayTTL), m.opts.MaxRecords, maxOverlay); ok && m.opts.Overlaid != nil {
			m.opts.Overlaid(kind)
		}
	}
}

// ack reports the overlay's kind, and whether it was applied.
func (s *session) ack(a Ack, until time.Time, maxRecords, maxBytes int) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended || (s.hasHead && a.Seq <= s.head) {
		// The stream already holds this write, or a later one.
		return "", false
	}
	prev, had := s.overlays[a.Key]
	if had && a.Seq < prev.seq {
		return "", false
	}
	base, hasBase := s.baseOf(a.Key)
	if hasBase && a.Seq < base.Seq {
		return "", false
	}
	ov := overlay{seq: a.Seq, until: until, deleted: a.Deleted}
	// A delete marker keeps the URN it hides, so the stream's Delete of that URN drops it.
	kind := OverlayRecord
	switch {
	case !a.Deleted:
		ov.urn, ov.body, ov.version = a.URN, a.Body, a.Version
	case had:
		ov.urn, kind = prev.urn, OverlayDeleteMarker
	case hasBase:
		ov.urn, kind = base.URN, OverlayDeleteMarker
	default:
		kind = OverlayDeleteMarker
	}
	n := s.overlayBytes + ov.size()
	if had {
		n -= prev.size()
	}
	// Past either bound the write is not overlaid (the stream shows it at its next poll), and a floor
	// gets no credit from it; the stream is not closed for it.
	if (!had && len(s.overlays) >= maxRecords) || n > maxBytes {
		return "", false
	}
	s.overlays[a.Key], s.overlayBytes = ov, n
	return kind, true
}

// baseOf is key's base record with the highest seq (two rows briefly, for a re-created key). s.mu is
// held.
func (s *session) baseOf(k string) (registry.Entity, bool) {
	var best registry.Entity
	found := false
	for _, e := range s.records {
		if e.Key == k && (!found || e.Seq > best.Seq) {
			best, found = e, true
		}
	}
	return best, found
}

// s.mu is held.
func (s *session) dropOverlay(k string) {
	if ov, ok := s.overlays[k]; ok {
		s.overlayBytes -= ov.size()
		delete(s.overlays, k)
	}
}

// open starts a session's stream, holding carried overlays; ip is the address of the viewer whose
// read opened it (exchange.ClientIP), carried to its exchange; fresh never resumes it. m.mu is held.
func (m *Manager) open(k key, token string, now time.Time, carried map[string]overlay, ip string, fresh bool) *session {
	delete(m.cooling, k)
	delete(m.coolCause, k)
	ctx, cancel := context.WithCancel(WithRegion(exchange.WithClientIP(m.base, ip), k.region))
	s := &session{
		k: k, opened: now, lastRead: now, cancel: cancel,
		live: make(chan struct{}), done: make(chan struct{}), records: map[string]registry.Entity{},
		overlays: map[string]overlay{}, fresh: fresh,
	}
	for ck, ov := range carried {
		s.overlays[ck] = ov
		s.overlayBytes += ov.size()
	}
	m.sessions[k] = s
	m.perToken[k.token]++
	if m.opts.Opened != nil {
		m.opts.Opened()
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		reason, err := m.follow(ctx, s, token)
		m.end(s, reason, err)
	}()
	return s
}

func (m *Manager) read(ctx context.Context, s *session, token string) ([]registry.Entity, error) {
	now := m.opts.Now
	s.mu.Lock()
	switch {
	case s.ended:
		// end publishes ended before it has finished (stream closed, close counted): wait for that,
		// so a read never reports a close the manager has not completed. end does not block.
		err := s.err
		s.mu.Unlock()
		<-s.done
		return nil, err
	case s.isLive && m.opts.Recheck > 0 && !s.checking && now().Sub(s.checked) >= m.opts.Recheck:
		// One read re-checks; reads arriving meanwhile are answered from the cache, still within
		// the previous check's window.
		s.checking = true
		s.mu.Unlock()
		_, err := m.exchangeFresh(ctx, token)
		s.mu.Lock()
		s.checking, s.checked = false, now()
		s.mu.Unlock()
		if errors.Is(err, exchange.ErrRefused) {
			m.end(s, CloseRevoked, ErrRefused)
			return nil, ErrRefused
		}
		return m.read(ctx, s, token)
	case s.isLive:
		defer s.mu.Unlock()
		s.lastRead = now()
		return s.view(now()), nil
	case s.stalled:
		s.mu.Unlock()
		return nil, ErrStalled
	}
	s.mu.Unlock()
	select {
	case <-s.live:
		return m.read(ctx, s, token)
	case <-s.done:
		return m.read(ctx, s, token)
	case <-ctx.Done():
		s.mu.Lock()
		s.stalled = !s.isLive
		s.mu.Unlock()
		return nil, ErrNotLive
	}
}

// view is what a read is answered: the base, each key holding an overlay answered by it (a delete
// marker by nothing), sorted by URN, then key. Expired overlays are dropped here. A stream that holds
// nothing and names no head is answered as it is (READ-YOUR-WRITES). s.mu is held.
func (s *session) view(now time.Time) []registry.Entity {
	for k, ov := range s.overlays {
		if !now.Before(ov.until) {
			s.dropOverlay(k)
		}
	}
	if len(s.records) == 0 && !s.hasHead {
		return []registry.Entity{}
	}
	out := make([]registry.Entity, 0, len(s.records)+len(s.overlays))
	for _, e := range s.records {
		if _, over := s.overlays[e.Key]; !over || e.Key == "" {
			out = append(out, e)
		}
	}
	for k, ov := range s.overlays {
		if !ov.deleted {
			// Opaque, and new at every write.
			out = append(out, registry.Entity{URN: ov.urn, Key: k, Rev: "seq." + strconv.FormatInt(ov.seq, 10), Body: ov.body, Seq: ov.seq, Version: ov.version})
		}
	}
	slices.SortFunc(out, func(a, b registry.Entity) int {
		if c := strings.Compare(a.URN, b.URN); c != 0 {
			return c
		}
		return strings.Compare(a.Key, b.Key)
	})
	return out
}

func entitySize(e registry.Entity) int {
	n := len(e.URN) + len(e.Rev) + len(e.Body) + len(e.Key)
	for _, sc := range e.Schemas {
		n += len(sc)
	}
	return n
}

// follow reads the stream until it ends, applying each event to the cache. It returns why it ended.
func (m *Manager) follow(ctx context.Context, s *session, token string) (string, error) {
	tok, err := m.opts.Exchange(ctx, token)
	if err != nil {
		switch {
		case errors.Is(err, exchange.ErrRefused):
			return CloseRefused, ErrRefused
		case errors.Is(err, exchange.ErrSpent):
			return CloseBlockSpent, ErrBlockSpent
		case errors.Is(err, exchange.ErrBlockCacheFull):
			return CloseBlockFull, ErrBlockFull
		}
		if m.opts.ClassifyExchange != nil {
			if f := m.opts.ClassifyExchange(err); f != nil {
				return f.Reason, f
			}
		}
		return CloseError, ErrFailed
	}
	s.mu.Lock()
	// A token answered from a cache was last checked when the hub last exchanged its subject: the
	// re-check counts from then, never from this open.
	s.expires, s.checked = tok.Expires, m.opts.Now()
	if !tok.Checked.IsZero() {
		s.checked = tok.Checked
	}
	s.mu.Unlock()
	cursor := m.restore(ctx, s)
	for {
		reason, err := m.stream(ctx, s, token, tok.Access, cursor)
		if !errors.Is(err, errStartOver) {
			return reason, err
		}
		cursor = ""
	}
}

// stream subscribes, from cursor when it is set (RESUME), and reads the subscription until it ends.
// errStartOver: the resume could not go on, and the snapshot it restored is dropped.
func (m *Manager) stream(ctx context.Context, s *session, token, access, cursor string) (string, error) {
	resuming := cursor != ""
	var st Stream
	var err error
	switch meta := m.subscribeMeta(token); {
	case resuming:
		// restore resumes only with a ResumeSubscriber.
		st, err = m.sub.(ResumeSubscriber).SubscribeFrom(ctx, s.k.schema, access, syncRequest, cursor)
	case meta != nil:
		ms, ok := m.sub.(MetaSubscriber)
		if !ok {
			return CloseError, ErrFailed
		}
		st, err = ms.SubscribeMeta(ctx, s.k.schema, access, meta)
	default:
		st, err = m.sub.Subscribe(ctx, s.k.schema, access)
	}
	if err != nil {
		if resuming && refusedCursor(err) {
			return "", m.startOver(ctx, s, ResumeCursorRefused)
		}
		return m.classify(err)
	}
	defer func() { _ = st.Close() }()
	// end closes the stream itself, so a stream is never left reading after its session ended,
	// whether or not the subscriber honours ctx.
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return CloseShutdown, ErrClosed
	}
	s.stream = st
	s.mu.Unlock()
	for {
		ev, err := st.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return CloseEnd, ErrEnded
			}
			if resuming && s.awaitingSync() && refusedCursor(err) {
				return "", m.startOver(ctx, s, ResumeCursorRefused)
			}
			return m.classify(err)
		}
		switch ev.Type {
		case registry.Upsert:
			// An upsert without a body is the entity deleted (the spec's "Validity" rule 2).
			if len(ev.Entity.Body) == 0 || string(ev.Entity.Body) == "null" {
				s.remove(ev.Entity.URN, ev.Cursor)
			} else if !s.put(ev.Entity, m.opts.MaxRecords, m.opts.MaxBytes, ev.Cursor) {
				return CloseTooLarge, ErrTooLarge
			}
		case registry.Delete:
			s.remove(ev.URN, ev.Cursor)
		case registry.Live:
			// A resumed stream's Live is held to this feed's cursors too.
			if !m.accepts(ev.Cursor) {
				return CloseNotPrivate, ErrNotPrivate
			}
			if resuming && syncOf(ev.Meta) != syncPending {
				// An adapter that will not say when its first poll is sent: the snapshot could be
				// answered before the Deletes it missed arrive. Start over.
				return "", m.startOver(ctx, s, ResumeUnsupported)
			}
			// Before Live: a read answered at Live is answered under this head.
			if m.writesOn() && !s.observeHead(ev.Meta) {
				return CloseCursorExpired, ErrCursorExpired
			}
			s.observeMeta(ev.Meta)
			s.complete(ev.Cursor)
			if !resuming {
				s.markLive()
			}
		case registry.Progress:
			if m.writesOn() && !s.observeHead(ev.Meta) {
				return CloseCursorExpired, ErrCursorExpired
			}
			s.observeMeta(ev.Meta)
			s.complete(ev.Cursor)
			if resuming && s.awaitingSync() && syncOf(ev.Meta) == syncDone {
				// The first poll's changes are in: the resumed stream holds what a fresh snapshot would.
				s.mu.Lock()
				s.resumed = false
				s.mu.Unlock()
				s.markLive()
				m.observeResume(ResumeSynced)
			}
		case registry.End:
			return CloseEnd, endError(ev.Meta)
		case registry.Malformed:
			// A change this cache cannot apply leaves it unable to say what the user holds: a record
			// that should have left might still be served. Start over instead.
			if ev.Of != registry.Progress {
				return CloseMalformed, ErrFailed
			}
		}
	}
}

// refusedCursor reports whether err is the adapter refusing a resume's cursor: `cursor_expired`, or
// `bad_request` (a cursor it cannot read).
func refusedCursor(err error) bool {
	code := registry.CodeOf(err)
	return code == registry.CursorExpired || code == registry.BadRequest
}

// awaitingSync reports whether s is a resumed stream not synced yet.
func (s *session) awaitingSync() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resumed
}

// startOver drops what a resume restored, and its snapshot, so the stream subscribes again from a
// fresh snapshot (errStartOver). The overlays stay: they are this token's acknowledged writes.
func (m *Manager) startOver(ctx context.Context, s *session, outcome string) error {
	m.opts.Snapshots.Drop(ctx, s.snapKey())
	s.mu.Lock()
	s.records, s.bytes, s.resumed, s.cursor, s.midBatch = map[string]registry.Entity{}, 0, false, "", false
	// The resumed Live's head was the saved state's: the fresh snapshot names its own.
	s.head, s.hasHead = 0, false
	s.mu.Unlock()
	m.observeResume(outcome)
	return errStartOver
}

func (m *Manager) observeResume(outcome string) {
	if m.opts.Resumed != nil {
		m.opts.Resumed(outcome)
	}
}

// snapKey is s's key in Snapshots.
func (s *session) snapKey() SnapshotKey {
	return SnapshotKey{Token: s.k.token, Schema: s.k.schema, Region: s.k.region}
}

// restore loads s's snapshot into its records (RESUME) and answers the cursor to resume from; "" when
// there is none to resume.
func (m *Manager) restore(ctx context.Context, s *session) string {
	if m.opts.Snapshots == nil || s.fresh {
		return ""
	}
	if _, ok := m.sub.(ResumeSubscriber); !ok || m.opts.SubscribeMeta != nil {
		// A manager whose subscriptions name a meta of their own is not resumed: the sync request
		// is the resume's whole meta.
		return ""
	}
	sv, ok := m.opts.Snapshots.Load(ctx, s.snapKey())
	if !ok {
		return ""
	}
	records := make(map[string]registry.Entity, len(sv.Records))
	n := 0
	for _, e := range sv.Records {
		records[e.URN] = e
		n += entitySize(e)
	}
	if _, dup := records[""]; dup || !m.accepts(sv.Cursor) || len(records) != len(sv.Records) ||
		len(records) > m.opts.MaxRecords || n > m.opts.MaxBytes {
		m.opts.Snapshots.Drop(ctx, s.snapKey())
		m.observeResume(ResumeDiscarded)
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return ""
	}
	s.records, s.bytes, s.resumed, s.cursor = records, n, true, sv.Cursor
	return sv.Cursor
}

// exchangeFresh is the re-check's exchange (Options.ExchangeFresh).
func (m *Manager) exchangeFresh(ctx context.Context, subject string) (exchange.Token, error) {
	if m.opts.ExchangeFresh != nil {
		return m.opts.ExchangeFresh(ctx, subject)
	}
	return m.opts.Exchange(ctx, subject)
}

// writesOn is the writes flag as the manager sees it (OverlayTTL is set only with it).
func (m *Manager) writesOn() bool { return m.opts.OverlayTTL > 0 }

func (m *Manager) accepts(cursor string) bool {
	if m.opts.Accept != nil {
		return m.opts.Accept(cursor)
	}
	return PrivateFeedCursor(cursor)
}

func (m *Manager) subscribeMeta(subject string) json.RawMessage {
	if m.opts.SubscribeMeta == nil {
		return nil
	}
	return m.opts.SubscribeMeta(subject)
}

// observeMeta keeps meta as the stream's latest; an event with none leaves the last one.
func (s *session) observeMeta(meta json.RawMessage) {
	if len(meta) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta = meta
}

func (m *Manager) classify(err error) (string, error) {
	switch code := registry.CodeOf(err); {
	case code == registry.InvalidToken:
		return CloseInvalidToken, ErrInvalidToken
	case code == registry.CursorExpired && m.writesOn():
		// The adapter's answer to a head that went back (private-feed.ts). Off, it is a failure, as
		// it always was.
		return CloseCursorExpired, ErrCursorExpired
	}
	return CloseError, ErrFailed
}

// headOf reads `{"head":{"seq":N}}`; false when meta names no head this service can read.
func headOf(meta json.RawMessage) (int64, bool) {
	if len(meta) == 0 {
		return 0, false
	}
	var m struct {
		Head *struct {
			Seq *int64 `json:"seq"`
		} `json:"head"`
	}
	if json.Unmarshal(meta, &m) != nil || m.Head == nil || m.Head.Seq == nil || *m.Head.Seq < 0 {
		return 0, false
	}
	return *m.Head.Seq, true
}

// observeHead takes the head meta names and drops every overlay at or below it: the poll that read
// it held every such write, and the stream has sent that poll's changes before it. False for a head
// below the one held.
func (s *session) observeHead(meta json.RawMessage) bool {
	h, ok := headOf(meta)
	if !ok {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasHead && h < s.head {
		return false
	}
	s.head, s.hasHead = h, true
	for k, ov := range s.overlays {
		if ov.seq <= h {
			s.dropOverlay(k)
		}
	}
	return true
}

// complete records that the records are complete at cursor (a Live or a Progress; THE CONSISTENT
// CURSOR).
func (s *session) complete(cursor string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cursor, s.midBatch = cursor, false
}

// at records the cursor of an event that changed the records (THE CONSISTENT CURSOR). s.mu is held.
func (s *session) at(cursor string) {
	switch cursor {
	case "":
		// A snapshot's upsert: complete only at Live.
	case s.cursor:
		s.midBatch = true
	default:
		s.cursor, s.midBatch = cursor, false
	}
	s.dirty = true
}

func (s *session) put(e registry.Entity, maxRecords, maxBytes int, cursor string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return true
	}
	s.at(cursor)
	prev, had := s.records[e.URN]
	if had {
		s.bytes -= entitySize(prev)
	}
	s.records[e.URN] = e
	s.bytes += entitySize(e)
	if ov, ok := s.overlays[e.Key]; ok && e.Key != "" && e.Seq > 0 && e.Seq >= ov.seq {
		s.dropOverlay(e.Key)
	}
	return len(s.records) <= maxRecords && s.bytes <= maxBytes
}

func (s *session) remove(urn, cursor string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	s.at(cursor)
	if prev, ok := s.records[urn]; ok {
		s.bytes -= entitySize(prev)
		delete(s.records, urn)
	}
	for k, ov := range s.overlays {
		if ov.urn != "" && ov.urn == urn {
			s.dropOverlay(k)
		}
	}
}

func (s *session) markLive() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isLive && !s.ended {
		s.isLive = true
		s.stalled = false
		close(s.live)
	}
}

// end closes a session once, for reason: it leaves the map (freeing its slots), its cache is
// dropped, and its stream is cancelled. A failure puts its key in cooldown.
func (m *Manager) end(s *session, reason string, err error) {
	m.mu.Lock()
	st, ok := m.endLocked(s, reason, err)
	m.mu.Unlock()
	if ok {
		m.finish(s, st, reason)
	}
}

// endLocked is end's part under m.mu: false when s had already ended. finish must follow, without
// m.mu, with the stream it answers.
func (m *Manager) endLocked(s *session, reason string, err error) (Stream, bool) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil, false
	}
	s.onEnd = m.persistOnEnd(s, reason, err)
	s.ended, s.err, s.records, s.bytes = true, err, nil, 0
	s.overlays, s.overlayBytes = nil, 0
	st := s.stream
	s.mu.Unlock()
	if m.sessions[s.k] == s {
		delete(m.sessions, s.k)
		if m.perToken[s.k.token]--; m.perToken[s.k.token] <= 0 {
			delete(m.perToken, s.k.token)
		}
		if m.opts.Budget != nil {
			m.opts.Budget.give(m.opts.Reserve)
		}
	}
	if errors.Is(err, ErrInvalidToken) && m.opts.InvalidToken != nil {
		m.opts.InvalidToken()
	}
	switch reason {
	case CloseIdle, CloseAge, CloseExpiry, CloseShutdown, CloseCursorExpired, CloseFloorReopen, CloseReleased:
	case CloseNotPrivate:
		m.cooling[s.k] = m.opts.Now().Add(m.opts.NotPrivateCooldown)
	default:
		m.cooling[s.k] = m.opts.Now().Add(m.opts.Cooldown)
		var ended *EndedError
		var failure *ExchangeFailure
		if errors.As(err, &ended) || errors.As(err, &failure) {
			m.coolCause[s.k] = err
		}
	}
	return st, true
}

// finish is end's part without m.mu: the stream cancelled and closed, the close counted, done closed.
func (m *Manager) finish(s *session, st Stream, reason string) {
	s.cancel()
	if st != nil {
		_ = st.Close()
	}
	if s.onEnd != nil {
		s.onEnd()
	}
	// Observed before done is closed: a reader woken by done (Read returning the session's error)
	// then finds the close already counted, never a moment before it.
	if m.opts.Closed != nil {
		m.opts.Closed(reason)
	}
	close(s.done)
}

// Sweep closes every stream idle for IdleTTL, open for MaxAge, or within ExpiryMargin of its token
// expiry, and forgets expired cooldowns.
func (m *Manager) Sweep() {
	now := m.opts.Now()
	type closing struct {
		s      *session
		reason string
	}
	var out []closing
	var saves []func()
	m.mu.Lock()
	for _, s := range m.sessions {
		s.mu.Lock()
		switch {
		case now.Sub(s.opened) >= m.opts.MaxAge:
			out = append(out, closing{s, CloseAge})
		case !s.expires.IsZero() && !now.Before(s.expires.Add(-m.opts.ExpiryMargin)):
			out = append(out, closing{s, CloseExpiry})
		case now.Sub(s.lastRead) >= m.opts.IdleTTL:
			out = append(out, closing{s, CloseIdle})
		}
		for k, ov := range s.overlays {
			if !now.Before(ov.until) {
				s.dropOverlay(k)
			}
		}
		if m.opts.Snapshots != nil && s.dirty {
			if save := m.saver(s, now); save != nil {
				s.dirty = false
				saves = append(saves, save)
			}
		}
		s.mu.Unlock()
	}
	for k, until := range m.cooling {
		if !now.Before(until) {
			delete(m.cooling, k)
			delete(m.coolCause, k)
		}
	}
	for k, at := range m.reopened {
		if now.Sub(at) >= m.opts.ReopenEvery {
			delete(m.reopened, k)
		}
	}
	m.mu.Unlock()
	for _, c := range out {
		m.end(c.s, c.reason, ErrClosed)
	}
	for _, save := range saves {
		save()
	}
}

// saver is the save of s's snapshot as of now (SNAPSHOTS), or nil when it has none to save: not live,
// not synced, part-way through a batch, or with no time left. s.mu is held; the save runs without it.
func (m *Manager) saver(s *session, now time.Time) func() {
	ttl := m.opts.IdleTTL
	if !s.expires.IsZero() {
		ttl = min(ttl, s.expires.Sub(now))
	}
	if !s.isLive || s.ended || s.resumed || s.midBatch || ttl <= 0 || !m.accepts(s.cursor) {
		return nil
	}
	saved := Saved{Cursor: s.cursor, Records: make([]registry.Entity, 0, len(s.records))}
	for _, e := range s.records {
		saved.Records = append(saved.Records, e)
	}
	k := s.snapKey()
	// The manager's own context: a save at shutdown runs before it is cancelled, and the cache bounds
	// each call by its own timeout whatever the context.
	return func() { m.opts.Snapshots.Save(m.base, k, saved, ttl) }
}

// persistOnEnd is what s's end persists (SNAPSHOTS): an idle close and a shutdown save its snapshot,
// an end that refused its token or its data drops it, and every other end leaves what is saved. s.mu
// is held, before its records are dropped.
func (m *Manager) persistOnEnd(s *session, reason string, err error) func() {
	if m.opts.Snapshots == nil {
		return nil
	}
	var failure *ExchangeFailure
	switch {
	case reason == CloseIdle || reason == CloseShutdown:
		return m.saver(s, m.opts.Now())
	case reason == CloseRefused || reason == CloseRevoked || reason == CloseInvalidToken:
		k := s.snapKey()
		return func() {
			m.opts.Snapshots.Drop(m.base, k)
			if m.opts.Forget != nil {
				m.opts.Forget(k.Token)
			}
		}
	case reason == CloseNotPrivate || reason == CloseTooLarge || reason == CloseMalformed || reason == CloseEnd ||
		reason == CloseCursorExpired || errors.As(err, &failure):
		k := s.snapKey()
		return func() { m.opts.Snapshots.Drop(m.base, k) }
	}
	return nil
}

// Run sweeps every interval until ctx is done, then closes every stream.
func (m *Manager) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.Close()
			return
		case <-t.C:
			m.Sweep()
		}
	}
}

// Close ends every stream and refuses every later read; it returns once every stream is closed.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		m.end(s, CloseShutdown, ErrClosed)
	}
	m.cancel()
	m.wg.Wait()
}

// Stats is what the manager holds now.
type Stats struct {
	Streams, Live, Records, Bytes int
}

// Stats reads the manager's current size.
func (m *Manager) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := Stats{Streams: len(m.sessions)}
	for _, s := range m.sessions {
		s.mu.Lock()
		if s.isLive {
			st.Live++
		}
		// Overlays are bounded apart from the records (MaxOverlayBytes), so a stream may hold both.
		st.Records += len(s.records) + len(s.overlays)
		st.Bytes += s.bytes + s.overlayBytes
		s.mu.Unlock()
	}
	return st
}
