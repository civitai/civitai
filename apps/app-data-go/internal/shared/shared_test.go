package shared

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// Every fixture's keys, seqs, heads and canary bodies are pairwise distinct, so a read that answers
// the wrong one of them names which. Fails on origin/main: package shared does not exist.

const (
	schema  = "urn:schema:apps.civitai.com:bench-app/records@v1"
	vschema = "urn:schema:apps.civitai.com:bench-app/records.viewer@v1"
	hubTok  = "civitai_viewer-a"
	// A block token's shape (exchange.KindOf): a compact JWS.
	blockTok = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJ2aWV3ZXIifQ.c2ln"
)

// fakeViews answers View by (token, schema): a snapshot or an error, counting each call.
type fakeViews struct {
	mu    sync.Mutex
	snaps map[string]session.Snapshot
	errs  map[string]error
	calls map[string]int
}

func newViews() *fakeViews {
	return &fakeViews{snaps: map[string]session.Snapshot{}, errs: map[string]error{}, calls: map[string]int{}}
}

func (f *fakeViews) Release(string, string) {}

func (f *fakeViews) View(_ context.Context, token, sch string, _ int64) (session.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := token + "#" + sch
	f.calls[k]++
	if err := f.errs[k]; err != nil {
		return session.Snapshot{}, err
	}
	return f.snaps[k], nil
}

func (f *fakeViews) set(token, sch string, snap session.Snapshot) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snaps[token+"#"+sch] = snap
}

func (f *fakeViews) fail(token, sch string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err == nil {
		delete(f.errs, token+"#"+sch)
		return
	}
	f.errs[token+"#"+sch] = err
}

// n is how many times subject's stream of the collection was read.
func (f *fakeViews) n(subject string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[subject+"#"+schema]
}

func doc(key string, seq int64, canary string) registry.Entity {
	return registry.Entity{URN: "urn:apps.civitai.com:bench-app/records/" + key, Key: key, Seq: seq, Rev: "r" + key,
		Body: json.RawMessage(fmt.Sprintf(`{"t":%q}`, canary)), Version: seq % 7, CreatedAt: "c-" + key, UpdatedAt: "u-" + key}
}

func snap(head int64, meta string, ents ...registry.Entity) session.Snapshot {
	m := json.RawMessage(nil)
	if meta != "" {
		m = json.RawMessage(meta)
	}
	return session.Snapshot{Entities: ents, Meta: m, Head: head, HasHead: true}
}

func lvl(bit string) string { return LevelSubject(schema, bit) }

// shown is a board as key=canary[*], * for the viewer's own.
func shown(b Board) string {
	out := make([]string, 0, len(b.Docs))
	for _, d := range b.Docs {
		var body struct {
			T string `json:"t"`
		}
		_ = json.Unmarshal(d.Data, &body)
		s := d.Key + "=" + body.T
		if d.Mine {
			s += "*"
		}
		out = append(out, s)
	}
	return strings.Join(out, ",")
}

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

type rig struct {
	levels, viewers *fakeViews
	r               *Reader
	c               *clock
}

func newRig() *rig {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	g := &rig{levels: newViews(), viewers: newViews(), c: c}
	g.r = &Reader{Levels: g.levels, Viewers: g.viewers, Now: c.now, KnownTTL: time.Hour, ProbesPerApp: 2,
		Overlays: &Overlays{TTL: 90 * time.Second, Max: 4, Now: c.now}}
	return g
}

func (g *rig) read(t *testing.T, v Viewer, minSeq int64) (Board, error) {
	t.Helper()
	return g.r.Read(context.Background(), v, "bench-app", "records", 1, minSeq)
}

