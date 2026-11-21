package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// The fake origin: it judges by token, as the adapter does. Each token's stream is sent that
// token's records and then Live (unless the token is listed in noLive), and stays open for the test
// to push more events to.

type step struct {
	ev  registry.Event
	err error
}

type fakeStream struct {
	token, schema string
	events        chan step
	closed        chan struct{}
	once          sync.Once
}

func (s *fakeStream) Next() (registry.Event, error) {
	select {
	case st := <-s.events:
		return st.ev, st.err
	case <-s.closed:
		return registry.Event{}, &registry.Error{Code: registry.Unavailable, Message: "closed"}
	}
}

func (s *fakeStream) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func (s *fakeStream) isClosed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}

func (s *fakeStream) push(t *testing.T, st step) {
	t.Helper()
	select {
	case s.events <- st:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream was not read")
	}
}

type fakeOrigin struct {
	mu      sync.Mutex
	records map[string][]registry.Entity
	noLive  map[string]bool
	refuse  map[string]error
	streams []*fakeStream
	opened  atomic.Int32
	byToken map[string]int
	raw     int // subscriptions that presented a token the hub did not issue
	// exchange: what the fake hub refuses, by subject.
	refuseExchange map[string]error
	exchanges      map[string]int
	now            func() time.Time
	life           time.Duration // of an exchanged token; zero is a day
}

func (o *fakeOrigin) Exchange(_ context.Context, subject string) (exchange.Token, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.exchanges[subject]++
	if err := o.refuseExchange[subject]; err != nil {
		return exchange.Token{}, err
	}
	life := o.life
	if life == 0 {
		life = 24 * time.Hour
	}
	return exchange.Token{Access: exchanged(subject), Expires: o.now().Add(life)}, nil
}

func newOrigin() *fakeOrigin {
	return &fakeOrigin{records: map[string][]registry.Entity{}, noLive: map[string]bool{},
		refuse: map[string]error{}, byToken: map[string]int{},
		refuseExchange: map[string]error{}, exchanges: map[string]int{}}
}

// exchanged is what the fake hub turns a user's token into.
func exchanged(subject string) string { return "x." + subject }

func (o *fakeOrigin) Subscribe(_ context.Context, schema, presented string) (Stream, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.opened.Add(1)
	// 🔴 The origin only ever sees exchanged tokens: a user's own token reaching it is a leak.
	token, ok := strings.CutPrefix(presented, "x.")
	if !ok {
		o.raw++
		return nil, &registry.Error{Code: registry.InvalidToken}
	}
	o.byToken[token]++
	if err := o.refuse[token]; err != nil {
		return nil, err
	}
	s := &fakeStream{token: token, schema: schema, events: make(chan step, 64), closed: make(chan struct{})}
	for _, e := range o.records[token] {
		s.events <- step{ev: registry.Event{Type: registry.Upsert, Entity: e}}
	}
	if !o.noLive[token] {
		s.events <- step{ev: registry.Event{Type: registry.Live, Cursor: liveCursor}}
	}
	o.streams = append(o.streams, s)
	return s, nil
}

func (o *fakeOrigin) opens(token string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.byToken[token]
}

func (o *fakeOrigin) last(t *testing.T, token string) *fakeStream {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := len(o.streams) - 1; i >= 0; i-- {
		if o.streams[i].token == token {
			return o.streams[i]
		}
	}
	t.Fatalf("no stream was opened for %q", token)
	return nil
}

func entity(urn, canary string) registry.Entity {
	body, _ := json.Marshal(map[string]string{"text": canary})
	return registry.Entity{URN: urn, Rev: "r1", Schemas: []string{schemaA}, Body: body}
}

// The cursors as the adapter sends them: every one wrapped as `b1.<24 hex binding>.<inner>`
// (subscription.ts bindCursor), around the private feed's `p1.` or the public document feed's `f1.`.
const (
	liveCursor   = "b1.0a1b2c3d4e5f60718293a4b5.p1.empty"
	publicCursor = "b1.0a1b2c3d4e5f60718293a4b5.f1.0123456789abcdef0123456789abcdef"
)

