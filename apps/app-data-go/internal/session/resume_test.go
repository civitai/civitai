package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// The cursors of these tests, in the adapter's wire form: the private feed's, bound.
const (
	cursorC0 = "b1.0a1b2c3d4e5f60718293a4b5.p1.00000000000000000000000000000000"
	cursorC1 = "b1.0a1b2c3d4e5f60718293a4b5.p1.11111111111111111111111111111111"
	cursorC2 = "b1.0a1b2c3d4e5f60718293a4b5.p1.22222222222222222222222222222222"
	// cursorB is a cursor the adapter issued to tok-b's subject.
	cursorB = "b1.0b0b0b0b0b0b0b0b0b0b0b0b.p1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// resumer is the fake origin, resuming too (ResumeSubscriber), as the adapter does: a cursor is
// resumed only for the token it was issued to (cursorsOf), else `cursor_expired` before the stream
// starts. A resume's Live names `sync: pending` when the request asked (and noSync is off); the test
// pushes the first poll's changes and the sync itself.
type resumer struct {
	*fakeOrigin
	mu        sync.Mutex
	cursorsOf map[string][]string // token → the cursors issued to it
	noSync    bool                // an adapter before the sync: its resumed Live names none
	liveOf    map[string]string   // token → the cursor a resumed Live carries, when not the request's
	resumes   []string            // "token@cursor", each resume asked for
	metas     []string
}

func newResumer() *resumer {
	return &resumer{fakeOrigin: newOrigin(), cursorsOf: map[string][]string{}, liveOf: map[string]string{}}
}

func (r *resumer) SubscribeFrom(ctx context.Context, schema, presented string, meta json.RawMessage, cursor string) (Stream, error) {
	if cursor == "" {
		return r.SubscribeMeta(ctx, schema, presented, meta)
	}
	token, ok := strings.CutPrefix(presented, "x.")
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resumes = append(r.resumes, token+"@"+cursor)
	r.metas = append(r.metas, string(meta))
	if !ok {
		r.fakeOrigin.mu.Lock()
		r.raw++
		r.fakeOrigin.mu.Unlock()
		return nil, &registry.Error{Code: registry.InvalidToken}
	}
	if !slices.Contains(r.cursorsOf[token], cursor) {
		return nil, &registry.Error{Code: registry.CursorExpired, Status: 410, Message: "the cursor was issued to another token subject"}
	}
	r.opened.Add(1)
	s := &fakeStream{token: token, schema: schema, events: make(chan step, 64), closed: make(chan struct{})}
	live := registry.Event{Type: registry.Live, Cursor: cursor}
	if c, ok := r.liveOf[token]; ok {
		live.Cursor = c
	}
	if !r.noSync && string(meta) == `{"sync":1}` {
		live.Meta = json.RawMessage(`{"head":{"seq":40},"sync":"pending"}`)
	}
	s.events <- step{ev: live}
	r.fakeOrigin.mu.Lock()
	r.streams = append(r.streams, s)
	r.fakeOrigin.mu.Unlock()
	return s, nil
}

func (r *resumer) resumed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.resumes)
}

// memSnapshots is Snapshots in memory, recording each ttl; answerAll answers every key with it (a
// broken store that hands one key's snapshot to another).
type memSnapshots struct {
	mu        sync.Mutex
	saved     map[SnapshotKey]Saved
	ttls      map[SnapshotKey]time.Duration
	drops     int
	answerAll *Saved
}

func newMemSnapshots() *memSnapshots {
	return &memSnapshots{saved: map[SnapshotKey]Saved{}, ttls: map[SnapshotKey]time.Duration{}}
}

func (s *memSnapshots) Load(_ context.Context, k SnapshotKey) (Saved, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.answerAll != nil {
		return *s.answerAll, true
	}
	v, ok := s.saved[k]
	return v, ok
}

func (s *memSnapshots) Save(_ context.Context, k SnapshotKey, v Saved, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saved[k], s.ttls[k] = v, ttl
}

func (s *memSnapshots) Drop(_ context.Context, k SnapshotKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.saved, k)
	s.drops++
}

// of is tok-a's snapshot, its ttl, and whether there is one.
func (s *memSnapshots) of() (Saved, time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := SnapshotKey{Token: sha256.Sum256([]byte("tok-a")), Schema: schemaA}
	v, ok := s.saved[k]
	return v, s.ttls[k], ok
}