// THE UNION: the level streams of the mask's bits only, plus the viewer's own documents, each key
// once at its higher seq, sorted by key; a document is the viewer's own when the per-viewer stream
// holds its key, whichever stream's copy is kept.
func TestTheUnionHoldsEachDocumentOnceAndMarksTheViewersOwn(t *testing.T) {
	g := newRig()
	g.viewers.set(hubTok, vschema, snap(500, `{"head":{"seq":500},"mask":5,"keyedBy":"parent+viewer"}`,
		doc("k-mine-pending", 301, "MINE-PENDING"), doc("k-mine-rated", 302, "MINE-OLD-302")))
	g.levels.set(lvl("1"), schema, snap(510, `{"head":{"seq":510},"levels":"on","block":"apb_1"}`,
		doc("k-pg", 303, "PG-303"), doc("k-moved", 304, "MOVED-OLD-304"), doc("k-mine-rated", 305, "MINE-NEW-305")))
	g.levels.set(lvl("4"), schema, snap(520, `{"head":{"seq":520},"levels":"on","block":"apb_1"}`,
		doc("k-r", 306, "R-306"), doc("k-moved", 307, "MOVED-NEW-307")))
	// A bit outside the mask holds a document the viewer must never see.
	g.levels.set(lvl("8"), schema, snap(530, `{"head":{"seq":530}}`, doc("k-x", 308, "X-308")))
	b, err := g.read(t, Viewer{Token: hubTok}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if want := "k-mine-pending=MINE-PENDING*,k-mine-rated=MINE-NEW-305*,k-moved=MOVED-NEW-307,k-pg=PG-303,k-r=R-306"; shown(b) != want {
		t.Fatalf("board %s\nwant  %s", shown(b), want)
	}
	if b.KeyedBy != "parent+viewer" || b.Floor != "" {
		t.Fatalf("keyedBy %q floor %q", b.KeyedBy, b.Floor)
	}
	for _, bit := range []string{"2", "8", "16", "none"} {
		if g.levels.n(lvl(bit)) != 0 {
			t.Fatalf("🔴 level %s read for a mask of 5", bit)
		}
	}
	d := b.Docs[2]
	if d.Version != 307%7 || d.CreatedAt != "c-k-moved" || d.UpdatedAt != "u-k-moved" || d.Seq != 307 || d.Rev != "rk-moved" {
		t.Fatalf("a document's fields: %+v", d)
	}
}

// 🔴 THE GATE: a per-viewer stream whose meta names no mask (the adapter refusing the viewer), or a
// mask outside the selectable levels, is ErrViewerRefused, and no level stream is read for it; a
// per-viewer stream that cannot be read is its error, never a level-only answer.
func TestARefusedViewerIsRefusedFromEveryLevelStreamAtOnce(t *testing.T) {
	for _, meta := range []string{`{"head":{"seq":9}}`, `{"head":{"seq":9},"mask":64}`, `{"head":{"seq":9},"mask":-1}`, ``, `not json`} {
		g := newRig()
		g.viewers.set(hubTok, vschema, snap(9, meta))
		g.levels.set(lvl("1"), schema, snap(10, `{}`, doc("k-pub", 11, "PUB")))
		if _, err := g.read(t, Viewer{Token: hubTok}, 0); !errors.Is(err, ErrViewerRefused) {
			t.Fatalf("meta %q: %v, want ErrViewerRefused", meta, err)
		}
		if g.levels.n(lvl("1")) != 0 {
			t.Fatalf("meta %q: a level stream was read for a refused viewer", meta)
		}
	}
	g := newRig()
	g.viewers.fail(hubTok, vschema, session.ErrBlockSpent)
	if _, err := g.read(t, Viewer{Token: hubTok}, 0); !errors.Is(err, session.ErrBlockSpent) {
		t.Fatalf("an unreadable per-viewer stream: %v", err)
	}
	// A mask of no selectable bit reads no level stream: the viewer's own documents only.
	g = newRig()
	g.viewers.set(hubTok, vschema, snap(9, `{"head":{"seq":9},"mask":0}`, doc("k-own", 8, "OWN")))
	if b, err := g.read(t, Viewer{Token: hubTok}, 0); err != nil || shown(b) != "k-own=OWN*" {
		t.Fatalf("mask 0: %s %v", shown(b), err)
	}
}

// THE MODE: a bit stream that ends `levels_off` (also while its key cools down, joined with
// ErrCoolingDown) switches the schema to the one `none` stream, remembered for later reads; `none`
// ending `levels_on` switches back. The per-viewer stream's `levels` names the mode too.
func TestTheLevelsModeFollowsTheAdaptersEnds(t *testing.T) {
	g := newRig()
	g.viewers.set(hubTok, vschema, snap(100, `{"head":{"seq":100},"mask":3}`))
	g.levels.fail(lvl("1"), schema, errors.Join(session.ErrCoolingDown, &session.EndedError{Reason: "levels_off"}))
	g.levels.set(lvl("2"), schema, snap(101, `{}`, doc("k-two", 102, "TWO")))
	g.levels.set(lvl("none"), schema, snap(103, `{"levels":"off"}`, doc("k-all", 104, "ALL")))
	b, err := g.read(t, Viewer{Token: hubTok}, 0)
	if err != nil || shown(b) != "k-all=ALL" {
		t.Fatalf("after levels_off: %s %v", shown(b), err)
	}
	before := g.levels.n(lvl("1"))
	if b, err = g.read(t, Viewer{Token: hubTok}, 0); err != nil || shown(b) != "k-all=ALL" || g.levels.n(lvl("1")) != before {
		t.Fatalf("the mode is remembered: %s %v, bit 1 read %d more times", shown(b), err, g.levels.n(lvl("1"))-before)
	}
	// `none` ends levels_on: back to the bits.
	g.levels.fail(lvl("1"), schema, nil)
	g.levels.set(lvl("1"), schema, snap(105, `{}`, doc("k-one", 106, "ONE")))
	g.levels.fail(lvl("none"), schema, &session.EndedError{Reason: "levels_on"})
	if b, err = g.read(t, Viewer{Token: hubTok}, 0); err != nil || shown(b) != "k-one=ONE,k-two=TWO" {
		t.Fatalf("after levels_on: %s %v", shown(b), err)
	}
	// The per-viewer stream says off: straight to `none`, no bit read.
	g.levels.fail(lvl("none"), schema, nil)
	g.viewers.set(hubTok, vschema, snap(100, `{"head":{"seq":100},"mask":3,"levels":"off"}`))
	ones := g.levels.n(lvl("1"))
	if b, err = g.read(t, Viewer{Token: hubTok}, 0); err != nil || shown(b) != "k-all=ALL" || g.levels.n(lvl("1")) != ones {
		t.Fatalf("viewer says off: %s %v", shown(b), err)
	}
	// Ends twice in a row switch once, then answer the error: never a loop.
	g.viewers.set(hubTok, vschema, snap(100, `{"head":{"seq":100},"mask":3,"levels":"on"}`))
	g.levels.fail(lvl("1"), schema, &session.EndedError{Reason: "levels_off"})
	g.levels.fail(lvl("none"), schema, &session.EndedError{Reason: "levels_on"})
	if _, err = g.read(t, Viewer{Token: hubTok}, 0); !errors.Is(err, session.ErrEnded) {
		t.Fatalf("flapping ends: %v", err)
	}
	// Any other end, or error, is the read's.
	g = newRig()
	g.viewers.set(hubTok, vschema, snap(100, `{"head":{"seq":100},"mask":1}`))
	g.levels.fail(lvl("1"), schema, &session.EndedError{Reason: "not_resolved"})
	var ended *session.EndedError
	if _, err = g.read(t, Viewer{Token: hubTok}, 0); !errors.As(err, &ended) || ended.Reason != "not_resolved" {
		t.Fatalf("not_resolved: %v", err)
	}
}

// SIGNED-OUT: the level streams of the token's own mask alone, no per-viewer stream, nobody's
// document is "mine"; and only while every level stream read names the token's app block.
func TestASignedOutReadIsTheLevelStreamsOfItsMaskForItsBlock(t *testing.T) {
	g := newRig()
	g.levels.set(lvl("1"), schema, snap(40, `{"block":"apb_bench"}`, doc("k-a", 41, "A")))
	g.levels.set(lvl("2"), schema, snap(42, `{"block":"apb_bench"}`, doc("k-b", 43, "B")))
	g.levels.set(lvl("4"), schema, snap(44, `{"block":"apb_bench"}`, doc("k-c", 45, "C")))
	b, err := g.read(t, Viewer{Anonymous: &Anonymous{Mask: 3 | 32, AppBlockID: "apb_bench"}}, 0)
	if err != nil || shown(b) != "k-a=A,k-b=B" || b.KeyedBy != "" {
		t.Fatalf("%s %v", shown(b), err)
	}
	if n := len(g.viewers.calls); n != 0 {
		t.Fatalf("🔴 a signed-out read opened %d per-viewer streams", n)
	}
	for _, block := range []string{"apb_other", ""} {
		if _, err := g.read(t, Viewer{Anonymous: &Anonymous{Mask: 1, AppBlockID: block}}, 0); !errors.Is(err, ErrBlockMismatch) {
			t.Fatalf("block %q: %v", block, err)
		}
	}
	g.levels.set(lvl("2"), schema, snap(42, `{"block":"apb_switched"}`, doc("k-b", 43, "B")))
	if _, err := g.read(t, Viewer{Anonymous: &Anonymous{Mask: 3, AppBlockID: "apb_bench"}}, 0); !errors.Is(err, ErrBlockMismatch) {
		t.Fatalf("one stream naming another block: %v", err)
	}
}

// READ-YOUR-WRITES: an acknowledged put shows over the union and is the viewer's own; a delete marker
// hides the key; each is dropped once every stream read names a head at or above it, or the union
// holds its key at or above its seq, or at its TTL. Another token never sees them.
func TestAnAcknowledgedWriteShowsOverTheUnionUntilEveryStreamCatchesUp(t *testing.T) {
	g := newRig()
	viewerAt := func(head int64, ents ...registry.Entity) {
		g.viewers.set(hubTok, vschema, snap(head, fmt.Sprintf(`{"head":{"seq":%d},"mask":1}`, head), ents...))
	}
	levelAt := func(head int64, ents ...registry.Entity) {
		g.levels.set(lvl("1"), schema, snap(head, fmt.Sprintf(`{"head":{"seq":%d}}`, head), ents...))
	}
	viewerAt(600)
	levelAt(610, doc("k-old", 601, "OLD-601"), doc("k-gone", 602, "GONE-602"))
	g.viewers.set("civitai_other", vschema, snap(600, `{"head":{"seq":600},"mask":1}`))
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-new", Seq: 620, Body: json.RawMessage(`{"t":"ACK-620"}`), Version: 1, CreatedAt: "c-620"})
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-gone", Seq: 621, Deleted: true})
	// An ack below the one held for its key is ignored.
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-new", Seq: 619, Body: json.RawMessage(`{"t":"ACK-619"}`)})
	b, err := g.read(t, Viewer{Token: hubTok}, 0)
	if err != nil || shown(b) != "k-new=ACK-620*,k-old=OLD-601" || b.Docs[0].Version != 1 || b.Docs[0].CreatedAt != "c-620" || b.Docs[0].Rev != "seq.620" {
		t.Fatalf("with the acks: %s %+v %v", shown(b), b.Docs, err)
	}
	if b, _ := g.read(t, Viewer{Token: "civitai_other"}, 0); shown(b) != "k-gone=GONE-602,k-old=OLD-601" {
		t.Fatalf("🔴 another token's read: %s", shown(b))
	}
	// The viewer's stream caught up (head 625), the level stream not yet (610): still shown.
	viewerAt(625, doc("k-new", 620, "STREAM-620"))
	if b, _ := g.read(t, Viewer{Token: hubTok}, 0); shown(b) != "k-new=STREAM-620*,k-old=OLD-601" {
		t.Fatalf("the base caught up for k-new; the delete marker still holds: %s", shown(b))
	}
	if g.r.Overlays.Len() != 1 {
		t.Fatalf("%d overlays held, want the delete marker alone", g.r.Overlays.Len())
	}
	// Every stream at or past 621: the marker goes, the base (which no longer holds k-gone) answers.
	levelAt(630, doc("k-old", 601, "OLD-601"), doc("k-new", 620, "STREAM-620"))
	if b, _ := g.read(t, Viewer{Token: hubTok}, 0); shown(b) != "k-new=STREAM-620*,k-old=OLD-601" || g.r.Overlays.Len() != 0 {
		t.Fatalf("caught up: %s, %d overlays", shown(b), g.r.Overlays.Len())
	}
	// An overlay the streams never catch up with expires, showing the base.
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-old", Seq: 700, Body: json.RawMessage(`{"t":"ACK-700"}`)})
	if b, _ := g.read(t, Viewer{Token: hubTok}, 0); !strings.Contains(shown(b), "k-old=ACK-700*") {
		t.Fatalf("before expiry: %s", shown(b))
	}
	g.c.add(91 * time.Second)
	if b, _ := g.read(t, Viewer{Token: hubTok}, 0); !strings.Contains(shown(b), "k-old=OLD-601") {
		t.Fatalf("after expiry: %s", shown(b))
	}
}

// THE FLOOR: met by the lowest head among the streams read; for a block token also by an overlay this
// replica holds for it; a hub token's needs the heads. A stream with no head answers unfloored.
func TestTheFloorIsTheLowestHeadOrABlockTokensOwnAck(t *testing.T) {
	for _, tok := range []string{hubTok, blockTok} {
		g := newRig()
		g.viewers.set(tok, vschema, snap(800, `{"head":{"seq":800},"mask":1}`))
		g.levels.set(lvl("1"), schema, snap(790, `{}`, doc("k-f", 780, "F")))
		if _, err := g.read(t, Viewer{Token: tok}, 790); err != nil {
			t.Fatalf("%s: a floor the lowest head meets: %v", tok, err)
		}
		if _, err := g.read(t, Viewer{Token: tok}, 795); !errors.Is(err, session.ErrFloorNotMet) {
			t.Fatalf("%s: a floor above the level stream's head: %v", tok, err)
		}
		g.r.Overlays.Ack(tok, schema, session.Ack{Key: "k-w", Seq: 799, Body: json.RawMessage(`{"t":"W"}`)})
		_, err := g.read(t, Viewer{Token: tok}, 799)
		if tok == blockTok && err != nil {
			t.Fatalf("a block token's own ack meets its floor: %v", err)
		}
		if tok == hubTok && !errors.Is(err, session.ErrFloorNotMet) {
			t.Fatalf("a hub token's floor needs the heads: %v", err)
		}
		// Headless: unfloored.
		g.levels.set(lvl("1"), schema, session.Snapshot{Entities: []registry.Entity{doc("k-f", 780, "F")}})
		if _, err := g.read(t, Viewer{Token: tok}, 10_000); err != nil {
			t.Fatalf("%s: a headless stream: %v", tok, err)
		}
	}
}

// Overlays are bounded in all: past Max a write is not overlaid, and an expired one frees its room.
func TestOverlaysAreBounded(t *testing.T) {
	g := newRig()
	for i := range 6 {
		g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: fmt.Sprintf("k-%d", i), Seq: int64(900 + i), Body: json.RawMessage(`{}`)})
	}
	if g.r.Overlays.Len() != 4 {
		t.Fatalf("%d held, want the bound of 4", g.r.Overlays.Len())
	}
	// A newer ack of a key already held still replaces it at the bound.
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-0", Seq: 950, Body: json.RawMessage(`{"t":"NEWER"}`)})
	g.c.add(91 * time.Second)
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-late", Seq: 960, Body: json.RawMessage(`{}`)})
	if g.r.Overlays.Len() != 1 {
		t.Fatalf("%d held after the expiry, want 1", g.r.Overlays.Len())
	}
	// Nothing without a seq or a key, and nothing with the overlays off.
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Key: "k-noseq", Body: json.RawMessage(`{}`)})
	g.r.Overlays.Ack(hubTok, schema, session.Ack{Seq: 970, Body: json.RawMessage(`{}`)})
	(&Overlays{Max: 4}).Ack(hubTok, schema, session.Ack{Key: "k-off", Seq: 971})
	if g.r.Overlays.Len() != 1 {
		t.Fatalf("%d held, want 1", g.r.Overlays.Len())
	}
}