const (
	schemaA = "urn:schema:apps.civitai.com:todo-app/notes@v1"
	schemaB = "urn:schema:apps.civitai.com:todo-app/lists@v1"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type harness struct {
	o      *fakeOrigin
	m      *Manager
	c      *clock
	closed sync.Map // reason → *atomic.Int32
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	h := &harness{o: newOrigin(), c: &clock{t: time.Unix(1_700_000_000, 0)}}
	h.o.now = h.c.now
	opts.Exchange = h.o.Exchange
	if opts.ExpiryMargin == 0 {
		opts.ExpiryMargin = 10 * time.Second
	}
	if opts.NotPrivateCooldown == 0 {
		opts.NotPrivateCooldown = time.Hour
	}
	if opts.MaxStreams == 0 {
		opts.MaxStreams = 10
	}
	if opts.MaxPerToken == 0 {
		opts.MaxPerToken = 4
	}
	if opts.IdleTTL == 0 {
		opts.IdleTTL = time.Minute
	}
	if opts.MaxAge == 0 {
		opts.MaxAge = time.Hour
	}
	if opts.MaxRecords == 0 {
		opts.MaxRecords = 100
	}
	if opts.MaxBytes == 0 {
		opts.MaxBytes = 1 << 20
	}
	if opts.Cooldown == 0 {
		opts.Cooldown = 30 * time.Second
	}
	opts.Now = h.c.now
	opts.Closed = func(reason string) {
		n, _ := h.closed.LoadOrStore(reason, &atomic.Int32{})
		n.(*atomic.Int32).Add(1)
	}
	h.m = New(h.o, opts)
	t.Cleanup(func() {
		h.m.Close()
		if h.o.raw != 0 {
			t.Errorf("🔴 %d subscriptions presented a token the hub did not issue", h.o.raw)
		}
	})
	return h
}

// exchangesA counts the fake hub's exchanges of tok-a.
func (h *harness) exchangesA() int {
	h.o.mu.Lock()
	defer h.o.mu.Unlock()
	return h.o.exchanges["tok-a"]
}

func (h *harness) closedFor(reason string) int32 {
	n, ok := h.closed.Load(reason)
	if !ok {
		return 0
	}
	return n.(*atomic.Int32).Load()
}

func read(t *testing.T, m *Manager, token, schema string) ([]registry.Entity, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return m.Read(ctx, token, schema)
}

func urns(es []registry.Entity) string {
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.URN)
	}
	return strings.Join(out, ",")
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAStreamOpensOnlyOnTheFirstReadAndServesLaterReadsFromItsCache(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-a1", "A1")}
	if n := h.o.opened.Load(); n != 0 {
		t.Fatalf("opened %d streams before any read", n)
	}
	for i := range 3 {
		got, err := read(t, h.m, "tok-a", schemaA)
		if err != nil || urns(got) != "urn:apps.civitai.com:todo-app/notes/r-a1" {
			t.Fatalf("read %d: %q, %v", i, urns(got), err)
		}
	}
	if n := h.o.opened.Load(); n != 1 {
		t.Fatalf("opened %d streams for three reads of one key, want 1", n)
	}
	// Another collection is another stream, for the same token.
	if _, err := read(t, h.m, "tok-a", schemaB); err != nil {
		t.Fatal(err)
	}
	if n := h.o.opened.Load(); n != 2 {
		t.Fatalf("opened %d streams, want 2", n)
	}
}

// 🔴 One token's records never reach a read made with another token. Every user's URNs and canary
// bodies are distinct, and the reads interleave on the same schema.
func TestRecordsNeverCrossFromOneTokenToAnother(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-alice"] = []registry.Entity{
		entity("urn:apps.civitai.com:todo-app/notes/r-alice-1", "ALICE-CANARY-7f3a"),
		entity("urn:apps.civitai.com:todo-app/notes/r-alice-2", "ALICE-CANARY-19be"),
	}
	h.o.records["tok-bob"] = []registry.Entity{
		entity("urn:apps.civitai.com:todo-app/notes/r-bob-1", "BOB-CANARY-c40d"),
	}
	// carol holds nothing: her stream is empty, and must stay empty.
	var wg sync.WaitGroup
	errs := make(chan error, 90)
	for i := range 30 {
		for _, tok := range []string{"tok-alice", "tok-bob", "tok-carol"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				got, err := read(t, h.m, tok, schemaA)
				if err != nil {
					errs <- fmt.Errorf("%s read %d: %w", tok, i, err)
					return
				}
				raw, _ := json.Marshal(got)
				s := string(raw)
				switch tok {
				case "tok-alice":
					if !strings.Contains(s, "ALICE-CANARY-7f3a") || !strings.Contains(s, "ALICE-CANARY-19be") || strings.Contains(s, "BOB-") {
						errs <- fmt.Errorf("alice got %s", s)
					}
				case "tok-bob":
					if !strings.Contains(s, "BOB-CANARY-c40d") || strings.Contains(s, "ALICE-") || len(got) != 1 {
						errs <- fmt.Errorf("bob got %s", s)
					}
				case "tok-carol":
					if len(got) != 0 {
						errs <- fmt.Errorf("carol got %s", s)
					}
				}
			}()
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	// Each stream was opened with its own token, once.
	for _, tok := range []string{"tok-alice", "tok-bob", "tok-carol"} {
		if n := h.o.opens(tok); n != 1 {
			t.Errorf("%s: %d streams opened, want 1", tok, n)
		}
		if s := h.o.last(t, tok); s.schema != schemaA {
			t.Errorf("%s: stream schema %q", tok, s.schema)
		}
	}
	// A change on one stream reaches only that stream's reads.
	h.o.last(t, "tok-bob").push(t, step{ev: registry.Event{Type: registry.Upsert,
		Entity: entity("urn:apps.civitai.com:todo-app/notes/r-bob-2", "BOB-CANARY-new")}})
	eventually(t, "bob's new record", func() bool {
		got, _ := read(t, h.m, "tok-bob", schemaA)
		return len(got) == 2
	})
	got, _ := read(t, h.m, "tok-alice", schemaA)
	if raw, _ := json.Marshal(got); strings.Contains(string(raw), "BOB-") {
		t.Fatalf("alice got bob's change: %s", raw)
	}
}