// put saves v as tok-a's snapshot.
func (s *memSnapshots) put(v Saved) {
	s.Save(context.Background(), SnapshotKey{Token: sha256.Sum256([]byte("tok-a")), Schema: schemaA}, v, time.Minute)
}

// memOverlays is OverlayStore in memory.
type memOverlays struct {
	mu    sync.Mutex
	held  map[string][]SavedOverlay
	drops int
}

func (o *memOverlays) id(token [sha256.Size]byte, schema string) string {
	return string(token[:]) + schema
}

func (o *memOverlays) Load(_ context.Context, token [sha256.Size]byte, schema string) []SavedOverlay {
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Clone(o.held[o.id(token, schema)])
}

func (o *memOverlays) Save(token [sha256.Size]byte, schema string, s SavedOverlay) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.held == nil {
		o.held = map[string][]SavedOverlay{}
	}
	o.held[o.id(token, schema)] = append(o.held[o.id(token, schema)], s)
}

func (o *memOverlays) Drop(_ context.Context, token [sha256.Size]byte, schema string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.held, o.id(token, schema))
	o.drops++
}

// cacheRig is a manager over a resumer, with snapshots; restart builds another over the same origin,
// snapshots and clock, as a restarted process would.
type cacheRig struct {
	t        *testing.T
	o        *resumer
	snaps    *memSnapshots
	overlays *memOverlays
	c        *clock
	m        *Manager
	opts     Options
	resumes  sync.Map // outcome → *atomic.Int32
	forgot   atomic.Int32
	fresh    atomic.Int32
}

func newCacheRig(t *testing.T, opts Options) *cacheRig {
	t.Helper()
	r := &cacheRig{t: t, o: newResumer(), snaps: newMemSnapshots(), overlays: &memOverlays{}, c: &clock{t: time.Unix(1_700_000_000, 0)}}
	r.o.now = r.c.now
	if opts.Exchange == nil {
		opts.Exchange = r.o.Exchange
	}
	if opts.ExchangeFresh == nil {
		opts.ExchangeFresh = func(ctx context.Context, subject string) (exchange.Token, error) {
			r.fresh.Add(1)
			return r.o.Exchange(ctx, subject)
		}
	}
	opts.Snapshots = r.snaps
	opts.Forget = func([sha256.Size]byte) { r.forgot.Add(1) }
	opts.Resumed = func(outcome string) {
		n, _ := r.resumes.LoadOrStore(outcome, &atomic.Int32{})
		n.(*atomic.Int32).Add(1)
	}
	opts.ExpiryMargin = 10 * time.Second
	opts.NotPrivateCooldown = time.Hour
	opts.MaxStreams, opts.MaxPerToken = 10, 4
	if opts.IdleTTL == 0 {
		opts.IdleTTL = time.Minute
	}
	opts.MaxAge = time.Hour
	if opts.MaxRecords == 0 {
		opts.MaxRecords = 100
	}
	opts.MaxBytes, opts.Cooldown, opts.Now = 1<<20, 30*time.Second, r.c.now
	r.opts = opts
	r.m = New(r.o, opts)
	t.Cleanup(func() {
		r.m.Close()
		if r.o.raw != 0 {
			t.Errorf("🔴 %d subscriptions presented a token the hub did not issue", r.o.raw)
		}
	})
	return r
}

// restart closes the manager (a shutdown, which saves) and opens another as a new process would.
func (r *cacheRig) restart() {
	r.m.Close()
	r.m = New(r.o, r.opts)
	r.t.Cleanup(r.m.Close)
}

func (r *cacheRig) resumeCount(outcome string) int32 {
	n, ok := r.resumes.Load(outcome)
	if !ok {
		return 0
	}
	return n.(*atomic.Int32).Load()
}

func note(urn, key string, seq int64) registry.Entity {
	body, _ := json.Marshal(map[string]string{"text": "canary-" + key})
	return registry.Entity{URN: urn, Key: key, Seq: seq, Rev: "r", Schemas: []string{schemaA}, Body: body}
}

var (
	r1 = note("urn:apps.civitai.com:todo-app/notes/r1", "k1", 11)
	r2 = note("urn:apps.civitai.com:todo-app/notes/r2", "k2", 12)
	r3 = note("urn:apps.civitai.com:todo-app/notes/r3", "k3", 13)
)

