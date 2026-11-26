package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
)

// THE CURRENT MAJOR through the handler (major.go): the real handler, the real private-stream
// manager and the real shared reader, over a stub adapter whose streams name `currentMajor` as the
// adapter's private and level feeds do, and whose records sit on ONE major's streams only, as the
// adapter claims a body only for the majors whose schema it satisfies. The tests through
// TestAnExplicitMajorOneStillReadsV1 use only API that existed before the fix, so they compile on the
// commit before it: there a read that names no major subscribes at @v1 whatever the collection's
// current major, and answers v1's (empty) streams.

const (
	notesV1 = "urn:schema:apps.civitai.com:todo-app/notes@v1"
	notesV2 = "urn:schema:apps.civitai.com:todo-app/notes@v2"
	notesV3 = "urn:schema:apps.civitai.com:todo-app/notes@v3"
)

// majorAdapter serves every stream of todo-app/notes. Private streams are the private feed's when
// private, else another feed's (so the read takes the shared path); level streams (a request meta)
// and per-viewer streams (`.viewer@v`) are the shared feeds'. Every Live names current as
// `currentMajor` (0: names none) and the one record sits on the streams of recordsAt only.
type majorAdapter struct {
	mu        sync.Mutex
	private   bool
	current   int
	recordsAt string
	record    registry.Entity
	asked     []string // each subscription's schema, in order, prefixed "private:", "level:" or "viewer:"
	open      []*stubStream
	// opened is each subscription's stream, prefixed as asked (openAt counts those still open).
	opened map[*stubStream]string
	// head is the head every Live names (headSet; else 40).
	head    int64
	headSet bool
	// unresolvedAbove, when set, is the newest major the adapter resolves: a private stream of a
	// higher major is empty and names nothing, as the private feed's `nothing()` is.
	unresolvedAbove int
	// blankAt, when set, is a schema whose private stream is empty and names nothing; failAt one
	// whose every subscription is refused.
	blankAt, failAt string
	// flap: each private stream names the next major (current, then current+1, …), as a collection
	// whose majors move faster than a read.
	flap bool
}

func (a *majorAdapter) Subscribe(ctx context.Context, schema, tok string) (session.Stream, error) {
	return a.SubscribeMeta(ctx, schema, tok, nil)
}

func (a *majorAdapter) meta(extra string) json.RawMessage {
	head := int64(40)
	if a.headSet {
		head = a.head
	}
	if a.current == 0 {
		return json.RawMessage(fmt.Sprintf(`{"head":{"seq":%d}%s}`, head, extra))
	}
	return json.RawMessage(fmt.Sprintf(`{"head":{"seq":%d}%s,"currentMajor":%d}`, head, extra, a.current))
}

// openAt is how many streams asked as kind:schema are still open (not closed by the reader).
func (a *majorAdapter) openAt(kind, schema string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for st, as := range a.opened {
		select {
		case <-st.done:
		default:
			if as == kind+":"+schema {
				n++
			}
		}
	}
	return n
}

// majorOf is a schema URN's major.
func majorOf(schema string) int {
	n, _ := strconv.Atoi(schema[strings.LastIndex(schema, "@v")+2:])
	return n
}