func TestAStreamNoReadUsedForTheIdleTTLIsClosedAndReopenedLazily(t *testing.T) {
	h := newHarness(t, Options{IdleTTL: time.Minute})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "x")}
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	first := h.o.last(t, "tok-a")
	// Used again just before the TTL: kept.
	h.c.add(59 * time.Second)
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.c.add(59 * time.Second)
	h.m.Sweep()
	if first.isClosed() || h.m.Stats().Streams != 1 {
		t.Fatal("a stream read within its idle TTL was closed")
	}
	h.c.add(time.Second)
	h.m.Sweep()
	if h.m.Stats().Streams != 0 || h.closedFor(CloseIdle) != 1 {
		t.Fatalf("idle stream not closed: %+v, idle closes %d", h.m.Stats(), h.closedFor(CloseIdle))
	}
	eventually(t, "the idle stream's connection closed", first.isClosed)
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	if n := h.o.opened.Load(); n != 2 {
		t.Fatalf("opened %d, want the idle stream reopened on the next read (2)", n)
	}
}

func TestAStreamIsClosedAtItsMaxAgeEvenWhileRead(t *testing.T) {
	h := newHarness(t, Options{IdleTTL: time.Minute, MaxAge: 3 * time.Minute})
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		h.c.add(50 * time.Second)
		_, _ = read(t, h.m, "tok-a", schemaA)
		h.m.Sweep()
	}
	if h.m.Stats().Streams != 1 {
		t.Fatal("closed before its max age")
	}
	h.c.add(30 * time.Second)
	h.m.Sweep()
	if h.m.Stats().Streams != 0 || h.closedFor(CloseAge) != 1 {
		t.Fatalf("not closed at max age: %+v", h.m.Stats())
	}
	// Not a failure: the next read reopens at once, with no cooldown.
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
}

// A revoked grant reaches the stream as a Delete of each record it covered; the cache drops them.
func TestADeleteRemovesTheRecordFromTheCache(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-a"] = []registry.Entity{
		entity("urn:apps.civitai.com:todo-app/notes/r-keep", "KEEP"),
		entity("urn:apps.civitai.com:todo-app/notes/r-revoked", "REVOKED-CANARY"),
	}
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 2 {
		t.Fatalf("%q, %v", urns(got), err)
	}
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Delete,
		URN: "urn:apps.civitai.com:todo-app/notes/r-revoked", Cursor: "c2"}})
	eventually(t, "the deleted record to leave the cache", func() bool {
		got, _ := read(t, h.m, "tok-a", schemaA)
		return urns(got) == "urn:apps.civitai.com:todo-app/notes/r-keep"
	})
	// An upsert without a body is a delete too (the spec's Validity rule 2).
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Upsert,
		Entity: registry.Entity{URN: "urn:apps.civitai.com:todo-app/notes/r-keep"}}})
	eventually(t, "the bodiless upsert to empty the cache", func() bool {
		got, _ := read(t, h.m, "tok-a", schemaA)
		return len(got) == 0
	})
	if st := h.m.Stats(); st.Records != 0 || st.Bytes != 0 {
		t.Fatalf("cache accounting after deletes: %+v", st)
	}
}

