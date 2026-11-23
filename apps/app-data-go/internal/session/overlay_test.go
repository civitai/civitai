package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// READ-YOUR-WRITES and THE FLOOR (WRITES-DESIGN.md, "Read-your-writes"). Every fixture's seqs, keys,
// URNs and canary bodies are pairwise distinct, and distinct from the heads, so a read that answers
// the wrong one of them names which.

// Two tokens of the shapes the floor tells apart (exchange.KindOf): a hub token, and a block token
// (a compact JWS).
const (
	hubTok   = "civitai_hub-a"
	blockTok = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJibGstb3YifQ.c2lnLW92"
)

// overlayOpts turns read-your-writes on: an overlay lives 90 s, a floor reopens at most every 60 s.
// No stream idles out or ages out within a test's clock moves, so a sweep closes none.
func overlayOpts() Options {
	return Options{OverlayTTL: 90 * time.Second, ReopenEvery: time.Minute, IdleTTL: time.Hour, MaxAge: 2 * time.Hour}
}

func headMeta(n int64) json.RawMessage { return json.RawMessage(fmt.Sprintf(`{"head":{"seq":%d}}`, n)) }

func text(canary string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"text": canary})
	return b
}

// rec is a private record as the adapter's private feed sends it: its key and its seq beside it.
func rec(id, k string, seq int64, canary string) registry.Entity {
	return registry.Entity{URN: docURN(id), Rev: "r-" + id, Schemas: []string{schemaA}, Body: text(canary), Key: k, Seq: seq}
}

func docURN(id string) string { return "urn:apps.civitai.com:todo-app/notes/" + id }

// shown is what a read answers, as key=canary, sorted.
func shown(es []registry.Entity) string {
	out := make([]string, 0, len(es))
	for _, e := range es {
		var b struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(e.Body, &b)
		out = append(out, e.Key+"="+b.Text)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

func put(k string, seq int64, id, canary string) Ack {
	u := ""
	if id != "" {
		u = docURN(id)
	}
	return Ack{Key: k, Seq: seq, URN: u, Body: text(canary)}
}

// reads waits until a read of token answers want.
func (h *harness) reads(t *testing.T, token, want string) {
	t.Helper()
	var last string
	eventually(t, "the read to answer "+want, func() bool {
		got, err := read(t, h.m, token, schemaA)
		last = shown(got)
		if err != nil {
			last = err.Error()
		}
		return last == want
	})
}

// hubOverlays is how many overlays hubTok's open stream of schemaA holds; -1 when none is open.
// barrier pushes a record the stream applies after everything pushed before it, so once a read
// shows it, every earlier event has been applied (a check made sooner could pass before them). It
// carries no seq and a key no overlay holds, so it moves nothing else.
func barrier(t *testing.T, st *fakeStream, n string) {
	t.Helper()
	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: rec("sync-"+n, "sync-"+n, 0, "S"+n)}})
}

func (h *harness) hubOverlays() int {
	h.m.mu.Lock()
	s := h.m.sessions[key{token: tokenKey(hubTok), schema: schemaA}]
	h.m.mu.Unlock()
	if s == nil {
		return -1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.overlays)
}

func tokenKey(token string) tokenID { return sha256.Sum256([]byte(token)) }

// floorReads counts the Floor observer's outcomes.
type floorReads map[string]int

func withFloorCount(opts Options, into floorReads) Options {
	opts.Floor = func(outcome string) { into[outcome]++ }
	return opts
}