// readWithin is a read that waits at most d.
func readWithin(m *Manager, token string, d time.Duration) ([]registry.Entity, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return m.ReadAt(ctx, token, schemaA, 0)
}

// liveA opens tok-a's stream at cursorC0 holding r1 and r2, its cursors known to the origin.
func (r *cacheRig) liveA() *fakeStream {
	r.t.Helper()
	r.o.records["tok-a"] = []registry.Entity{r1, r2}
	r.o.cursors["tok-a"] = cursorC0
	r.o.cursorsOf["tok-a"] = []string{cursorC0, cursorC1, cursorC2}
	if got, err := read(r.t, r.m, "tok-a", schemaA); err != nil || urns(got) != r1.URN+","+r2.URN {
		r.t.Fatalf("live: %q %v", urns(got), err)
	}
	return r.o.last(r.t, "tok-a")
}

// 🔴 THE CONSISTENT CURSOR: a snapshot is saved only where the adapter said the records are complete,
// never part-way through a batch.
func TestASnapshotIsSavedOnlyAtAConsistentCursor(t *testing.T) {
	r := newCacheRig(t, Options{})
	st := r.liveA()
	r.m.Sweep()
	saved, _, ok := r.snaps.of()
	if !ok || saved.Cursor != cursorC0 || len(saved.Records) != 2 {
		t.Fatalf("at Live: %+v %v", saved, ok)
	}
	// A batch: its first event carries the cursor held (C0), its last the poll's new one (C1).
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: r1.URN, Cursor: cursorC0}})
	eventually(t, "the delete", func() bool { got, _ := read(t, r.m, "tok-a", schemaA); return urns(got) == r2.URN })
	r.m.Sweep()
	if saved, _, _ := r.snaps.of(); saved.Cursor != cursorC0 || len(saved.Records) != 2 {
		t.Fatalf("🔴 saved part-way through a batch: %+v", saved)
	}
	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: r3, Cursor: cursorC1}})
	eventually(t, "the upsert", func() bool { got, _ := read(t, r.m, "tok-a", schemaA); return strings.Contains(urns(got), r3.URN) })
	r.m.Sweep()
	saved, _, _ = r.snaps.of()
	if saved.Cursor != cursorC1 || len(saved.Records) != 2 {
		t.Fatalf("at the batch's end: %+v", saved)
	}
	// Unchanged since: not saved again.
	r.snaps.put(Saved{Cursor: "sentinel"})
	r.m.Sweep()
	if saved, _, _ := r.snaps.of(); saved.Cursor != "sentinel" {
		t.Fatal("an unchanged stream was saved again")
	}
	// A Progress completes a batch too.
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: r3.URN, Cursor: cursorC1}})
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: cursorC2}})
	eventually(t, "the progress", func() bool {
		r.m.Sweep()
		saved, _, _ := r.snaps.of()
		return saved.Cursor == cursorC2 && len(saved.Records) == 1
	})
}

// 🔴 RESUME: after a restart the stream resumes from the saved cursor, and is answered only once the
// adapter's first poll is in, so the Delete it missed while down is applied before any read.
func TestAResumedStreamDeliversTheMissedDeleteBeforeItIsRead(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.restart() // the shutdown saves the snapshot (cursorC0, r1 and r2)
	if saved, _, ok := r.snaps.of(); !ok || saved.Cursor != cursorC0 {
		t.Fatalf("not saved at shutdown: %+v", saved)
	}
	type answer struct {
		ents []registry.Entity
		err  error
	}
	done := make(chan answer, 1)
	go func() {
		ents, err := readWithin(r.m, "tok-a", 2*time.Second)
		done <- answer{ents, err}
	}()
	eventually(t, "the resume", func() bool { return len(r.o.resumed()) == 1 })
	if got := r.o.resumed()[0]; got != "tok-a@"+cursorC0 {
		t.Fatalf("resumed %s", got)
	}
	r.o.mu.Lock()
	meta := r.o.metas[0]
	r.o.mu.Unlock()
	if meta != `{"sync":1}` {
		t.Fatalf("the resume asked %s", meta)
	}
	st := r.o.last(t, "tok-a")
	// Live has arrived; the read must still wait for the sync.
	select {
	case a := <-done:
		t.Fatalf("🔴 answered at the resumed Live, before the first poll: %q %v", urns(a.ents), a.err)
	case <-time.After(50 * time.Millisecond):
	}
	// The first poll: r1 was deleted while the process was down.
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: r1.URN, Cursor: cursorC1}})
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: cursorC1, Meta: json.RawMessage(`{"head":{"seq":41},"sync":"done"}`)}})
	a := <-done
	if a.err != nil || urns(a.ents) != r2.URN {
		t.Fatalf("🔴 after the sync: %q %v (r1 was deleted while down)", urns(a.ents), a.err)
	}
	if r.resumeCount(ResumeSynced) != 1 || r.o.opens("tok-a") != 1 {
		t.Fatalf("synced %d, fresh opens %d", r.resumeCount(ResumeSynced), r.o.opens("tok-a"))
	}
}