// 🔴 The cap: a read over it opens nothing and answers ErrCapacity, so the caller reads REST.
func TestAReadOverTheStreamCapOpensNothing(t *testing.T) {
	h := newHarness(t, Options{MaxStreams: 2, MaxPerToken: 2})
	for _, tok := range []string{"tok-1", "tok-2"} {
		if _, err := read(t, h.m, tok, schemaA); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := read(t, h.m, "tok-3", schemaA); !errors.Is(err, ErrCapacity) {
		t.Fatalf("third stream: %v, want ErrCapacity", err)
	}
	if n := h.o.opens("tok-3"); n != 0 {
		t.Fatalf("a refused read opened %d streams", n)
	}
	// An open stream is still read at the cap.
	if _, err := read(t, h.m, "tok-1", schemaA); err != nil {
		t.Fatalf("an open stream at the cap: %v", err)
	}
	// A freed slot is taken again.
	h.c.add(2 * time.Minute)
	h.m.Sweep()
	if _, err := read(t, h.m, "tok-3", schemaA); err != nil {
		t.Fatalf("after the others idled out: %v", err)
	}
}

// 🔴 The per-token cap, below the process cap.
func TestAReadOverTheTokenCapOpensNothing(t *testing.T) {
	h := newHarness(t, Options{MaxStreams: 10, MaxPerToken: 1})
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	if _, err := read(t, h.m, "tok-a", schemaB); !errors.Is(err, ErrTokenCapacity) {
		t.Fatalf("second schema for one token: %v, want ErrTokenCapacity", err)
	}
	if n := h.o.opens("tok-a"); n != 1 {
		t.Fatalf("opened %d streams for tok-a, want 1", n)
	}
	// Another token is not held to tok-a's count.
	if _, err := read(t, h.m, "tok-b", schemaB); err != nil {
		t.Fatalf("another token: %v", err)
	}
}

// The deadline: a stream that has not sent Live gives the read up at its context's deadline, and
// later reads do not wait on it again (a snapshot that is slow to finish).
func TestAStreamShortOfLiveGivesUpAtTheDeadlineAndThenStopsMakingReadsWait(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.noLive["tok-a"] = true
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "x")}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	start := time.Now()
	_, err := h.m.Read(ctx, "tok-a", schemaA)
	cancel()
	if !errors.Is(err, ErrNotLive) {
		t.Fatalf("got %v, want ErrNotLive", err)
	}
	if took := time.Since(start); took < 25*time.Millisecond {
		t.Fatalf("gave up after %v, before its deadline", took)
	}
	// Stalled: the next read answers at once instead of waiting out its own (long) deadline.
	ctx, cancel = context.WithTimeout(context.Background(), time.Hour)
	_, err = h.m.Read(ctx, "tok-a", schemaA)
	cancel()
	if !errors.Is(err, ErrStalled) {
		t.Fatalf("got %v, want ErrStalled", err)
	}
	// A stall is not use: it idles out.
	h.c.add(2 * time.Minute)
	h.m.Sweep()
	if h.closedFor(CloseIdle) != 1 {
		t.Fatal("a stalled stream was not closed at its idle TTL")
	}
}

func TestAStreamThatReachesLiveAfterAStallServesAgain(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.noLive["tok-a"] = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	_, _ = h.m.Read(ctx, "tok-a", schemaA)
	cancel()
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Upsert,
		Entity: entity("urn:apps.civitai.com:todo-app/notes/r-late", "late")}})
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live, Cursor: liveCursor}})
	eventually(t, "the late Live", func() bool {
		got, err := read(t, h.m, "tok-a", schemaA)
		return err == nil && len(got) == 1
	})
}

func TestAWaitingReadIsAnsweredByLive(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.noLive["tok-a"] = true
	done := make(chan error, 1)
	go func() {
		_, err := read(t, h.m, "tok-a", schemaA)
		done <- err
	}()
	eventually(t, "the stream to open", func() bool { return h.o.opened.Load() == 1 })
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live, Cursor: liveCursor}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestARefusedTokenEndsTheStreamAndCoolsTheKeyDown(t *testing.T) {
	h := newHarness(t, Options{Cooldown: 30 * time.Second})
	h.o.refuse["tok-a"] = &registry.Error{Code: registry.InvalidToken, Status: 401}
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("got %v, want ErrInvalidToken", err)
	}
	if h.closedFor(CloseInvalidToken) != 1 || h.m.Stats().Streams != 0 {
		t.Fatal("the refused stream was not closed")
	}
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) {
		t.Fatalf("got %v, want ErrCoolingDown", err)
	}
	if n := h.o.opens("tok-a"); n != 1 {
		t.Fatalf("reopened during the cooldown (%d opens)", n)
	}
	h.c.add(30 * time.Second)
	h.m.Sweep()
	h.o.mu.Lock()
	delete(h.o.refuse, "tok-a")
	h.o.mu.Unlock()
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatalf("after the cooldown: %v", err)
	}
}