// 1. An acknowledgement applies only at or above both the overlay's and the base's seq, and above the
// stream's head. Out of order: the write at seq 31 is answered before the one at 30, and 30 never
// replaces it.
// Fails on origin/main: there is no Manager.Ack (the test does not compile); the behavioural
// assertion is `k1=ACK-31` after the late ack 30.
func TestAnAckOlderThanTheOverlayOrTheBaseIsIgnored(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20"), rec("r2", "k2", 40, "BASE-40")}
	h.o.heads[hubTok] = 25
	h.reads(t, hubTok, "k1=BASE-20,k2=BASE-40")

	h.m.Ack(hubTok, schemaA, put("k1", 31, "r1", "ACK-31"))
	h.m.Ack(hubTok, schemaA, put("k1", 30, "r1", "ACK-30"))
	// Below k2's base seq (the keyset was read after the head, so it may hold a later write).
	h.m.Ack(hubTok, schemaA, put("k2", 35, "r2", "ACK-35"))
	// At or below the head: the stream already holds it, or a later write.
	h.m.Ack(hubTok, schemaA, put("k3", 24, "r3", "ACK-24"))
	h.m.Ack(hubTok, schemaA, put("k4", 25, "r4", "ACK-25"))
	// No seq: nothing orders it against the stream.
	h.m.Ack(hubTok, schemaA, put("k5", 0, "r5", "ACK-0"))
	h.reads(t, hubTok, "k1=ACK-31,k2=BASE-40")

	// An ack equal to the overlay's seq is the same write: applied.
	h.m.Ack(hubTok, schemaA, put("k1", 31, "r1", "ACK-31-AGAIN"))
	h.reads(t, hubTok, "k1=ACK-31-AGAIN,k2=BASE-40")
}

// 2. An overlay is dropped once the stream shows its write: an upsert of its key at a seq at or above
// it, or the stream's head reaching it. An older upsert, or one without a seq, replaces the base
// underneath and leaves the overlay.
// Fails on origin/main: no Manager.Ack (does not compile); the behavioural assertion is
// `k1=STREAM-31` once the stream's upsert at 31 arrives.
func TestAnOverlayIsDroppedOnceTheStreamCatchesUp(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20"), rec("r2", "k2", 21, "BASE-21")}
	h.o.heads[hubTok] = 25
	h.reads(t, hubTok, "k1=BASE-20,k2=BASE-21")
	h.m.Ack(hubTok, schemaA, put("k1", 31, "r1", "ACK-31"))
	h.m.Ack(hubTok, schemaA, put("k2", 33, "r2", "ACK-33"))
	h.reads(t, hubTok, "k1=ACK-31,k2=ACK-33")

	st := h.o.last(t, hubTok)
	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: rec("r1", "k1", 30, "STREAM-30")}})
	noSeq := rec("r1", "k1", 0, "STREAM-NOSEQ")
	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: noSeq}})
	// A Progress with no head moves nothing.
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor}})
	barrier(t, st, "1")
	h.reads(t, hubTok, "k1=ACK-31,k2=ACK-33,sync-1=S1")
	if n := h.hubOverlays(); n != 2 {
		t.Fatalf("%d overlays after older and unordered upserts, want 2", n)
	}

	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: rec("r1", "k1", 31, "STREAM-31")}})
	h.reads(t, hubTok, "k1=STREAM-31,k2=ACK-33,sync-1=S1")

	// The head alone: k2's base is still the old record, so the read now shows it (the rule, in
	// isolation; the adapter sends a poll's upserts before its head).
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor, Meta: headMeta(32)}})
	barrier(t, st, "2")
	h.reads(t, hubTok, "k1=STREAM-31,k2=ACK-33,sync-1=S1,sync-2=S2")
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor, Meta: headMeta(33)}})
	h.reads(t, hubTok, "k1=STREAM-31,k2=BASE-21,sync-1=S1,sync-2=S2")
	if n := h.hubOverlays(); n != 0 {
		t.Fatalf("%d overlays once the stream caught up, want 0", n)
	}
	// Once the head is past it, a late ack is not applied.
	h.m.Ack(hubTok, schemaA, put("k2", 33, "r2", "ACK-33-LATE"))
	h.reads(t, hubTok, "k1=STREAM-31,k2=BASE-21,sync-1=S1,sync-2=S2")
}