// THE WINDOW: Floor is the highest lowest-key of a truncated level stream read; a stream that is not
// truncated sets none. An entity without a key is ErrUnkeyed.
func TestTheWindowFloorAndUnkeyedEntities(t *testing.T) {
	g := newRig()
	g.viewers.set(hubTok, vschema, snap(1, `{"head":{"seq":1},"mask":7}`))
	g.levels.set(lvl("1"), schema, snap(2, `{"truncated":true}`, doc("k-m", 3, "M"), doc("k-z", 4, "Z")))
	g.levels.set(lvl("2"), schema, snap(5, `{"truncated":true}`, doc("k-p", 6, "P"), doc("k-q", 7, "Q")))
	g.levels.set(lvl("4"), schema, snap(8, `{"truncated":false}`, doc("k-a", 9, "A")))
	b, err := g.read(t, Viewer{Token: hubTok}, 0)
	if err != nil || b.Floor != "k-p" {
		t.Fatalf("floor %q %v", b.Floor, err)
	}
	g.levels.set(lvl("4"), schema, snap(8, `{}`, registry.Entity{URN: "u", Body: json.RawMessage(`{}`)}))
	if _, err := g.read(t, Viewer{Token: hubTok}, 0); !errors.Is(err, ErrUnkeyed) {
		t.Fatalf("an unkeyed entity: %v", err)
	}
	if _, err := g.r.Read(context.Background(), Viewer{Token: hubTok}, "Bad", "records", 1, 0); err == nil {
		t.Fatal("an invalid slug was read")
	}
}

