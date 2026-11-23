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
// CAPS. At most MaxStreams streams in the process and MaxPerToken per token. A read that would open
// a stream over either cap is refused with ErrCapacity or ErrTokenCapacity and opens nothing; the
// caller reads REST. A stream whose cache outgrows MaxRecords or MaxBytes is closed (ErrTooLarge).
// A key whose stream failed is not reopened for Cooldown, so a broken registry is not asked again on
// every read.
//
// READ-YOUR-WRITES (WRITES-DESIGN.md, "Read-your-writes: two sequences, base and overlay"). The
// stream's records are the BASE; each write the store acknowledged for this token (Ack) is an OVERLAY
// over it, by storage key, at the write's `seq`, until the stream shows it. The two are never merged:
// a read answers the overlay where one is held, else the base, so dropping an overlay shows the base
// again, never a vanished record. An ack applies only when its seq is at least the overlay's and the
// base's for that key, and above the stream's head (the head says every write at or below it is
// already in what the stream sent). A delete leaves a delete marker at its tombstone's seq. An
// overlay is dropped when a stream upsert of its key carries a seq at or above it, when the stream's
// head reaches it, when the stream deletes its URN (a moderator hide after the write wins; a Delete of
// another URN, the old row of a re-created key, does not), or OverlayTTL after it was set (one
// adapter poll plus 30 s: the case the stream cannot correct). An upsert without a seq (an adapter
// before body format k2) replaces the base only.
//
// THE FLOOR. A read may name a floor, minSeq: the highest seq the client was acknowledged for the
// app. It is met when the stream's head is at or above it, or, for a block token only, when an
// overlay this replica holds for the token (of the same app) is: a block token's writes are served
// by this replica only, a hub token's may have landed on another. A read whose floor is not met
// reopens its stream (a fresh snapshot, whose head the adapter read before its records) at most once
// per (token, schema) per ReopenEvery; a floor still not met, or a reopen already spent, is
// ErrFloorNotMet.
//
// A HEAD THAT WENT BACK means the namespace's seqs restarted (its usage row wiped and written again):
// the adapter ends the stream `cursor_expired`, and a head below the one held is treated the same.
// Neither is a failure: the stream closes with no cooldown, its overlays (numbered in the old order)
// are dropped, and the read that met it opens a fresh stream once.
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
)

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

// ClientSubscriber opens subscriptions on a registry over its HTTP binding.
type ClientSubscriber struct{ Client *registry.Client }