// 3. An overlay its stream never caught up with is dropped OverlayTTL after it was set, showing the
// base again, never nothing; a record the base never held then goes until the stream sends it. On a
// read, and on a sweep.
// Fails on origin/main: no Manager.Ack (does not compile); the behavioural assertion is
// `k1=BASE-20` at 91 s.
func TestAnOverlayExpiresShowingTheBase(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.o.heads[hubTok] = 25
	h.reads(t, hubTok, "k1=BASE-20")
	h.m.Ack(hubTok, schemaA, put("k1", 31, "r1", "ACK-31"))
	h.m.Ack(hubTok, schemaA, put("k9", 32, "r9", "ACK-NEW"))
	h.c.add(89 * time.Second)
	h.reads(t, hubTok, "k1=ACK-31,k9=ACK-NEW")
	h.c.add(2 * time.Second)
	h.reads(t, hubTok, "k1=BASE-20")

	// The sweep drops one no read looked at.
	h.m.Ack(hubTok, schemaA, put("k8", 40, "r8", "ACK-SWEPT"))
	if n := h.hubOverlays(); n != 1 {
		t.Fatalf("%d overlays, want 1", n)
	}
	h.c.add(90 * time.Second)
	h.m.Sweep()
	if n := h.hubOverlays(); n != 0 {
		t.Fatalf("%d overlays after the sweep, want 0", n)
	}
}

// 4. A delete leaves a delete marker at its tombstone's seq: the record is gone from reads at once. A
// stream Delete of the marker's own URN drops it (and the base); one of another URN (the old row of a
// re-created key) leaves it. A Delete of a written record's URN (a moderator hide after the write)
// wins over its overlay.
// Fails on origin/main: no Manager.Ack (does not compile); the behavioural assertion is `k2=BASE-2`
// alone right after the delete's ack.
func TestADeleteLeavesAMarkerUntilTheStreamDeletesItsURN(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-1"), rec("r2", "k2", 21, "BASE-2")}
	h.o.heads[hubTok] = 25
	h.reads(t, hubTok, "k1=BASE-1,k2=BASE-2")
	h.m.Ack(hubTok, schemaA, Ack{Key: "k1", Seq: 31, Deleted: true})
	h.reads(t, hubTok, "k2=BASE-2")

	st := h.o.last(t, hubTok)
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: docURN("r1-old-row")}})
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor, Meta: headMeta(26)}})
	barrier(t, st, "1")
	h.reads(t, hubTok, "k2=BASE-2,sync-1=S1")
	if n := h.hubOverlays(); n != 1 {
		t.Fatalf("%d overlays after a Delete of another URN, want the marker", n)
	}
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: docURN("r1")}})
	eventually(t, "the marker to drop", func() bool { return h.hubOverlays() == 0 })
	h.reads(t, hubTok, "k2=BASE-2,sync-1=S1")

	// A written record, then a moderator's hide of it.
	h.m.Ack(hubTok, schemaA, put("k3", 32, "r3", "ACK-3"))
	h.reads(t, hubTok, "k2=BASE-2,k3=ACK-3,sync-1=S1")
	st.push(t, step{ev: registry.Event{Type: registry.Upsert, Entity: registry.Entity{URN: docURN("r3")}}})
	h.reads(t, hubTok, "k2=BASE-2,sync-1=S1")

	// A delete of a key held only as an overlay keeps that overlay's URN, so the stream's Delete of it
	// drops the marker; one of a key nothing holds is a marker with no URN.
	h.m.Ack(hubTok, schemaA, put("k4", 33, "r4", "ACK-4"))
	h.m.Ack(hubTok, schemaA, Ack{Key: "k4", Seq: 34, Deleted: true})
	h.m.Ack(hubTok, schemaA, Ack{Key: "k5", Seq: 35, Deleted: true})
	h.reads(t, hubTok, "k2=BASE-2,sync-1=S1")
	if n := h.hubOverlays(); n != 2 {
		t.Fatalf("%d overlays, want the k4 and k5 markers", n)
	}
	st.push(t, step{ev: registry.Event{Type: registry.Delete, URN: docURN("r4")}})
	eventually(t, "the k4 marker to drop", func() bool { return h.hubOverlays() == 1 })
}