// 🔴 A stale cursor (the adapter no longer holds its state, or it expired): the snapshot is dropped and
// the stream starts over from a full snapshot.
func TestAStaleCursorStartsOverFromAFreshSnapshot(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.restart()
	r.o.cursorsOf["tok-a"] = nil // the adapter's state for every cursor is gone
	r.o.records["tok-a"] = []registry.Entity{r3}
	got, err := read(t, r.m, "tok-a", schemaA)
	if err != nil || urns(got) != r3.URN {
		t.Fatalf("%q %v", urns(got), err)
	}
	if r.resumeCount(ResumeCursorRefused) != 1 || r.o.opens("tok-a") != 2 {
		t.Fatalf("refused %d, fresh opens %d", r.resumeCount(ResumeCursorRefused), r.o.opens("tok-a"))
	}
}

// 🔴 A cursor issued to another token is refused by the adapter, so even a store that answered the
// wrong token's snapshot never serves it: the stream starts over, and tok-b sees only its own.
func TestACursorForAnotherTokenIsRefusedAndNeverServed(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.snaps.answerAll = &Saved{Cursor: cursorB, Records: []registry.Entity{note("urn:apps.civitai.com:todo-app/notes/rb", "kb", 5)}}
	r.o.cursorsOf["tok-b"] = []string{cursorB}
	r.o.records["tok-a"] = []registry.Entity{r1}
	got, err := read(t, r.m, "tok-a", schemaA)
	if err != nil || urns(got) != r1.URN {
		t.Fatalf("🔴 tok-a read %q %v", urns(got), err)
	}
	if r.resumeCount(ResumeCursorRefused) != 1 {
		t.Fatal("the other token's cursor was not refused")
	}
}

// An adapter before the sync: its resumed Live promises none, so the snapshot could be answered before
// the Deletes it missed. The stream starts over.
func TestAnAdapterWithoutTheSyncStartsOver(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.restart()
	r.o.noSync = true
	r.o.records["tok-a"] = []registry.Entity{r2}
	got, err := read(t, r.m, "tok-a", schemaA)
	if err != nil || urns(got) != r2.URN {
		t.Fatalf("%q %v", urns(got), err)
	}
	if r.resumeCount(ResumeUnsupported) != 1 {
		t.Fatal("not counted unsupported")
	}
}

// A refused cursor after the resumed Live (the first poll found the seqs went back): start over too.
func TestACursorRefusedBeforeTheSyncStartsOver(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.restart()
	r.o.records["tok-a"] = []registry.Entity{r3}
	done := make(chan []registry.Entity, 1)
	go func() { got, _ := readWithin(r.m, "tok-a", 2*time.Second); done <- got }()
	eventually(t, "the resume", func() bool { return len(r.o.resumed()) == 1 })
	r.o.last(t, "tok-a").push(t, step{err: &registry.Error{Code: registry.CursorExpired}})
	if got := <-done; urns(got) != r3.URN {
		t.Fatalf("%q", urns(got))
	}
}

