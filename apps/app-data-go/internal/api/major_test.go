package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
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
	// flap: each private stream names the next major (current, then current+1, …), as a collection
	// whose majors move faster than a read.
	flap bool
}

func (a *majorAdapter) Subscribe(ctx context.Context, schema, tok string) (session.Stream, error) {
	return a.SubscribeMeta(ctx, schema, tok, nil)
}

func (a *majorAdapter) meta(extra string) json.RawMessage {
	if a.current == 0 {
		return json.RawMessage(`{"head":{"seq":40}` + extra + `}`)
	}
	return json.RawMessage(fmt.Sprintf(`{"head":{"seq":40}%s,"currentMajor":%d}`, extra, a.current))
}

func (a *majorAdapter) SubscribeMeta(_ context.Context, schema, _ string, meta json.RawMessage) (session.Stream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := &stubStream{ev: make(chan registry.Event, 8), done: make(chan struct{})}
	a.open = append(a.open, st)
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