// 5. For a block token, a floor is met by an acknowledgement this replica holds for the token's
// stream of the collection read: no reopen. One held for another collection is no credit, and an
// expired one is none either.
// Fails on origin/main: no Manager.ReadAt or Ack (does not compile); the behavioural assertion is
// one subscription for the floor read. The cross-collection assertion (ErrFloorNotMet, 3 opened)
// fails on 3c012af11b, where an ack in any collection of the app counted.
func TestABlockTokensFloorIsMetByItsOwnAckWithoutAReopen(t *testing.T) {
	floors := floorReads{}
	h := newHarness(t, withFloorCount(overlayOpts(), floors))
	h.o.records[blockTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.o.heads[blockTok] = 30
	h.reads(t, blockTok, "k1=BASE-20")
	h.m.Ack(blockTok, schemaA, put("k1", 31, "r1", "ACK-31"))

	got, err := h.m.ReadAt(context.Background(), blockTok, schemaA, 31)
	if err != nil || shown(got) != "k1=ACK-31" || h.o.opens(blockTok) != 1 {
		t.Fatalf("%q, %v, %d opened; want k1=ACK-31 from the one stream", shown(got), err, h.o.opens(blockTok))
	}
	if _, err := read(t, h.m, blockTok, schemaB); err != nil {
		t.Fatal(err)
	}
	h.m.Ack(blockTok, schemaB, Ack{Key: "list-1", Seq: 36, URN: "urn:apps.civitai.com:todo-app/lists/l1", Body: text("LIST-36")})
	if _, err := h.m.ReadAt(context.Background(), blockTok, schemaA, 36); !errors.Is(err, ErrFloorNotMet) || h.o.opens(blockTok) != 3 {
		t.Fatalf("%v, %d opened; want ErrFloorNotMet after one reopen: the lists ack is no credit for notes", err, h.o.opens(blockTok))
	}
	h.c.add(91 * time.Second)
	if _, err := h.m.ReadAt(context.Background(), blockTok, schemaA, 31); !errors.Is(err, ErrFloorNotMet) {
		t.Fatalf("%v; want ErrFloorNotMet once the ack expired", err)
	}
	if len(floors) != 1 || floors[FloorStillBehind] != 2 {
		t.Fatalf("floor outcomes %v", floors)
	}
}

// A stream that names no head (one the origin refused, or that holds nothing) cannot be compared
// with a floor, so a floored read of it is answered as an unfloored one: no reopen, no 503.
// Fails on 3c012af11b: every such read was ErrFloorNotMet (`err != nil`).
func TestAHeadlessStreamAnswersAFlooredReadUnfloored(t *testing.T) {
	floors := floorReads{}
	h := newHarness(t, withFloorCount(overlayOpts(), floors))
	for _, tok := range []string{hubTok, blockTok} {
		h.o.records[tok] = []registry.Entity{rec("r-"+tok[:4], "k1", 20, "HEADLESS")}
		got, err := h.m.ReadAt(context.Background(), tok, schemaA, 5)
		if err != nil || shown(got) != "k1=HEADLESS" || h.o.opens(tok) != 1 {
			t.Fatalf("%s: %q, %v, %d opened; want the unfloored answer", tok, shown(got), err, h.o.opens(tok))
		}
	}
	if len(floors) != 0 {
		t.Fatalf("floor outcomes %v; want none counted", floors)
	}
}

// A stream that holds nothing and names no head answers empty whatever is overlaid, so the caller
// still reads REST; one that names a head shows the overlay.
// Fails on 3c012af11b: the refused stream answered the overlay record (`k1=ACK-5`).
func TestARefusedStreamStaysEmptyUnderAnAck(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.reads(t, hubTok, "")
	h.m.Ack(hubTok, schemaA, put("k1", 5, "r1", "ACK-5"))
	h.reads(t, hubTok, "")
	// Positive control: the same, on a stream that names a head.
	h.o.heads[blockTok] = 3
	h.reads(t, blockTok, "")
	h.m.Ack(blockTok, schemaA, put("k1", 6, "r1", "ACK-6"))
	h.reads(t, blockTok, "k1=ACK-6")
}

// The manager's size counts overlays: they are bounded apart from the records.
// Fails on 3c012af11b: Stats counted records only (Records 1, not 2).
func TestStatsCountOverlays(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.reads(t, hubTok, "k1=BASE-20")
	before := h.m.Stats()
	h.m.Ack(hubTok, schemaA, put("k2", 31, "r2", "ACK-31"))
	after := h.m.Stats()
	if before.Records != 1 || after.Records != 2 || after.Bytes <= before.Bytes {
		t.Fatalf("before %+v, after %+v", before, after)
	}
}

// With the writes off, a head that went back is main's failure: an adapter `cursor_expired` closes
// the stream as an error and cools the key down, and a head below the one held is not read at all.
// Fails on 3c012af11b: there the end closed `cursor_expired` with no cooldown whatever the flag.
func TestWithTheWritesOffAHeadThatWentBackIsAFailureAsBefore(t *testing.T) {
	h := newHarness(t, Options{})
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-off1", "OFF1")}
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.o.last(t, "tok-a").push(t, step{err: &registry.Error{Code: registry.CursorExpired}})
	eventually(t, "the stream to close", func() bool { return h.closedFor(CloseError) == 1 })
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrCoolingDown) || h.closedFor(CloseCursorExpired) != 0 {
		t.Fatalf("%v, closed cursor_expired %d; want ErrCoolingDown", err, h.closedFor(CloseCursorExpired))
	}

	h.o.records["tok-b"] = []registry.Entity{rec("rb", "kb", 50, "OFF-B")}
	h.o.heads["tok-b"] = 40
	if _, err := read(t, h.m, "tok-b", schemaA); err != nil {
		t.Fatal(err)
	}
	st := h.o.last(t, "tok-b")
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor, Meta: headMeta(39)}})
	barrier(t, st, "1")
	eventually(t, "the barrier", func() bool {
		got, err := read(t, h.m, "tok-b", schemaA)
		return err == nil && shown(got) == "kb=OFF-B,sync-1=S1"
	})
	if h.o.opens("tok-b") != 1 || h.closedFor(CloseCursorExpired) != 0 {
		t.Fatalf("%d opened, %d closed cursor_expired; want the stream kept", h.o.opens("tok-b"), h.closedFor(CloseCursorExpired))
	}
}