// 🔴 The private-feed cursor check applies to a resume: a snapshot whose cursor is not the private
// feed's is never resumed, and a resumed Live that is not the private feed's is closed unread.
func TestThePrivateCursorCheckAppliesToAResume(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.snaps.put(Saved{Cursor: publicCursor, Records: []registry.Entity{r1}})
	r.o.records["tok-a"] = []registry.Entity{r2}
	if got, err := read(t, r.m, "tok-a", schemaA); err != nil || urns(got) != r2.URN {
		t.Fatalf("%q %v", urns(got), err)
	}
	if r.resumeCount(ResumeDiscarded) != 1 || len(r.o.resumed()) != 0 {
		t.Fatal("a public cursor was resumed")
	}
	rb := newCacheRig(t, Options{})
	rb.snaps.put(Saved{Cursor: cursorC0, Records: []registry.Entity{r1}})
	rb.o.cursorsOf["tok-a"] = []string{cursorC0}
	rb.o.liveOf["tok-a"] = publicCursor
	if _, err := read(t, rb.m, "tok-a", schemaA); !errors.Is(err, ErrNotPrivate) {
		t.Fatalf("🔴 a resumed public Live: %v", err)
	}
	if _, _, ok := rb.snaps.of(); ok {
		t.Fatal("the snapshot of a stream closed not_private was kept")
	}
}

func TestASnapshotPastTheBoundsOrWithDuplicatesIsDiscarded(t *testing.T) {
	for name, recs := range map[string][]registry.Entity{
		"over MaxRecords": {r1, r2, r3},
		"a duplicate URN": {r1, r1},
		"an empty URN":    {{Key: "k"}},
	} {
		t.Run(name, func(t *testing.T) {
			r := newCacheRig(t, Options{MaxRecords: 2})
			r.snaps.put(Saved{Cursor: cursorC0, Records: recs})
			r.o.records["tok-a"] = []registry.Entity{r1}
			if got, err := read(t, r.m, "tok-a", schemaA); err != nil || urns(got) != r1.URN {
				t.Fatalf("%q %v", urns(got), err)
			}
			if r.resumeCount(ResumeDiscarded) != 1 {
				t.Fatal("not discarded")
			}
		})
	}
}

// 🔴 REVOCATION: a token the hub refuses on a resume opens nothing, serves nothing, and drops the
// snapshot and its cached exchange.
func TestARefusedTokenOnResumeServesNothingAndDropsTheCache(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.restart()
	r.o.refuseExchange["tok-a"] = exchange.ErrRefused
	if got, err := read(t, r.m, "tok-a", schemaA); !errors.Is(err, ErrRefused) || len(got) != 0 {
		t.Fatalf("🔴 %q %v", urns(got), err)
	}
	if _, _, ok := r.snaps.of(); ok || r.forgot.Load() != 1 {
		t.Fatalf("snapshot kept %v, forgot %d", ok, r.forgot.Load())
	}
	if len(r.o.resumed()) != 0 {
		t.Fatal("a refused token resumed")
	}
}

// 🔴 REVOCATION: a resumed stream whose exchange came from a cache is re-checked within the window a
// live stream is (2 minutes after the hub last checked the token, not after the resume), and a
// refusal there drops it all.
func TestAResumedStreamIsRecheckedFromTheHubsLastCheck(t *testing.T) {
	var checked time.Time
	r := newCacheRig(t, Options{Recheck: 2 * time.Minute})
	r.opts.Exchange = func(ctx context.Context, subject string) (exchange.Token, error) {
		tok, err := r.o.Exchange(ctx, subject)
		tok.Checked = checked
		return tok, err
	}
	r.liveA()
	r.restart()
	// The cached exchange was checked 1m50s ago.
	checked = r.c.now().Add(-110 * time.Second)
	done := make(chan error, 1)
	go func() { _, err := readWithin(r.m, "tok-a", 2*time.Second); done <- err }()
	eventually(t, "the resume", func() bool { return len(r.o.resumed()) == 1 })
	st := r.o.last(t, "tok-a")
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: cursorC0, Meta: json.RawMessage(`{"sync":"done"}`)}})
	if err := <-done; err != nil || r.fresh.Load() != 0 {
		t.Fatalf("inside the window: %v, rechecks %d", err, r.fresh.Load())
	}
	// 10s later the hub's check is 2 minutes old: the next read asks the hub, which refuses.
	r.c.add(10 * time.Second)
	r.o.refuseExchange["tok-a"] = exchange.ErrRefused
	if got, err := read(t, r.m, "tok-a", schemaA); !errors.Is(err, ErrRefused) || len(got) != 0 || r.fresh.Load() != 1 {
		t.Fatalf("🔴 past the window: %q %v (rechecks %d)", urns(got), err, r.fresh.Load())
	}
	if _, _, ok := r.snaps.of(); ok || r.forgot.Load() != 1 {
		t.Fatal("a revoked stream's snapshot or exchange was kept")
	}
}