func (a *majorAdapter) SubscribeMeta(_ context.Context, schema, _ string, meta json.RawMessage) (session.Stream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if schema == a.failAt {
		a.asked = append(a.asked, "failed:"+schema)
		return nil, &registry.Error{Code: registry.Unavailable, Message: "stub: refused"}
	}
	st := &stubStream{ev: make(chan registry.Event, 8), done: make(chan struct{})}
	a.open = append(a.open, st)
	if a.opened == nil {
		a.opened = map[*stubStream]string{}
	}
	defer func() { a.opened[st] = a.asked[len(a.asked)-1] }()
	holds := false
	switch {
	case meta != nil:
		a.asked = append(a.asked, "level:"+schema)
		holds = schema == a.recordsAt
		defer func() {
			st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.l1.x",
				Meta: a.meta(`,"levels":"on","block":"blk-1","truncated":false`)}
		}()
	case strings.Contains(schema, ".viewer@v"):
		a.asked = append(a.asked, "viewer:"+schema)
		st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.v1.x",
			Meta: json.RawMessage(`{"head":{"seq":40},"mask":5,"levels":"on"}`)}
		return st, nil
	case !a.private:
		a.asked = append(a.asked, "private:"+schema)
		st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.f1.0123456789abcdef0123456789abcdef"}
		return st, nil
	case a.private && schema == a.blankAt,
		a.unresolvedAbove > 0 && majorOf(schema) > a.unresolvedAbove:
		// A major the adapter does not resolve: an empty stream, naming nothing.
		a.asked = append(a.asked, "private:"+schema)
		st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.p1.empty"}
		return st, nil
	default:
		a.asked = append(a.asked, "private:"+schema)
		holds = schema == a.recordsAt
		if a.flap {
			defer func() { a.current++ }()
		}
		defer func() {
			st.ev <- registry.Event{Type: registry.Live, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.p1.0123456789abcdef0123456789abcdef",
				Meta: a.meta("")}
		}()
	}
	if holds {
		st.ev <- registry.Event{Type: registry.Upsert, Entity: a.record}
	}
	return st, nil
}

// approve is a newly approved major: every open stream is told it, in a progress, as the adapter
// re-reads each stream of a collection whose schema family changed.
func (a *majorAdapter) approve(current int, recordsAt string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.current, a.recordsAt = current, recordsAt
	for _, st := range a.open {
		select {
		case st.ev <- registry.Event{Type: registry.Progress, Cursor: "b1.0a1b2c3d4e5f60718293a4b5.p1.0123456789abcdef0123456789abcdef",
			Meta: a.meta("")}:
		default:
		}
	}
}

func (a *majorAdapter) subscribed() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.asked)
}

func (a *majorAdapter) closeAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, st := range a.open {
		_ = st.Close()
	}
}

// majorStack is the writes-on handler with its private streams and its shared reader both on a.
func majorStack(t *testing.T, a *majorAdapter) *stack {
	t.Helper()
	s, _ := newSharedStack(t)
	t.Cleanup(a.closeAll)
	mgr := session.New(a, session.Options{
		MaxStreams: 10, MaxPerToken: 4, IdleTTL: time.Minute, MaxAge: time.Hour, Cooldown: time.Second,
		MaxRecords: 100, MaxBytes: 1 << 20, NotPrivateCooldown: time.Hour, ExpiryMargin: 30 * time.Second,
		OverlayTTL: 90 * time.Second, ReopenEvery: time.Minute,
		Exchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x.AppDataRead." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
	})
	t.Cleanup(mgr.Close)
	bounds := shared.Bounds{MaxStreams: 10, MaxRecords: 100, MaxBytes: 1 << 20}
	reader, levels, viewers := shared.NewReader(shared.Build{
		Sub: a, Budget: session.NewBudget(40, 64<<20), Level: bounds, Viewer: bounds,
		ServiceToken: func(context.Context) (string, time.Time, error) {
			return "svc-token", time.Now().Add(time.Hour), nil
		},
		ViewerExchange: func(_ context.Context, subject string) (exchange.Token, error) {
			return exchange.Token{Access: "x.AppDataRead." + subject, Expires: time.Now().Add(time.Hour)}, nil
		},
		LevelMaxAge: time.Hour, IdleTTL: time.Hour, MaxAge: time.Hour, Cooldown: time.Hour,
		NotPrivateCooldown: time.Hour, ExpiryMargin: time.Second, OverlayTTL: 90 * time.Second,
		ReopenEvery: time.Minute, MaxStreamsPerToken: 4, MaxOverlays: 10, MaxOverlayBytes: 1 << 20, ProbesPerApp: 2,
	})
	t.Cleanup(levels.Close)
	t.Cleanup(viewers.Close)
	s.srv.Streams = mgr
	s.srv.Shared = reader
	s.h = s.srv.Handler()
	return s
}

type majorGot struct {
	status int
	retry  string
	body   string
	keys   string
	data   string
	err    string
}

func (s *stack) majorRead(t *testing.T, path string) majorGot {
	t.Helper()
	return s.majorReadAs(t, path, "civitai_major-reader")
}