// 6. A floor neither the head nor (for a block token) an ack meets reopens the stream ONCE per poll
// interval: still behind, the read is ErrFloorNotMet; another read in the interval is ErrFloorNotMet
// with no reopen; after the interval a reopen whose snapshot's head meets it is answered. Reads with
// no floor are answered throughout.
// Fails on origin/main: no Manager.ReadAt (does not compile); the behavioural assertion is the second
// read's ErrFloorNotMet with still 2 subscriptions.
func TestAFloorNotMetReopensOnceThenAnswersFloorNotMet(t *testing.T) {
	floors := floorReads{}
	h := newHarness(t, withFloorCount(overlayOpts(), floors))
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.o.heads[hubTok] = 30
	h.reads(t, hubTok, "k1=BASE-20")

	if got, err := h.m.ReadAt(context.Background(), hubTok, schemaA, 30); err != nil || shown(got) != "k1=BASE-20" || h.o.opens(hubTok) != 1 {
		t.Fatalf("a floor the head meets: %q, %v, %d opened", shown(got), err, h.o.opens(hubTok))
	}
	if _, err := h.m.ReadAt(context.Background(), hubTok, schemaA, 31); !errors.Is(err, ErrFloorNotMet) || h.o.opens(hubTok) != 2 || h.closedFor(CloseFloorReopen) != 1 {
		t.Fatalf("first: %v, %d opened, %d closed to reopen; want ErrFloorNotMet after one reopen", err, h.o.opens(hubTok), h.closedFor(CloseFloorReopen))
	}
	h.c.add(59 * time.Second)
	if _, err := h.m.ReadAt(context.Background(), hubTok, schemaA, 31); !errors.Is(err, ErrFloorNotMet) || h.o.opens(hubTok) != 2 {
		t.Fatalf("second: %v, %d opened; want ErrFloorNotMet and no second reopen", err, h.o.opens(hubTok))
	}
	if got, err := read(t, h.m, hubTok, schemaA); err != nil || shown(got) != "k1=BASE-20" {
		t.Fatalf("a read with no floor: %q, %v", shown(got), err)
	}
	h.o.mu.Lock()
	h.o.heads[hubTok] = 31
	h.o.mu.Unlock()
	h.c.add(2 * time.Second)
	h.m.Sweep() // forgets the spent reopen
	if got, err := h.m.ReadAt(context.Background(), hubTok, schemaA, 31); err != nil || shown(got) != "k1=BASE-20" || h.o.opens(hubTok) != 3 {
		t.Fatalf("after the interval: %q, %v, %d opened; want the reopen's snapshot", shown(got), err, h.o.opens(hubTok))
	}
	if floors[FloorStillBehind] != 1 || floors[FloorSpent] != 1 || floors[FloorMet] != 1 {
		t.Fatalf("floor outcomes %v", floors)
	}
	if h.closedFor(CloseFloorReopen) != 2 || h.closedFor(CloseError) != 0 {
		t.Fatalf("closed floor_reopen %d, error %d", h.closedFor(CloseFloorReopen), h.closedFor(CloseError))
	}
}