func TestStreamEndings(t *testing.T) {
	cases := []struct {
		name   string
		push   []step
		reason string
	}{
		{"End", []step{{ev: registry.Event{Type: registry.End}}}, CloseEnd},
		{"an error event", []step{{err: &registry.Error{Code: registry.Unavailable}}}, CloseError},
		{"a revoked token mid-stream", []step{{err: &registry.Error{Code: registry.InvalidToken}}}, CloseInvalidToken},
		{"a malformed delete", []step{{ev: registry.Event{Type: registry.Malformed, Of: registry.Delete}}}, CloseMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, Options{})
			h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "x")}
			if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
				t.Fatal(err)
			}
			for _, st := range tc.push {
				h.o.last(t, "tok-a").push(t, st)
			}
			eventually(t, "the stream to end", func() bool { return h.closedFor(tc.reason) == 1 })
			// The cache went with it: nothing is served from an ended stream.
			if st := h.m.Stats(); st.Streams != 0 || st.Records != 0 {
				t.Fatalf("after %s: %+v", tc.name, st)
			}
			if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) {
				t.Fatalf("got %v, want ErrCoolingDown", err)
			}
		})
	}
}

func TestAReadWaitingOnAStreamThatEndsGetsItsError(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.noLive["tok-a"] = true
	done := make(chan error, 1)
	go func() {
		_, err := read(t, h.m, "tok-a", schemaA)
		done <- err
	}()
	eventually(t, "the stream to open", func() bool { return h.o.opened.Load() == 1 })
	h.o.last(t, "tok-a").push(t, step{err: &registry.Error{Code: registry.InvalidToken}})
	if err := <-done; !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("got %v", err)
	}
}

func TestAMalformedProgressIsIgnored(t *testing.T) {
	h := newHarness(t, Options{})
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Malformed, Of: registry.Progress}})
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: "p"}})
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Upsert,
		Entity: entity("urn:apps.civitai.com:todo-app/notes/r-after", "after")}})
	eventually(t, "the upsert after the malformed progress", func() bool {
		got, err := read(t, h.m, "tok-a", schemaA)
		return err == nil && len(got) == 1
	})
}

func TestAStreamThatOutgrowsItsBoundsIsClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts Options
	}{
		{"records", Options{MaxRecords: 2}},
		{"bytes", Options{MaxBytes: 250}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.opts)
			h.o.records["tok-a"] = []registry.Entity{
				entity("urn:apps.civitai.com:todo-app/notes/r-1", "one"),
				entity("urn:apps.civitai.com:todo-app/notes/r-2", "two"),
			}
			if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 2 {
				t.Fatalf("within bounds: %q, %v", urns(got), err)
			}
			// Replacing a record does not count it twice.
			h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Upsert,
				Entity: entity("urn:apps.civitai.com:todo-app/notes/r-2", "TWO")}})
			eventually(t, "the replacement", func() bool {
				got, _ := read(t, h.m, "tok-a", schemaA)
				return len(got) == 2 && strings.Contains(string(got[1].Body), "TWO")
			})
			h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Upsert,
				Entity: entity("urn:apps.civitai.com:todo-app/notes/r-3", "three")}})
			eventually(t, "the too-large close", func() bool { return h.closedFor(CloseTooLarge) == 1 })
		})
	}
}

func TestCloseEndsEveryStreamAndRefusesLaterReads(t *testing.T) {
	h := newHarness(t, Options{})
	for _, tok := range []string{"tok-1", "tok-2"} {
		if _, err := read(t, h.m, tok, schemaA); err != nil {
			t.Fatal(err)
		}
	}
	h.m.Close()
	if h.closedFor(CloseShutdown) != 2 {
		t.Fatalf("shutdown closes: %d", h.closedFor(CloseShutdown))
	}
	for _, tok := range []string{"tok-1", "tok-2"} {
		if !h.o.last(t, tok).isClosed() {
			t.Fatalf("%s's connection is still open", tok)
		}
	}
	if _, err := read(t, h.m, "tok-1", schemaA); !errors.Is(err, ErrClosed) {
		t.Fatalf("got %v", err)
	}
}