// Subscribe implements Subscriber.
func (c ClientSubscriber) Subscribe(ctx context.Context, schema, token string) (Stream, error) {
	s, err := c.Client.Subscribe(ctx, registry.Request{Schema: schema, Token: token})
	if err != nil {
		return nil, err
	}
	return s, nil
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

// Ack is one write the store acknowledged, as the site answered it to this service (WRITES-DESIGN.md,
// "Store changes"): a create's or put's record, or a delete's tombstone.
type Ack struct {
	// Key is the record's storage key.
	Key string
	// Seq is where the write sits in the app namespace's write order. An ack without one is not
	// applied: nothing could order it against the stream.
	Seq int64
	// Deleted is a delete's tombstone; URN and Body are then unused.
	Deleted bool
	// URN is the record's document URN (from the answer's recordId); "" when the answer named none.
	URN string
	// Body is the record's data as the write answered it.
	Body json.RawMessage
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
	// it: one adapter poll plus 30 s. Zero applies no acknowledgement (the writes are off).
	OverlayTTL time.Duration
	// ReopenEvery bounds the floor's reopens: at most one per (token, schema) per this interval, the
	// adapter's poll.
	ReopenEvery time.Duration
	// Floor observes each read whose floor its stream had not met, by outcome (Floor*); Overlaid each
	// acknowledgement applied, by kind (Overlay*). Nil is none.
	Floor    func(outcome string)
	Overlaid func(kind string)
}

type tokenID [sha256.Size]byte

type key struct {
	token  tokenID
	schema string
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
		reopened: map[key]time.Time{},
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
	checked  time.Time // the last exchange of the user's token, refused or not
	checking bool      // a read is re-checking the user's token now
	records  map[string]registry.Entity
	bytes    int
	// head is the newest head the stream named (Live / Progress meta), when hasHead.
	head    int64
	hasHead bool
	// overlays are this token's acknowledged writes the stream has not shown yet, by storage key;
	// overlayBytes their size, bounded with the records' own bounds.
	overlays     map[string]overlay
	overlayBytes int
}

// overlay is one acknowledged write (READ-YOUR-WRITES): a record, or a delete marker.
type overlay struct {
	seq     int64
	urn     string // the record's URN; "" when unknown
	deleted bool
	body    json.RawMessage
	until   time.Time // dropped at this time, whether or not the stream caught up
}

func (o overlay) size() int { return len(o.urn) + len(o.body) }

// Read is ReadAt with no floor.
func (m *Manager) Read(ctx context.Context, token, schema string) ([]registry.Entity, error) {
	return m.ReadAt(ctx, token, schema, 0)
}

// ReadAt returns every record the token's stream of schema holds, its overlays applied, once that
// stream has sent `Live`, opening the stream if none is open. A minSeq above zero is the read's floor
// (THE FLOOR). Any error means: nothing from the stream.
func (m *Manager) ReadAt(ctx context.Context, token, schema string, minSeq int64) ([]registry.Entity, error) {
	k := key{token: sha256.Sum256([]byte(token)), schema: schema}
	for retried := false; ; retried = true {
		s, err := m.session(k, token) //nolint:contextcheck // a stream outlives the read that opened it: it runs on the manager's own context
		if err != nil {
			return nil, err
		}
		ents, err := m.read(ctx, s, token)
		switch {
		case errors.Is(err, ErrCursorExpired) && !retried:
			// The stream's seqs restarted: one fresh stream, which the key has no cooldown against.
			continue
		case err != nil:
			return nil, err
		case minSeq <= 0:
			return ents, nil
		}
		return m.floor(ctx, s, token, minSeq, ents)
	}
}

// session is the key's open session, or a new one.
func (m *Manager) session(k key, token string) (*session, error) {
	now := m.opts.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	if s := m.sessions[k]; s != nil {
		return s, nil
	}
	if until, ok := m.cooling[k]; ok && now.Before(until) {
		return nil, ErrCoolingDown
	}
	if err := m.room(k); err != nil {
		return nil, err
	}
	return m.open(k, token, now, nil), nil //nolint:contextcheck // a stream outlives the read that opened it: it runs on the manager's own context
}

// room reports whether a stream for k may open now, under the caps. m.mu is held.
func (m *Manager) room(k key) error {
	switch {
	case len(m.sessions) >= m.opts.MaxStreams:
		return ErrCapacity
	case m.perToken[k.token] >= m.opts.MaxPerToken:
		return ErrTokenCapacity
	}
	return nil
}

// floor answers a read of s whose records are ents under its floor (THE FLOOR).
func (m *Manager) floor(ctx context.Context, s *session, token string, minSeq int64, ents []registry.Entity) ([]registry.Entity, error) {
	if m.met(s, token, minSeq) {
		return ents, nil
	}
	now := m.opts.Now()
	m.mu.Lock()
	if at, ok := m.reopened[s.k]; ok && now.Sub(at) < m.opts.ReopenEvery {
		m.mu.Unlock()
		m.observeFloor(FloorSpent)
		return nil, ErrFloorNotMet
	}
	m.reopened[s.k] = now
	m.mu.Unlock()
	fresh, err := m.reopen(s, token) //nolint:contextcheck // as session: the reopened stream runs on the manager's own context
	if err == nil {
		ents, err = m.read(ctx, fresh, token)
	}
	switch {
	case err != nil:
		m.observeFloor(FloorStillBehind)
		return nil, err
	case !m.met(fresh, token, minSeq):
		m.observeFloor(FloorStillBehind)
		return nil, ErrFloorNotMet
	}
	m.observeFloor(FloorMet)
	return ents, nil
}

func (m *Manager) observeFloor(outcome string) {
	if m.opts.Floor != nil {
		m.opts.Floor(outcome)
	}
}

// met reports whether s meets the floor: its head, or for a block token an overlay this replica holds
// for the token, in a stream of the same app (seqs are per app namespace).
func (m *Manager) met(s *session, token string, floor int64) bool {
	s.mu.Lock()
	ok := s.hasHead && s.head >= floor
	s.mu.Unlock()
	if ok || exchange.KindOf(token) != exchange.KindBlock {
		return ok
	}
	now, app := m.opts.Now(), appOf(s.k.schema)
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, o := range m.sessions {
		if k.token != s.k.token || appOf(k.schema) != app {
			continue
		}
		o.mu.Lock()
		for _, ov := range o.overlays {
			ok = ok || (ov.seq >= floor && now.Before(ov.until))
		}
		o.mu.Unlock()
	}
	return ok
}

// appOf is the app part of a collection schema URN, `urn:schema:<ns>:<slug>/`.
func appOf(schema string) string {
	app, _, _ := strings.Cut(schema, "/")
	return app
}

// reopen closes old and opens its key again, carrying its overlays: each is a write the store had
// committed before the new snapshot is read, so the snapshot holds it, and the overlay is dropped as
// the snapshot shows it.
func (m *Manager) reopen(old *session, token string) (*session, error) {
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
	return m.open(old.k, token, m.opts.Now(), carried), nil
}

// Ack applies one acknowledged write of token to its open stream of schema (READ-YOUR-WRITES). With
// no stream open there is nothing to overlay: the next read opens one, whose snapshot holds the write.
func (m *Manager) Ack(token, schema string, a Ack) {
	if m.opts.OverlayTTL <= 0 || a.Seq <= 0 || a.Key == "" {
		return
	}
	m.mu.Lock()
	s := m.sessions[key{token: sha256.Sum256([]byte(token)), schema: schema}]
	m.mu.Unlock()
	if s == nil {
		return
	}
	if kind, ok := s.ack(a, m.opts.Now().Add(m.opts.OverlayTTL), m.opts.MaxRecords, m.opts.MaxBytes); ok && m.opts.Overlaid != nil {
		m.opts.Overlaid(kind)
	}
}

// ack applies a under the overlay rules; it reports the overlay's kind, and whether it was applied.
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
	kind := OverlayRecord
	switch {
	case !a.Deleted:
		ov.urn, ov.body = a.URN, a.Body
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
	// Bounded as the stream is: past either bound the write is not overlaid (the stream shows it at
	// its next poll), and a floor gets no credit from it.
	if (!had && len(s.overlays) >= maxRecords) || n > maxBytes {
		return "", false
	}
	s.overlays[a.Key], s.overlayBytes = ov, n
	return kind, true
}

// baseOf is the base record of key with the highest seq. s.mu is held.
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

// dropOverlay drops the overlay of key. s.mu is held.
func (s *session) dropOverlay(k string) {
	if ov, ok := s.overlays[k]; ok {
		s.overlayBytes -= ov.size()
		delete(s.overlays, k)
	}
}

// open starts a session's stream, holding carried overlays. m.mu is held.
func (m *Manager) open(k key, token string, now time.Time, carried map[string]overlay) *session {
	delete(m.cooling, k)
	ctx, cancel := context.WithCancel(m.base)
	s := &session{
		k: k, opened: now, lastRead: now, cancel: cancel,
		live: make(chan struct{}), done: make(chan struct{}), records: map[string]registry.Entity{},
		overlays: map[string]overlay{},
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
		_, err := m.opts.Exchange(ctx, token)
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

// view copies what a read is answered: each record of the base whose key holds no overlay, and each
// overlay record (never a delete marker), sorted by URN, then key. An overlay past its time is
// dropped here, showing the base again. s.mu is held.
func (s *session) view(now time.Time) []registry.Entity {
	for k, ov := range s.overlays {
		if !now.Before(ov.until) {
			s.dropOverlay(k)
		}
	}
	out := make([]registry.Entity, 0, len(s.records)+len(s.overlays))
	for _, e := range s.records {
		if _, over := s.overlays[e.Key]; !over || e.Key == "" {
			out = append(out, e)
		}
	}
	for k, ov := range s.overlays {
		if !ov.deleted {
			// The rev of a record the stream has not sent: opaque, and new at every write.
			out = append(out, registry.Entity{URN: ov.urn, Key: k, Rev: "seq." + strconv.FormatInt(ov.seq, 10), Body: ov.body, Seq: ov.seq})
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
		return CloseError, ErrFailed
	}
	s.mu.Lock()
	s.expires, s.checked = tok.Expires, m.opts.Now()
	s.mu.Unlock()
	st, err := m.sub.Subscribe(ctx, s.k.schema, tok.Access)
	if err != nil {
		return classify(err)
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
			return classify(err)
		}
		switch ev.Type {
		case registry.Upsert:
			// An upsert without a body is the entity deleted (the spec's "Validity" rule 2).
			if len(ev.Entity.Body) == 0 || string(ev.Entity.Body) == "null" {
				s.remove(ev.Entity.URN)
			} else if !s.put(ev.Entity, m.opts.MaxRecords, m.opts.MaxBytes) {
				return CloseTooLarge, ErrTooLarge
			}
		case registry.Delete:
			s.remove(ev.URN)
		case registry.Live:
			if !PrivateFeedCursor(ev.Cursor) {
				return CloseNotPrivate, ErrNotPrivate
			}
			// Before Live: a read answered at Live is answered under this head.
			if !s.observeHead(ev.Meta) {
				return CloseCursorExpired, ErrCursorExpired
			}
			s.markLive()
		case registry.Progress:
			if !s.observeHead(ev.Meta) {
				return CloseCursorExpired, ErrCursorExpired
			}
		case registry.End:
			return CloseEnd, ErrEnded
		case registry.Malformed:
			// A change this cache cannot apply leaves it unable to say what the user holds: a record
			// that should have left might still be served. Start over instead.
			if ev.Of != registry.Progress {
				return CloseMalformed, ErrFailed
			}
		}
	}
}

func classify(err error) (string, error) {
	switch registry.CodeOf(err) {
	case registry.InvalidToken:
		return CloseInvalidToken, ErrInvalidToken
	case registry.CursorExpired:
		// The adapter's answer to a head that went back (private-feed.ts): not a failure.
		return CloseCursorExpired, ErrCursorExpired
	}
	return CloseError, ErrFailed
}

// headOf reads the head a live or progress event's meta names, `{"head":{"seq":N}}`; false when it
// names none (or none this service can read, which is the same: no head).
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

// observeHead takes the head meta names, dropping every overlay at or below it: the poll that read
// the head held every write at or below it, and the stream has sent what that poll read. It reports
// false for a head below the one held (A HEAD THAT WENT BACK).
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

func (s *session) put(e registry.Entity, maxRecords, maxBytes int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return true
	}
	prev, had := s.records[e.URN]
	if had {
		s.bytes -= entitySize(prev)
	}
	s.records[e.URN] = e
	s.bytes += entitySize(e)
	// The stream has caught up with this key's overlay. An upsert without a seq orders nothing.
	if ov, ok := s.overlays[e.Key]; ok && e.Key != "" && e.Seq > 0 && e.Seq >= ov.seq {
		s.dropOverlay(e.Key)
	}
	return len(s.records) <= maxRecords && s.bytes <= maxBytes
}

func (s *session) remove(urn string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	if prev, ok := s.records[urn]; ok {
		s.bytes -= entitySize(prev)
		delete(s.records, urn)
	}
	// A Delete of the overlay's own URN wins over it (a moderator hide after the write). One of
	// another URN, the old row of a re-created key, leaves it.
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
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		m.mu.Unlock()
		return
	}
	s.ended, s.err, s.records, s.bytes = true, err, nil, 0
	s.overlays, s.overlayBytes = nil, 0
	st := s.stream
	s.mu.Unlock()
	if m.sessions[s.k] == s {
		delete(m.sessions, s.k)
		if m.perToken[s.k.token]--; m.perToken[s.k.token] <= 0 {
			delete(m.perToken, s.k.token)
		}
	}
	switch reason {
	case CloseIdle, CloseAge, CloseExpiry, CloseShutdown, CloseCursorExpired, CloseFloorReopen:
	case CloseNotPrivate:
		m.cooling[s.k] = m.opts.Now().Add(m.opts.NotPrivateCooldown)
	default:
		m.cooling[s.k] = m.opts.Now().Add(m.opts.Cooldown)
	}
	m.mu.Unlock()
	s.cancel()
	if st != nil {
		_ = st.Close()
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
		s.mu.Unlock()
	}
	for k, until := range m.cooling {
		if !now.Before(until) {
			delete(m.cooling, k)
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
		st.Records += len(s.records)
		st.Bytes += s.bytes
		s.mu.Unlock()
	}
	return st
}