// A cached exchange checked longer ago than the window is re-checked before the first read is
// answered.
func TestAStaleCheckIsRecheckedBeforeTheFirstRead(t *testing.T) {
	var rechecks atomic.Int32
	r := newCacheRig(t, Options{Recheck: 2 * time.Minute,
		// The hub refuses the token now; only a re-check asks it.
		ExchangeFresh: func(context.Context, string) (exchange.Token, error) {
			rechecks.Add(1)
			return exchange.Token{}, exchange.ErrRefused
		}})
	r.m.Close()
	r.opts.Exchange = func(ctx context.Context, subject string) (exchange.Token, error) {
		tok, err := r.o.Exchange(ctx, subject)
		tok.Checked = r.c.now().Add(-3 * time.Minute)
		return tok, err
	}
	r.m = New(r.o, r.opts)
	r.o.records["tok-a"] = []registry.Entity{r1}
	if got, err := read(t, r.m, "tok-a", schemaA); !errors.Is(err, ErrRefused) || len(got) != 0 || rechecks.Load() != 1 {
		t.Fatalf("🔴 a stale check was served: %q %v (rechecks %d)", urns(got), err, rechecks.Load())
	}
}

// A snapshot lives at most the idle TTL, and never past its exchanged token's expiry.
func TestASnapshotsTimeToLiveIsTheIdleTTLCappedAtTheTokensExpiry(t *testing.T) {
	r := newCacheRig(t, Options{IdleTTL: 5 * time.Minute})
	r.o.life = 3 * time.Minute
	r.liveA()
	r.m.Sweep()
	if _, ttl, _ := r.snaps.of(); ttl != 3*time.Minute {
		t.Fatalf("ttl %s, want the token's 3m", ttl)
	}
	rb := newCacheRig(t, Options{IdleTTL: 5 * time.Minute})
	rb.liveA()
	rb.m.Sweep()
	if _, ttl, _ := rb.snaps.of(); ttl != 5*time.Minute {
		t.Fatalf("ttl %s, want the idle TTL", ttl)
	}
}

// An idle close saves; an end that refused the data drops; a classified exchange failure drops.
func TestWhatAStreamsEndDoesToItsSnapshot(t *testing.T) {
	r := newCacheRig(t, Options{})
	r.liveA()
	r.snaps.put(Saved{Cursor: "sentinel"})
	r.c.add(2 * time.Minute)
	r.m.Sweep() // idle: saved as of its close
	if saved, _, _ := r.snaps.of(); saved.Cursor != cursorC0 {
		t.Fatalf("idle close: %+v", saved)
	}
	// An end: dropped.
	rb := newCacheRig(t, Options{})
	st := rb.liveA()
	rb.m.Sweep()
	if _, _, ok := rb.snaps.of(); !ok {
		t.Fatal("not saved")
	}
	st.push(t, step{ev: registry.Event{Type: registry.End}})
	eventually(t, "the end", func() bool { _, _, ok := rb.snaps.of(); return !ok })
	rc := newCacheRig(t, Options{ClassifyExchange: func(err error) *ExchangeFailure {
		return &ExchangeFailure{Reason: "throttled", Err: err}
	}})
	rc.snaps.put(Saved{Cursor: cursorC0})
	rc.o.refuseExchange["tok-a"] = errors.New("throttled here")
	if _, err := read(t, rc.m, "tok-a", schemaA); err == nil {
		t.Fatal("no error")
	}
	eventually(t, "the drop", func() bool { _, _, ok := rc.snaps.of(); return !ok })
}

// A stream reopened for a floor is a fresh snapshot, never a resume.
func TestAFloorReopenNeverResumes(t *testing.T) {
	r := newCacheRig(t, Options{OverlayTTL: time.Minute, ReopenEvery: time.Minute})
	r.o.heads["tok-a"] = 5
	r.liveA()
	r.m.Sweep()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _ = r.m.ReadAt(ctx, "tok-a", schemaA, 99)
	if len(r.o.resumed()) != 0 || r.o.opens("tok-a") != 2 {
		t.Fatalf("resumes %v, opens %d", r.o.resumed(), r.o.opens("tok-a"))
	}
}