func TestRunSweepsAndClosesOnCancel(t *testing.T) {
	h := newHarness(t, Options{IdleTTL: time.Minute})
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.c.add(2 * time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.m.Run(ctx, time.Millisecond); close(done) }()
	eventually(t, "the sweep", func() bool { return h.closedFor(CloseIdle) == 1 })
	cancel()
	<-done
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrClosed) {
		t.Fatalf("got %v", err)
	}
}

// The stream is opened with the EXCHANGED token, never the user's own.
func TestAStreamIsOpenedWithTheExchangedTokenOnly(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "x")}
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 1 {
		t.Fatalf("%q, %v", urns(got), err)
	}
	h.o.mu.Lock()
	n, raw := h.o.exchanges["tok-a"], h.o.raw
	h.o.mu.Unlock()
	if n != 1 || raw != 0 {
		t.Fatalf("exchanges %d, raw tokens presented %d", n, raw)
	}
}

func TestAStreamIsClosedBeforeItsExchangedTokenExpiresAndReopenedWithANewExchange(t *testing.T) {
	h := newHarness(t, Options{IdleTTL: time.Hour, MaxAge: 2 * time.Hour, ExpiryMargin: 10 * time.Second})
	h.o.life = time.Minute
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	// The fake hub issues a minute; the stream closes 10 s before.
	h.c.add(49 * time.Second)
	h.m.Sweep()
	if h.m.Stats().Streams != 1 {
		t.Fatal("closed before its expiry margin")
	}
	h.c.add(time.Second)
	h.m.Sweep()
	if h.m.Stats().Streams != 0 || h.closedFor(CloseExpiry) != 1 {
		t.Fatalf("not closed at its expiry margin: %+v", h.m.Stats())
	}
	// Not a failure: the next read exchanges again at once.
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatalf("after expiry: %v", err)
	}
	h.o.mu.Lock()
	n := h.o.exchanges["tok-a"]
	h.o.mu.Unlock()
	if n != 2 {
		t.Fatalf("%d exchanges, want 2", n)
	}
}

func TestARefusedExchangeOpensNoStreamAndCoolsDown(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.refuseExchange["tok-a"] = fmt.Errorf("%w (HTTP 400, invalid_grant)", exchange.ErrRefused)
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
	if h.o.opened.Load() != 0 || h.closedFor(CloseRefused) != 1 {
		t.Fatal("a refused exchange subscribed")
	}
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) {
		t.Fatalf("got %v", err)
	}
	// A hub that cannot be reached is a failure, not a refusal.
	h.o.refuseExchange["tok-b"] = errors.New("exchange: token endpoint unreachable")
	if _, err := read(t, h.m, "tok-b", schemaA); !errors.Is(err, ErrFailed) {
		t.Fatalf("got %v, want ErrFailed", err)
	}
}

// A collection the private feed does not serve (a shared one, on the public feed) is out of
// contract: closed unread, and not reopened for the long cooldown.
func TestAStreamThatIsNotThePrivateFeedIsClosedUnread(t *testing.T) {
	h := newHarness(t, Options{NotPrivateCooldown: time.Hour, Cooldown: time.Second})
	h.o.noLive["tok-a"] = true
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/shared-key", "SHARED")}
	done := make(chan error, 1)
	go func() {
		_, err := read(t, h.m, "tok-a", schemaA)
		done <- err
	}()
	eventually(t, "the stream to open", func() bool { return h.o.opened.Load() == 1 })
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live, Cursor: publicCursor}})
	if err := <-done; !errors.Is(err, ErrNotPrivate) {
		t.Fatalf("got %v, want ErrNotPrivate", err)
	}
	h.c.add(time.Minute)
	h.m.Sweep()
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) {
		t.Fatalf("reopened a public-feed collection after %v: %v", time.Minute, err)
	}
	if h.closedFor(CloseNotPrivate) != 1 {
		t.Fatal("not counted")
	}
}

