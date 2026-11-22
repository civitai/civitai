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
package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"regexp"
	"slices"
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
)

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
}

// Read returns every record the token's stream of schema holds, once that stream has sent `Live`,
// opening the stream if none is open. Any error means: nothing from the stream, read REST.
func (m *Manager) Read(ctx context.Context, token, schema string) ([]registry.Entity, error) {
	k := key{token: sha256.Sum256([]byte(token)), schema: schema}
	now := m.opts.Now()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrClosed
	}
	s := m.sessions[k]
	if s == nil {
		if until, ok := m.cooling[k]; ok && now.Before(until) {
			m.mu.Unlock()
			return nil, ErrCoolingDown
		}
		if len(m.sessions) >= m.opts.MaxStreams {
			m.mu.Unlock()
			return nil, ErrCapacity
		}
		if m.perToken[k.token] >= m.opts.MaxPerToken {
			m.mu.Unlock()
			return nil, ErrTokenCapacity
		}
		s = m.open(k, token, now) //nolint:contextcheck // a stream outlives the read that opened it: it runs on the manager's own context
	}
	m.mu.Unlock()
	return m.read(ctx, s, token)
}

// open starts a session's stream. m.mu is held.
func (m *Manager) open(k key, token string, now time.Time) *session {
	delete(m.cooling, k)
	ctx, cancel := context.WithCancel(m.base)
	s := &session{
		k: k, opened: now, lastRead: now, cancel: cancel,
		live: make(chan struct{}), done: make(chan struct{}), records: map[string]registry.Entity{},
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
		return s.snapshot(), nil
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

// snapshot copies the records, sorted by URN. s.mu is held.
func (s *session) snapshot() []registry.Entity {
	out := make([]registry.Entity, 0, len(s.records))
	for _, e := range s.records {
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b registry.Entity) int { return strings.Compare(a.URN, b.URN) })
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
			s.markLive()
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
	if registry.CodeOf(err) == registry.InvalidToken {
		return CloseInvalidToken, ErrInvalidToken
	}
	return CloseError, ErrFailed
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
	st := s.stream
	s.mu.Unlock()
	if m.sessions[s.k] == s {
		delete(m.sessions, s.k)
		if m.perToken[s.k.token]--; m.perToken[s.k.token] <= 0 {
			delete(m.perToken, s.k.token)
		}
	}
	switch reason {
	case CloseIdle, CloseAge, CloseExpiry, CloseShutdown:
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
		s.mu.Unlock()
	}
	for k, until := range m.cooling {
		if !now.Before(until) {
			delete(m.cooling, k)
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