// OVERLAYS AT REST: an acknowledged write is stored, and a stream another process opens shows it
// before its own stream does; a refused token's are dropped.
func TestAnAcknowledgedWriteReadsBackInAnotherProcess(t *testing.T) {
	r := newCacheRig(t, Options{OverlayTTL: time.Minute, ReopenEvery: time.Minute})
	r.opts.OverlayStore = r.overlays
	r.restart()
	r.o.heads["tok-a"] = 5
	r.liveA()
	body := json.RawMessage(`{"text":"written"}`)
	r.m.Ack("tok-a", schemaA, Ack{Key: "k9", Seq: 9, URN: "urn:apps.civitai.com:todo-app/notes/r9", Body: body, Version: 1})
	// Another process (no stream of its own yet): the write reads back from the stored overlay.
	other := New(r.o, r.opts)
	defer other.Close()
	got, err := read(t, other, "tok-a", schemaA)
	if err != nil || !strings.Contains(urns(got), "notes/r9") {
		t.Fatalf("🔴 the acknowledged write did not read back elsewhere: %q %v", urns(got), err)
	}
	// Another token never reads it.
	r.o.records["tok-b"] = []registry.Entity{r3}
	r.o.heads["tok-b"] = 5
	if got, _ := read(t, other, "tok-b", schemaA); strings.Contains(urns(got), "r9") {
		t.Fatal("🔴 another token read the overlay")
	}
	// Expired or malformed stored overlays are not applied.
	r.overlays.Save(sha256.Sum256([]byte("tok-c")), schemaA, SavedOverlay{Ack: Ack{Key: "kx", Seq: 9, URN: "u", Body: body}, Until: r.c.now()})
	r.overlays.Save(sha256.Sum256([]byte("tok-c")), schemaA, SavedOverlay{Ack: Ack{Key: "", Seq: 9}, Until: r.c.now().Add(time.Second)})
	r.overlays.Save(sha256.Sum256([]byte("tok-c")), schemaA, SavedOverlay{Ack: Ack{Key: "ky", Seq: 9, URN: "u2", Body: body}, Until: r.c.now().Add(time.Hour)})
	r.o.records["tok-c"] = []registry.Entity{r1}
	r.o.heads["tok-c"] = 5
	if got, _ := read(t, other, "tok-c", schemaA); urns(got) != r1.URN {
		t.Fatalf("stale overlays applied: %q", urns(got))
	}
	// A refused token drops its overlays.
	other.Close()
	r.o.refuseExchange["tok-a"] = exchange.ErrRefused
	third := New(r.o, r.opts)
	defer third.Close()
	_, _ = read(t, third, "tok-a", schemaA)
	if r.overlays.Load(context.Background(), sha256.Sum256([]byte("tok-a")), schemaA) != nil {
		t.Fatal("a refused token's overlays were kept")
	}
}

// With Snapshots unset nothing is saved or resumed (the default, the cache off).
func TestNoSnapshotsNoResume(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-a"] = []registry.Entity{r1}
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.m.Sweep()
	h.c.add(2 * time.Minute)
	h.m.Sweep()
	// A meta manager is never resumed either.
	r := newCacheRig(t, Options{SubscribeMeta: func(string) json.RawMessage { return json.RawMessage(`{"level":1}`) }})
	r.snaps.put(Saved{Cursor: cursorC0, Records: []registry.Entity{r2}})
	r.o.records["tok-a"] = []registry.Entity{r1}
	if got, err := read(t, r.m, "tok-a", schemaA); err != nil || urns(got) != r1.URN || len(r.o.resumed()) != 0 {
		t.Fatalf("%q %v", urns(got), err)
	}
}

// ClientSubscriber resumes over the HTTP binding: the cursor and meta reach the request.
func TestClientSubscriberSendsTheCursor(t *testing.T) {
	var sub ResumeSubscriber = ClientSubscriber{Client: &registry.Client{BaseURL: "http://127.0.0.1:1"}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := sub.SubscribeFrom(ctx, schemaA, "t", syncRequest, cursorC0); err == nil {
		t.Fatal("a subscription to a closed port succeeded")
	}
}

func TestSyncOf(t *testing.T) {
	for meta, want := range map[string]string{`{"sync":"done"}`: "done", `{}`: "", ``: "", `{"sync":1}`: "", `x`: ""} {
		if got := syncOf(json.RawMessage(meta)); got != want {
			t.Errorf("%s: %q", meta, got)
		}
	}
}