// The private-feed check reads the cursor in its real wire form: the adapter's `b1.` wrapping,
// unwrapped by exactly its grammar, around the private feed's `p1.`.
func TestPrivateFeedCursorReadsTheAdaptersWireForm(t *testing.T) {
	for cursor, want := range map[string]bool{
		"b1.0a1b2c3d4e5f60718293a4b5.p1.empty":                            true,
		"b1.ffffffffffffffffffffffff.p1.0123456789abcdef0123456789abcdef": true,
		// The public document feed (doc-feed.ts), and the other entity feeds.
		"b1.0a1b2c3d4e5f60718293a4b5.f1.0123456789abcdef0123456789abcdef": false,
		"b1.0a1b2c3d4e5f60718293a4b5.c1.0123456789abcdef0123456789abcdef": false,
		// Unwrapped, or wrapped wrongly: not the adapter's grammar, so not private.
		"p1.empty":                              false,
		"p1.0123456789abcdef0123456789abcdef":   false,
		"b1.0a1b2c3d4e5f60718293a4b.p1.empty":   false, // 23 hex
		"b1.0A1B2C3D4E5F60718293A4B5.p1.empty":  false, // upper-case hex
		"b2.0a1b2c3d4e5f60718293a4b5.p1.empty":  false,
		"b1.0a1b2c3d4e5f60718293a4b5.":          false,
		"b1.0a1b2c3d4e5f60718293a4b5.xp1.empty": false,
		"":                                      false,
	} {
		if got := PrivateFeedCursor(cursor); got != want {
			t.Errorf("PrivateFeedCursor(%q) = %v, want %v", cursor, got, want)
		}
	}
}

// A stream whose Live carries the private feed's cursor in its real wire form serves; one whose Live
// carries a bare `p1.` cursor, which the adapter never sends, does not.
func TestAStreamWhoseLiveIsThePrivateFeedInItsWireFormServes(t *testing.T) {
	for _, tc := range []struct {
		cursor string
		serves bool
	}{
		{"b1.0a1b2c3d4e5f60718293a4b5.p1.0123456789abcdef0123456789abcdef", true},
		{"p1.0123456789abcdef0123456789abcdef", false},
		{publicCursor, false},
	} {
		t.Run(tc.cursor, func(t *testing.T) {
			h := newHarness(t, Options{})
			h.o.noLive["tok-a"] = true
			h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "PRIVATE-1")}
			done := make(chan error, 1)
			var got []registry.Entity
			go func() {
				var err error
				got, err = read(t, h.m, "tok-a", schemaA)
				done <- err
			}()
			eventually(t, "the stream to open", func() bool { return h.o.opened.Load() == 1 })
			h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live, Cursor: tc.cursor}})
			err := <-done
			if tc.serves && (err != nil || len(got) != 1) {
				t.Fatalf("the private feed's wire-form Live did not serve: %q, %v", urns(got), err)
			}
			if !tc.serves && !errors.Is(err, ErrNotPrivate) {
				t.Fatalf("got %q, %v; want ErrNotPrivate", urns(got), err)
			}
		})
	}
}

// A revoked user token: the exchanged token outlives it, so a read re-checks the user's token once
// the last check is Recheck old. Fixture times overshoot the 2-minute boundary on both sides.
func TestARevokedUserTokenStopsBeingServedWithinTheRecheckInterval(t *testing.T) {
	h := newHarness(t, Options{Recheck: 2 * time.Minute, IdleTTL: time.Hour, MaxAge: time.Hour})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "CACHED-CANARY")}
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 1 {
		t.Fatalf("%q, %v", urns(got), err)
	}
	h.o.mu.Lock()
	h.o.refuseExchange["tok-a"] = fmt.Errorf("%w (HTTP 400, invalid_grant)", exchange.ErrRefused)
	h.o.mu.Unlock()

	// 1m30s after the last check: still cached, no check made.
	h.c.add(90 * time.Second)
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 1 {
		t.Fatalf("within the interval: %q, %v", urns(got), err)
	}
	if n := h.exchangesA(); n != 1 {
		t.Fatalf("%d exchanges within the interval, want 1", n)
	}
	// 2m30s after it: the read re-checks, the hub refuses, nothing cached is served.
	h.c.add(60 * time.Second)
	got, err := read(t, h.m, "tok-a", schemaA)
	if !errors.Is(err, ErrRefused) || len(got) != 0 {
		t.Fatalf("after the interval: %q, %v; want ErrRefused and no records", urns(got), err)
	}
	if st := h.m.Stats(); st.Streams != 0 || st.Records != 0 || h.closedFor(CloseRevoked) != 1 {
		t.Fatalf("the revoked stream's cache survived: %+v", st)
	}
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) {
		t.Fatalf("got %v", err)
	}
}

