// Package session holds the per-user registry streams: one lazy, short-lived stream per (bearer
// token, collection schema), opened with THAT token, so the origin (the registry adapter) stays the
// only judge of what the user may read. Decided on civitai/civitai-registry#49, option (a).
//
// ISOLATION. A stream and its cache are keyed by the SHA-256 of the token that opened it together
// with the schema. Nothing here decodes a token or knows whose it is: two tokens are two keys, so a
// record one token's stream received can only ever be read back with that same token. Two tokens of
// the same user are two streams too (the auth extension, Relays rule 2: an authorized stream
// belongs to one consumer). The token itself is held only by the goroutine that reads its stream.
//
// LIFECYCLE. A stream opens on the first read for its key and is closed when no read has used it
// for IdleTTL, or MaxAge after it opened, whichever comes first, or when it fails. A read is
// answered from the cache only once the stream has sent `Live` (the snapshot is complete); before
// that the read waits, bounded by its context, and then gives up so the caller can read REST
// instead. A stream that has made one read give up is STALLED: later reads do not wait on it (see
// DESIGN.md on civitai/civitai-registry#50, a relay that never sends `Live`) and do not count as use,
// so an idle stall is closed by IdleTTL.
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
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

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
	ErrEnded         = errors.New("session: the registry ended the stream")
	ErrFailed        = errors.New("session: the stream failed")
	ErrClosed        = errors.New("session: closed")
)

// The `reason` a stream was closed for (metrics.CloseReasons).
const (
	CloseIdle         = "idle"
	CloseAge          = "age"
	CloseInvalidToken = "invalid_token"
	CloseTooLarge     = "too_large"
	CloseEnd          = "end"
	CloseMalformed    = "malformed"
	CloseError        = "error"
	CloseShutdown     = "shutdown"
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
	stream   Stream // the open subscription, once Subscribe returned; closed by end
	isLive   bool
	stalled  bool
	ended    bool
	err      error
	lastRead time.Time
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
	return s.read(ctx, m.opts.Now)
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

func (s *session) read(ctx context.Context, now func() time.Time) ([]registry.Entity, error) {
	s.mu.Lock()
	switch {
	case s.ended:
		err := s.err
		s.mu.Unlock()
		return nil, err
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
		return s.read(ctx, now)
	case <-s.done:
		return s.read(ctx, now)
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
	n := len(e.URN) + len(e.Rev) + len(e.Body)
	for _, sc := range e.Schemas {
		n += len(sc)
	}
	return n
}

// follow reads the stream until it ends, applying each event to the cache. It returns why it ended.
func (m *Manager) follow(ctx context.Context, s *session, token string) (string, error) {
	st, err := m.sub.Subscribe(ctx, s.k.schema, token)
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
	case CloseIdle, CloseAge, CloseShutdown:
	default:
		m.cooling[s.k] = m.opts.Now().Add(m.opts.Cooldown)
	}
	m.mu.Unlock()
	s.cancel()
	if st != nil {
		_ = st.Close()
	}
	close(s.done)
	if m.opts.Closed != nil {
		m.opts.Closed(reason)
	}
}

// Sweep closes every stream idle for IdleTTL or open for MaxAge, and forgets expired cooldowns.
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