func (s *stack) majorReadAs(t *testing.T, path, token string) majorGot {
	t.Helper()
	rec := s.call(t, http.MethodGet, path, token, "")
	var b struct {
		Items []struct {
			Key  string          `json:"key"`
			Data json.RawMessage `json:"data"`
		} `json:"items"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	g := majorGot{status: rec.Code, retry: rec.Header().Get("Retry-After"), body: rec.Body.String(), err: b.Error}
	ks, ds := make([]string, 0, len(b.Items)), make([]string, 0, len(b.Items))
	for _, it := range b.Items {
		ks, ds = append(ks, it.Key), append(ds, string(it.Data))
	}
	g.keys, g.data = strings.Join(ks, ","), strings.Join(ds, ",")
	return g
}

func majorRecord(schema, key, canary string) registry.Entity {
	return registry.Entity{URN: "urn:apps.civitai.com:todo-app/notes/" + key, Schemas: []string{schema}, Rev: "r-" + key,
		Key: key, Seq: 31, Version: 3, Body: json.RawMessage(fmt.Sprintf(`{"title":%q}`, canary))}
}

func askedAt(asked []string, kind, schema string) int {
	n := 0
	for _, a := range asked {
		if a == kind+":"+schema {
			n++
		}
	}
	return n
}

// 🔴 THE BUG. A shared collection whose current major is 2, its documents v2-shaped: a read that
// names no major (every SDK's service-mode read) subscribes the level streams at @v2 and answers the
// document. Before the fix it subscribed @v1, whose streams hold none of them, and answered empty.
func TestANoMajorSharedReadSubscribesAtTheCurrentMajor(t *testing.T) {
	a := &majorAdapter{current: 2, recordsAt: notesV2, record: majorRecord(notesV2, "rated-7", "V2-SHARED-CANARY")}
	s := majorStack(t, a)
	g := s.majorRead(t, notesPath)
	asked := a.subscribed()
	if g.status != http.StatusOK || g.keys != "rated-7" || g.data != `{"title":"V2-SHARED-CANARY"}` {
		t.Fatalf("no major, current 2: %d %s (asked %v); want 200 rated-7", g.status, g.body, asked)
	}
	if askedAt(asked, "level", notesV2) == 0 {
		t.Fatalf("no level stream subscribed at @v2: %v", asked)
	}
	// Another viewer's read starts at the major the streams named: it opens no @v1 stream (its own
	// per-viewer stream included), only @v2 ones.
	before := len(asked)
	if g := s.majorReadAs(t, notesPath, "civitai_major-other"); g.status != http.StatusOK || g.keys != "rated-7" {
		t.Fatalf("another viewer's read: %d %s", g.status, g.body)
	}
	opened := a.subscribed()[before:]
	if len(opened) == 0 {
		t.Fatal("another viewer's read opened no stream (positive control: its per-viewer stream)")
	}
	for _, q := range opened {
		if !strings.HasSuffix(q, "@v2") {
			t.Fatalf("another viewer's read opened %s (all it opened: %v); want @v2 only", q, opened)
		}
	}
}

// 🔴 The same for a private collection: the private stream is read at the current major.
func TestANoMajorPrivateReadReadsTheCurrentMajor(t *testing.T) {
	a := &majorAdapter{private: true, current: 2, recordsAt: notesV2, record: majorRecord(notesV2, "mine-4", "V2-PRIVATE-CANARY")}
	s := majorStack(t, a)
	for _, path := range []string{notesPath, notesPath + "/mine-4"} {
		rec := s.call(t, http.MethodGet, path, "civitai_major-reader", "")
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "V2-PRIVATE-CANARY") {
			t.Fatalf("%s, no major, current 2: %d %s (asked %v); want 200 with the v2 record", path, rec.Code, rec.Body.String(), a.subscribed())
		}
	}
	if askedAt(a.subscribed(), "private", notesV2) != 1 {
		t.Fatalf("private streams asked: %v; want one at @v2", a.subscribed())
	}
}

// A new major approved after the hint was learned: the open stream's progress names it, and the
// next read with no major reads at it.
func TestANewlyApprovedMajorMovesTheNoMajorRead(t *testing.T) {
	a := &majorAdapter{private: true, current: 2, recordsAt: notesV2, record: majorRecord(notesV2, "mine-5", "V2-CANARY")}
	s := majorStack(t, a)
	if g := s.majorRead(t, notesPath); g.status != http.StatusOK || g.keys != "mine-5" {
		t.Fatalf("at 2: %d %s", g.status, g.body)
	}
	a.record = majorRecord(notesV3, "mine-5", "V3-CANARY")
	a.approve(3, notesV3)
	deadline := time.Now().Add(2 * time.Second)
	for {
		g := s.majorRead(t, notesPath)
		if g.status == http.StatusOK && g.data == `{"title":"V3-CANARY"}` {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after major 3 was approved: %d %s (asked %v); want the v3 record", g.status, g.body, a.subscribed())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if askedAt(a.subscribed(), "private", notesV3) != 1 {
		t.Fatalf("asked %v; want one @v3 private stream", a.subscribed())
	}
}

// INVARIANT GUARD (passes before the fix too): a read that names `?major=1` reads v1's streams, the
// collection's current major 2 notwithstanding, and opens no other major's.
func TestAnExplicitMajorOneStillReadsV1(t *testing.T) {
	for _, private := range []bool{true, false} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			a := &majorAdapter{private: private, current: 2, recordsAt: notesV1, record: majorRecord(notesV1, "old-1", "V1-CANARY")}
			s := majorStack(t, a)
			g := s.majorRead(t, notesPath+"?major=1")
			if g.status != http.StatusOK || g.keys != "old-1" || g.data != `{"title":"V1-CANARY"}` {
				t.Fatalf("?major=1: %d %s; want 200 old-1", g.status, g.body)
			}
			for _, q := range a.subscribed() {
				if !strings.HasSuffix(q, "@v1") {
					t.Fatalf("?major=1 subscribed %s (all: %v)", q, a.subscribed())
				}
			}
		})
	}
}

// 🔴 THE COMPATIBILITY GUARANTEE. Against an adapter that names no current major (one released
// before `currentMajor`, or rolled back to it), a read with no major is answered exactly as before
// the fix: at major 1, the stream's records, 200, no refusal and no REST read. So app-data-go can
// ship, or roll back, without the adapter. An explicit `?major=1` beside it reads the same.
func TestANoMajorReadAgainstAnAdapterNamingNoMajorReadsAsBefore(t *testing.T) {
	for _, private := range []bool{true, false} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			a := &majorAdapter{private: private, current: 0, recordsAt: notesV1, record: majorRecord(notesV1, "old-2", "V1-COMPAT-CANARY")}
			s := majorStack(t, a)
			for _, path := range []string{notesPath, notesPath + "?major=1"} {
				g := s.majorRead(t, path)
				if g.status != http.StatusOK || g.keys != "old-2" || g.data != `{"title":"V1-COMPAT-CANARY"}` {
					t.Fatalf("%s, no current named: %d %q %s; want 200 old-2 as before", path, g.status, g.retry, g.body)
				}
			}
			if n := s.store.calls.Load(); n != 0 {
				t.Fatalf("🔴 REST was read %d times", n)
			}
			for _, q := range a.subscribed() {
				if !strings.HasSuffix(q, "@v1") {
					t.Fatalf("subscribed %s (all: %v); want @v1 only", q, a.subscribed())
				}
			}
		})
	}
	t.Run("empty stream", func(t *testing.T) {
		a := &majorAdapter{private: true, current: 0, recordsAt: "none"}
		s := majorStack(t, a)
		if g := s.majorRead(t, notesPath); g.status != http.StatusOK || g.keys != "" {
			t.Fatalf("an empty stream naming no current: %d %s; want 200 empty", g.status, g.body)
		}
	})
}

// The same with the writes off (REST still the fallback): a stream that holds records and names no
// current major is answered from the stream, as before, never sent to REST. (Uses the fake adapter's
// `noCurrent`, which exists only with the fix.)
func TestANoMajorReadWithNoCurrentReadsTheStreamWithTheWritesOff(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_erin"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-e", "E-STREAM")}
	s.reg.noCurrent["civitai_erin"] = true
	s.store.by["civitai_erin"] = restAnswer{200, `{"items":[{"key":"k-e","data":{"text":"E-REST"},"version":2}],"nextCursor":null}`}
	g := s.get(t, notesPath, "civitai_erin")
	if g.status != http.StatusOK || g.ans.Source != "registry" || !strings.Contains(g.body, "E-STREAM") || s.store.calls.Load() != 0 {
		t.Fatalf("no current named, writes off: %d %s (REST reads %d); want the stream's record", g.status, g.body, s.store.calls.Load())
	}
}

// A stream read again at the major the first one named, which names yet another major (approved
// between the two reads): the read is answered at the second stream, never a third stream and never
// a refusal, and the hint moves to the newest major named, for the next read.
func TestACurrentMajorThatMovesAgainIsReadOnceAndRemembered(t *testing.T) {
	a := &majorAdapter{private: true, current: 2, flap: true, recordsAt: notesV2, record: majorRecord(notesV2, "mine-6", "FLAP-CANARY")}
	s := majorStack(t, a)
	g := s.majorRead(t, notesPath)
	if g.status != http.StatusOK || g.keys != "mine-6" || g.data != `{"title":"FLAP-CANARY"}` {
		t.Fatalf("a major that moved again: %d %s; want 200 at @v2", g.status, g.body)
	}
	if got := a.subscribed(); strings.Join(got, " ") != "private:"+notesV1+" private:"+notesV2 {
		t.Fatalf("subscribed %v; want @v1 then @v2 only", got)
	}
	if n := s.srv.majors.guess("todo-app", "notes"); n != 3 {
		t.Fatalf("the hint after @v2 named 3: %d; want 3", n)
	}
}

// A hinted major the adapter does not resolve (`not_resolved`, as after a rollback) drops the hint:
// the next read with no major opens at 1 again. An unhinted read's not_resolved keeps nothing.
func TestANotResolvedHintedMajorIsForgotten(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-n"] = true
	s.srv.majors.set("todo-app", "notes", 3)
	f.err = &session.EndedError{Reason: "not_resolved"}
	g := s.shared(t, notesPath, "civitai_shared-n")
	if g.status != http.StatusServiceUnavailable || g.err.Error != "not_resolved" {
		t.Fatalf("not resolved: %d %s", g.status, g.body)
	}
	if f.args[0] != "todo-app/notes@3>0" {
		t.Fatalf("read as %v; want the hinted @3 first", f.args)
	}
	if n := s.srv.majors.guess("todo-app", "notes"); n != 1 {
		t.Fatalf("the hint after not_resolved: %d; want 1", n)
	}
}

// The hints are bounded: past majorHintsMax collections they are all dropped, and a known one is
// replaced in place.
func TestTheMajorHintsAreBounded(t *testing.T) {
	var h majorHints
	for i := range majorHintsMax {
		h.set("app", fmt.Sprintf("c%d", i), 2)
	}
	h.set("app", "c0", 4)
	if h.guess("app", "c0") != 4 || h.guess("app", "c1") != 2 || len(h.m) != majorHintsMax {
		t.Fatalf("at the bound: c0 %d, c1 %d, %d held", h.guess("app", "c0"), h.guess("app", "c1"), len(h.m))
	}
	h.set("app", "new", 5)
	if h.guess("app", "new") != 5 || h.guess("app", "c1") != 1 || len(h.m) != 1 {
		t.Fatalf("past the bound: new %d, c1 %d, %d held", h.guess("app", "new"), h.guess("app", "c1"), len(h.m))
	}
}

// A named major no schema URN can carry for p's collection is not followed: the read is answered at
// the major it opened at.
func TestANamedMajorNoURNCanCarryIsNotFollowed(t *testing.T) {
	var s Server
	p := readParams{slug: "Not A Slug", collection: "notes", major: 1, implied: true}
	if done := s.settle(&p, 2, false); !done || p.major != 1 {
		t.Fatalf("settle: done %v at %d; want answered at 1", done, p.major)
	}
}

// --- audit round 1 (🟡): each case runs on the API that existed before its fix, so it compiles there.

// blockShaped is a token shaped as an App Block token (exchange.KindBlock): a floor is met by an
// acknowledgement this replica holds for it (the SDK's read-after-write). Its claims segment is not
// an anonymous one.
const blockShaped = "aGVhZGVy.Y2xhaW1z.c2lnbmF0dXJl"

// writeStack is majorStack with the writes acknowledged as main wires them (shared.AckBoth over the
// private manager and the shared reader), a block token verified, and every token exchangeable.
func writeStack(t *testing.T, a *majorAdapter) *stack {
	t.Helper()
	s := majorStack(t, a)
	fwd := s.srv.Writes.(*writes.Forwarder)
	fwd.Verify = func(context.Context, string) error { return nil }
	fwd.Acked = shared.AckBoth(s.srv.Streams.(*session.Manager), s.srv.Shared.(*shared.Reader))
	s.srv.Exchangeable = func(string) bool { return true }
	s.h = s.srv.Handler()
	return s
}

// 🟡 Y1. A write that names no major is acknowledged at the major a read that names none uses, so
// the SDK's read-back (`?minSeq=` the write's seq) finds it held on the stream it reads: 200 with the
// written record, before the adapter's next poll. Before the fix the write was held at @v1 while the
// read went to @v2: `503 floor_not_met`.
func TestANoMajorWriteIsReadBackAtTheMajorANoMajorReadUses(t *testing.T) {
	for _, private := range []bool{true, false} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			a := &majorAdapter{private: private, current: 2, headSet: true, head: 0, recordsAt: notesV2,
				record: majorRecord(notesV2, "r-0", "V2-BASE")}
			s := writeStack(t, a)
			if g := s.majorReadAs(t, notesPath, blockShaped); g.status != http.StatusOK || g.keys != "r-0" {
				t.Fatalf("first read: %d %s", g.status, g.body)
			}
			rec := s.call(t, http.MethodPut, notesPath+"/w-1", blockShaped, `{"data":{"title":"WRITTEN-CANARY"}}`)
			var ack struct {
				Seq int64 `json:"seq"`
			}
			if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &ack) != nil || ack.Seq < 1 {
				t.Fatalf("write: %d %s", rec.Code, rec.Body.String())
			}
			g := s.majorReadAs(t, fmt.Sprintf("%s?minSeq=%d", notesPath, ack.Seq), blockShaped)
			if g.status != http.StatusOK || !strings.Contains(g.body, "WRITTEN-CANARY") {
				t.Fatalf("read-back at minSeq %d: %d %s; want 200 with the written record", ack.Seq, g.status, g.body)
			}
		})
	}
}

// 🟡 Y2. A private read at a hinted major the adapter no longer resolves (its private stream there is
// empty and names nothing) drops the hint and reads the major the adapter names: the record, and the
// hint 2. Before the fix every such read answered empty at the stale @v3.
func TestAPrivateReadDropsAHintTheAdapterNoLongerResolves(t *testing.T) {
	a := &majorAdapter{private: true, current: 2, unresolvedAbove: 2, recordsAt: notesV2,
		record: majorRecord(notesV2, "mine-9", "V2-AFTER-ROLLBACK")}
	s := majorStack(t, a)
	s.srv.majors.set("todo-app", "notes", 3)
	for i := range 2 {
		g := s.majorRead(t, notesPath)
		if g.status != http.StatusOK || g.data != `{"title":"V2-AFTER-ROLLBACK"}` {
			t.Fatalf("read %d at a stale hint 3: %d %s (asked %v); want the v2 record", i, g.status, g.body, a.subscribed())
		}
	}
	if n := s.srv.majors.guess("todo-app", "notes"); n != 2 {
		t.Fatalf("the hint after the adapter named 2: %d; want 2", n)
	}
	// The control: an empty, unnamed stream at a hint the adapter does resolve (its @v1 stream names
	// the hinted major) keeps the hint and answers empty; the @v1 stream it asked is released.
	b := &majorAdapter{private: true, current: 2, recordsAt: "none", blankAt: notesV2}
	s2 := majorStack(t, b)
	s2.srv.majors.set("todo-app", "notes", 2)
	if g := s2.majorRead(t, notesPath); g.status != http.StatusOK || g.keys != "" {
		t.Fatalf("an empty stream at a resolved hint: %d %s", g.status, g.body)
	}
	if n := s2.srv.majors.guess("todo-app", "notes"); n != 2 {
		t.Fatalf("the hint after an empty stream at a resolved major: %d; want 2 kept", n)
	}
	if n := b.openAt("private", notesV1); n != 0 {
		t.Fatalf("%d @v1 private streams still open after the check; want 0", n)
	}
}

// 🟡 Y3. A read on a cold hint opens its guess's streams (@v1), then moves to the major they name:
// the @v1 streams it alone used are released at once, not held against the stream caps until the
// idle TTL. A stream another read used is kept (the explicit ?major=1 control).
func TestAReadThatMovesReleasesTheGuessStreams(t *testing.T) {
	for _, private := range []bool{true, false} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			a := &majorAdapter{private: private, current: 2, recordsAt: notesV2, record: majorRecord(notesV2, "rel-1", "V2-REL")}
			s := majorStack(t, a)
			if g := s.majorRead(t, notesPath); g.status != http.StatusOK || g.keys != "rel-1" {
				t.Fatalf("read: %d %s", g.status, g.body)
			}
			kinds := []string{"private"}
			if !private {
				kinds = []string{"level"}
			}
			for _, kind := range kinds {
				if n := a.openAt(kind, notesV1); n != 0 {
					t.Fatalf("%d %s @v1 streams still open after the read moved to @v2 (asked %v); want 0", n, kind, a.subscribed())
				}
				if n := a.openAt(kind, notesV2); n == 0 {
					t.Fatalf("no %s @v2 stream open: the positive control (asked %v)", kind, a.subscribed())
				}
			}
			if !private {
				if n := a.openAt("viewer", "urn:schema:apps.civitai.com:todo-app/notes.viewer@v1"); n != 0 {
					t.Fatalf("%d per-viewer @v1 streams still open; want 0", n)
				}
			}
		})
	}
	t.Run("a stream another read used is kept", func(t *testing.T) {
		a := &majorAdapter{private: true, current: 2, recordsAt: notesV1, record: majorRecord(notesV1, "old-1", "V1")}
		s := majorStack(t, a)
		if g := s.majorRead(t, notesPath+"?major=1"); g.status != http.StatusOK {
			t.Fatalf("explicit read: %d %s", g.status, g.body)
		}
		if g := s.majorRead(t, notesPath); g.status != http.StatusOK {
			t.Fatalf("no-major read: %d %s", g.status, g.body)
		}
		if n := a.openAt("private", notesV1); n != 1 {
			t.Fatalf("%d @v1 streams open; want the explicit read's 1 kept", n)
		}
	})
}

// A stream a no-major read needs but cannot open (the move's target, or the @v1 check of a stale
// hint) answers that stream's refusal, as any read whose stream cannot answer: never a read at
// another major.
func TestANoMajorReadWhoseNeededStreamFailsAnswersTheRefusal(t *testing.T) {
	cases := []struct {
		name string
		a    *majorAdapter
		hint int
	}{
		{"private, the move's target", &majorAdapter{private: true, current: 2, failAt: notesV2}, 0},
		{"shared, the move's target", &majorAdapter{current: 2, failAt: notesV2}, 0},
		{"private, the @v1 check of a stale hint", &majorAdapter{private: true, current: 2, unresolvedAbove: 2, failAt: notesV1}, 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := majorStack(t, c.a)
			if c.hint > 0 {
				s.srv.majors.set("todo-app", "notes", c.hint)
			}
			g := s.majorRead(t, notesPath)
			if g.status != http.StatusServiceUnavailable || g.retry != "1" {
				t.Fatalf("%d %q %s (asked %v); want a 503 refusal", g.status, g.retry, g.body, c.a.subscribed())
			}
		})
	}
}