// A check that FAILS (the hub unreachable) is not a revocation: the stream keeps serving, and the
// next check waits another interval rather than hammering the hub on every read.
func TestAFailedRecheckKeepsServingUntilTheNextCheck(t *testing.T) {
	h := newHarness(t, Options{Recheck: 2 * time.Minute, IdleTTL: time.Hour, MaxAge: time.Hour})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "x")}
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.o.mu.Lock()
	h.o.refuseExchange["tok-a"] = errors.New("exchange: token endpoint answered HTTP 503 (none)")
	h.o.mu.Unlock()
	h.c.add(150 * time.Second)
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 1 {
		t.Fatalf("a failed check stopped serving: %q, %v", urns(got), err)
	}
	h.c.add(90 * time.Second)
	if got, err := read(t, h.m, "tok-a", schemaA); err != nil || len(got) != 1 {
		t.Fatalf("%q, %v", urns(got), err)
	}
	if n := h.exchangesA(); n != 2 {
		t.Fatalf("%d exchanges, want 2 (the open and one failed check)", n)
	}
	h.c.add(60 * time.Second)
	_, _ = read(t, h.m, "tok-a", schemaA)
	if n := h.exchangesA(); n != 3 {
		t.Fatalf("%d exchanges, want 3 (the next check, an interval later)", n)
	}
}

// No read, no check: re-checking runs on the read path only.
func TestNoReadMeansNoRecheck(t *testing.T) {
	h := newHarness(t, Options{Recheck: 2 * time.Minute, IdleTTL: time.Hour, MaxAge: time.Hour})
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.c.add(10 * time.Minute)
	h.m.Sweep()
	if n := h.exchangesA(); n != 1 {
		t.Fatalf("%d exchanges without a read, want 1", n)
	}
}

// 🔴 A block token (APP_DATA_BLOCK_EXCHANGE on) is exchanged ONCE, as main wires it (exchange.Route
// with a BlockCache): the hub refuses a second exchange of it. Its streams of two collections share
// that one exchange; a live stream's re-check reuses it rather than re-exchanging (a re-exchange
// would be refused as a replay and close the stream as revoked); and once its token is past the
// expiry margin, the next read is not exchanged again: it fails, and the caller reads REST.
// Fixture: the hub issues 5 minutes, re-check every 2, margin 10 s.
func TestABlockTokensStreamsShareOneExchangeAndNeverReExchange(t *testing.T) {
	h := newHarness(t, Options{Recheck: 2 * time.Minute, IdleTTL: time.Hour, MaxAge: time.Hour, ExpiryMargin: 10 * time.Second})
	h.o.life = 5 * time.Minute
	const block = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJibGstMSJ9.c2ln"
	h.m.opts.Exchange = exchange.Route(h.o.Exchange, &exchange.BlockCache{Hub: h.o.Exchange, Margin: 10 * time.Second, Now: h.c.now})
	h.o.records[block] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-1", "BLOCK-CANARY")}
	exchanges := func() int {
		h.o.mu.Lock()
		defer h.o.mu.Unlock()
		return h.o.exchanges[block]
	}
	for _, schema := range []string{schemaA, schemaB} {
		if got, err := read(t, h.m, block, schema); err != nil || len(got) != 1 {
			t.Fatalf("%s: %q, %v", schema, urns(got), err)
		}
	}
	if n := exchanges(); n != 1 || h.o.opens(block) != 2 {
		t.Fatalf("%d exchanges for 2 streams (%d opened), want 1", n, h.o.opens(block))
	}
	// Past the re-check interval: the read is still served, from the one exchange.
	h.c.add(150 * time.Second)
	if got, err := read(t, h.m, block, schemaA); err != nil || len(got) != 1 {
		t.Fatalf("after a re-check: %q, %v", urns(got), err)
	}
	if n := exchanges(); n != 1 || h.closedFor(CloseRevoked) != 0 {
		t.Fatalf("%d exchanges, %d closed as revoked; want 1 and 0", n, h.closedFor(CloseRevoked))
	}
	// Past the expiry margin (4m50s; at 4m55s) both streams close; the next read is not exchanged again.
	h.c.add(145 * time.Second)
	h.m.Sweep()
	if st := h.m.Stats(); st.Streams != 0 || h.closedFor(CloseExpiry) != 2 {
		t.Fatalf("not closed at the expiry margin: %+v", st)
	}
	if _, err := read(t, h.m, block, schemaA); !errors.Is(err, ErrFailed) {
		t.Fatalf("after expiry: %v, want ErrFailed (the read goes to REST)", err)
	}
	if n := exchanges(); n != 1 {
		t.Fatalf("%d exchanges, want 1: a spent block token was exchanged again", n)
	}
}
