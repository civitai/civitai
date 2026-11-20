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
}

func newOrigin() *fakeOrigin {
	return &fakeOrigin{records: map[string][]registry.Entity{}, noLive: map[string]bool{},
		refuse: map[string]error{}, byToken: map[string]int{}}
}

func (o *fakeOrigin) Subscribe(_ context.Context, schema, token string) (Stream, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.opened.Add(1)
	o.byToken[token]++
	if err := o.refuse[token]; err != nil {
		return nil, err
	}
	s := &fakeStream{token: token, schema: schema, events: make(chan step, 64), closed: make(chan struct{})}
	for _, e := range o.records[token] {
		s.events <- step{ev: registry.Event{Type: registry.Upsert, Entity: e}}
	}
	if !o.noLive[token] {
		s.events <- step{ev: registry.Event{Type: registry.Live, Cursor: "c"}}
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
	t.Cleanup(h.m.Close)
	return h
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
// later reads do not wait on it again (a relay stuck short of Live, civitai-registry#50).
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
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live}})
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
	h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.Live}})
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