// 7. A hub token's floor is the head alone: its own acknowledgement, which a block token's floor would
// count, does not meet it, and the read reopens. The overlay is carried across the reopen.
// Fails on origin/main: no Manager.ReadAt or Ack (does not compile); the behavioural assertion is the
// hub read's ErrFloorNotMet after 2 subscriptions, beside the block token's 1.
func TestAHubTokensFloorIsTheHeadAlone(t *testing.T) {
	h := newHarness(t, overlayOpts())
	for _, tok := range []string{hubTok, blockTok} {
		h.o.records[tok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
		h.o.heads[tok] = 30
		h.reads(t, tok, "k1=BASE-20")
		h.m.Ack(tok, schemaA, put("k1", 31, "r1", "ACK-31"))
	}
	if _, err := h.m.ReadAt(context.Background(), blockTok, schemaA, 31); err != nil || h.o.opens(blockTok) != 1 {
		t.Fatalf("block: %v, %d opened; want met by its own ack", err, h.o.opens(blockTok))
	}
	if _, err := h.m.ReadAt(context.Background(), hubTok, schemaA, 31); !errors.Is(err, ErrFloorNotMet) || h.o.opens(hubTok) != 2 {
		t.Fatalf("hub: %v, %d opened; want ErrFloorNotMet after a reopen", err, h.o.opens(hubTok))
	}
	// Carried: the reopened stream (head 30, its snapshot without the write) still shows it.
	h.reads(t, hubTok, "k1=ACK-31")
}

// 8a. A head that went back, writes on: the adapter ends the stream `cursor_expired`
// (private-feed.ts). That is not a failure: no cooldown, and the next read opens a fresh stream.
// Fails on origin/main: the end is classified as an error and cools the key down, so the read after
// it is ErrCoolingDown (`err != nil`). Uses only what main has.
func TestACursorExpiredEndReopensWithoutACooldown(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records["tok-a"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-ce1", "CE1")}
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	h.o.last(t, "tok-a").push(t, step{err: &registry.Error{Code: registry.CursorExpired, Message: "the namespace seq went back"}})
	eventually(t, "the stream to close", func() bool { return h.m.Stats().Streams == 0 })
	got, err := read(t, h.m, "tok-a", schemaA)
	if err != nil || urns(got) != "urn:apps.civitai.com:todo-app/notes/r-ce1" || h.o.opens("tok-a") != 2 {
		t.Fatalf("after cursor_expired: %q, %v, %d opened; want a fresh stream", urns(got), err, h.o.opens("tok-a"))
	}
}

// 8b. A head below the one held is the same: the stream closes `cursor_expired`, its overlays
// (numbered in the old order) are dropped, and the next read opens a fresh stream. A read waiting on
// a stream that ends so opens the fresh one itself, once.
// Fails on origin/main: no head is read there and no Manager.Ack (does not compile); the behavioural
// assertion is the `cursor_expired` close.
func TestAHeadThatWentBackReopensAFreshStream(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.o.heads[hubTok] = 40
	h.reads(t, hubTok, "k1=BASE-20")
	h.m.Ack(hubTok, schemaA, put("k2", 41, "r2", "ACK-41"))
	h.reads(t, hubTok, "k1=BASE-20,k2=ACK-41")
	h.o.last(t, hubTok).push(t, step{ev: registry.Event{Type: registry.Progress, Cursor: liveCursor, Meta: headMeta(39)}})
	eventually(t, "the stream to close", func() bool { return h.closedFor(CloseCursorExpired) == 1 })
	h.o.mu.Lock()
	h.o.heads[hubTok] = 3
	h.o.mu.Unlock()
	h.reads(t, hubTok, "k1=BASE-20")
	if n := h.o.opens(hubTok); n != 2 {
		t.Fatalf("%d opened, want 2", n)
	}

	// A read waiting on a stream short of Live when it ends so: it opens the fresh one and is answered.
	h.o.mu.Lock()
	h.o.records["tok-wait"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/r-w1", "W1")}
	h.o.noLive["tok-wait"] = true
	h.o.mu.Unlock()
	type result struct {
		es  []registry.Entity
		err error
	}
	done := make(chan result, 1)
	go func() {
		es, err := read(t, h.m, "tok-wait", schemaA)
		done <- result{es, err}
	}()
	eventually(t, "the first stream to open", func() bool { return h.o.opens("tok-wait") == 1 })
	h.o.mu.Lock()
	h.o.noLive["tok-wait"] = false
	h.o.mu.Unlock()
	h.o.last(t, "tok-wait").push(t, step{err: &registry.Error{Code: registry.CursorExpired}})
	r := <-done
	if r.err != nil || urns(r.es) != "urn:apps.civitai.com:todo-app/notes/r-w1" || h.o.opens("tok-wait") != 2 {
		t.Fatalf("%q, %v, %d opened; want the fresh stream's answer", urns(r.es), r.err, h.o.opens("tok-wait"))
	}
}

// A reopen whose fresh stream does not reach Live within the read's deadline is that read's error,
// counted still behind.
func TestAFloorReopenThatDoesNotGoLiveIsTheReadsError(t *testing.T) {
	floors := floorReads{}
	h := newHarness(t, withFloorCount(overlayOpts(), floors))
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.o.heads[hubTok] = 30
	h.reads(t, hubTok, "k1=BASE-20")
	h.o.mu.Lock()
	h.o.noLive[hubTok] = true
	h.o.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := h.m.ReadAt(ctx, hubTok, schemaA, 31); !errors.Is(err, ErrNotLive) || floors[FloorStillBehind] != 1 {
		t.Fatalf("%v, %v; want ErrNotLive, counted still behind", err, floors)
	}
}

// Acknowledgements are bounded as the stream is, applied only to an open stream, and only with the
// writes on; Overlaid counts each applied, by kind.
func TestAcksAreBoundedAndNeedAnOpenStream(t *testing.T) {
	kinds := map[string]int{}
	opts := overlayOpts()
	opts.MaxRecords, opts.MaxBytes = 2, 1<<20
	opts.Overlaid = func(kind string) { kinds[kind]++ }
	h := newHarness(t, opts)
	h.o.heads[hubTok] = 5
	// No stream open: nothing is held, and the read that opens one is the snapshot.
	h.m.Ack(hubTok, schemaA, put("k0", 6, "r0", "NO-STREAM"))
	h.reads(t, hubTok, "")
	h.m.Ack(hubTok, schemaA, put("k1", 11, "r1", "A1"))
	h.m.Ack(hubTok, schemaA, Ack{Key: "k2", Seq: 12, Deleted: true})
	h.m.Ack(hubTok, schemaA, put("k3", 13, "r3", "OVER-COUNT"))
	h.m.Ack(hubTok, schemaA, put("", 14, "r4", "NO-KEY"))
	// Replacing a held key is within the bound.
	h.m.Ack(hubTok, schemaA, put("k1", 15, "r1", "A1-AGAIN"))
	h.reads(t, hubTok, "k1=A1-AGAIN")
	if kinds[OverlayRecord] != 2 || kinds[OverlayDeleteMarker] != 1 {
		t.Fatalf("overlaid %v", kinds)
	}

	small := overlayOpts()
	small.MaxBytes = 64 << 10
	hb := newHarness(t, small)
	hb.reads(t, hubTok, "")
	big := json.RawMessage(`{"text":"` + strings.Repeat("x", 70<<10) + `"}`)
	hb.m.Ack(hubTok, schemaA, Ack{Key: "big", Seq: 9, Body: big})
	hb.reads(t, hubTok, "")

	off := newHarness(t, Options{})
	off.reads(t, hubTok, "")
	off.m.Ack(hubTok, schemaA, put("k1", 11, "r1", "WRITES-OFF"))
	off.reads(t, hubTok, "")
}

// An overlay with no URN (a row written before record ids) sorts before every URN, and two records
// of one URN are ordered by key; a closed stream's overlays are gone.
func TestTheViewIsOrderedAndAnEndedStreamTakesNoAck(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.records[hubTok] = []registry.Entity{rec("r1", "k1", 20, "BASE-20")}
	h.reads(t, hubTok, "k1=BASE-20")
	h.m.Ack(hubTok, schemaA, put("kb", 31, "", "NO-URN-B"))
	h.m.Ack(hubTok, schemaA, put("ka", 32, "", "NO-URN-A"))
	got, err := read(t, h.m, hubTok, schemaA)
	if err != nil || len(got) != 3 || got[0].Key != "ka" || got[1].Key != "kb" || got[2].Key != "k1" ||
		got[0].Rev != "seq.32" || got[0].Seq != 32 {
		t.Fatalf("%+v, %v", got, err)
	}
	h.m.mu.Lock()
	s := h.m.sessions[key{token: tokenKey(hubTok), schema: schemaA}]
	h.m.mu.Unlock()
	h.m.end(s, CloseIdle, ErrClosed)
	if _, ok := s.ack(put("kc", 40, "", "AFTER-END"), time.Now(), 10, 1<<20); ok {
		t.Fatal("an ended stream took an ack")
	}
}

// The head a live or progress event names, as the adapter's private feed writes it; anything else is
// no head, never an error.
func TestHeadOfReadsOnlyTheAdaptersHead(t *testing.T) {
	for meta, want := range map[string]int64{`{"head":{"seq":0}}`: 0, `{"head":{"seq":9007199254740991}}`: 9007199254740991, `{"head":{"seq":7},"other":1}`: 7} {
		if got, ok := headOf(json.RawMessage(meta)); !ok || got != want {
			t.Errorf("%s: %d, %v; want %d", meta, got, ok, want)
		}
	}
	for _, meta := range []string{"", "null", `[]`, `{}`, `{"head":null}`, `{"head":{}}`, `{"head":{"seq":"7"}}`, `{"head":{"seq":-1}}`, `{"head":{"seq":1.5}}`} {
		if got, ok := headOf(json.RawMessage(meta)); ok {
			t.Errorf("%q: %d; want no head", meta, got)
		}
	}
}