// The level subjects and their subscription meta, and the cursors each manager accepts.
func TestLevelSubjectsMetaAndCursors(t *testing.T) {
	for subject, want := range map[string]string{
		lvl("4"): `{"level":4}`, lvl("16"): `{"level":16}`, lvl("none"): `{"level":"none"}`,
		lvl("3"): "", lvl("32"): "", "level:4": "", "civitai_user": "",
	} {
		if got := string(LevelMeta(subject)); got != want {
			t.Errorf("LevelMeta(%q) = %q, want %q", subject, got, want)
		}
	}
	for cursor, want := range map[string][2]bool{
		"b1.0a1b2c3d4e5f60718293a4b5.l1.0123456789abcdef0123456789abcdef": {true, false},
		"b1.0a1b2c3d4e5f60718293a4b5.v1.0123456789abcdef0123456789abcdef": {false, true},
		"b1.0a1b2c3d4e5f60718293a4b5.p1.empty":                            {false, false},
		"l1.0123456789abcdef0123456789abcdef":                             {false, false},
	} {
		if AcceptLevel(cursor) != want[0] || AcceptViewer(cursor) != want[1] {
			t.Errorf("%s: level %v viewer %v, want %v", cursor, AcceptLevel(cursor), AcceptViewer(cursor), want)
		}
	}
}

// ViewerLevel is the site's resolveViewerBrowsingLevel, pinned to literal answers: the ceiling
// intersected with the viewer's level, held to the selectable bits; PG for an absent ceiling, an
// absent or negative viewer level read as PG, and an empty intersection as PG.
func TestViewerLevelIsTheSitesResolution(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	cases := []struct {
		max, viewer *int64
		want        int64
	}{
		{nil, n(31), 1},
		{n(31), nil, 1},
		{n(31), n(-1), 1},
		{n(31), n(31), 31},
		{n(3), n(31), 3},
		{n(31), n(6), 6},
		{n(63), n(63), 31}, // Blocked (32) is never selectable
		{n(28), n(3), 1},   // no common level
		{n(12), n(8), 8},
		{n(0), n(0), 1},
	}
	for _, c := range cases {
		if got := ViewerLevel(c.max, c.viewer); got != c.want {
			t.Errorf("ViewerLevel(%v, %v) = %d, want %d", c.max, c.viewer, got, c.want)
		}
	}
}
