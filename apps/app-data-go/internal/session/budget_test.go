package session

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// 🔴 One budget over two managers: the streams they hold together never pass its stream count, nor
// the bytes their streams reserve its byte bound, whatever each manager's own MaxStreams admits; and
// a closed stream gives its share back.
func TestABudgetSharedByTwoManagersCapsTheirStreamsTogether(t *testing.T) {
	b := NewBudget(3, 1_000)
	a := newHarness(t, Options{MaxStreams: 10, Budget: b, Reserve: 100})
	c := newHarness(t, Options{MaxStreams: 10, Budget: b, Reserve: 100})
	for _, tok := range []string{"tok-1", "tok-2"} {
		if _, err := read(t, a.m, tok, schemaA); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := read(t, c.m, "tok-3", schemaA); err != nil {
		t.Fatal(err)
	}
	if n, bytes := b.InUse(); n != 3 || bytes != 300 {
		t.Fatalf("in use %d streams, %d bytes; want 3, 300", n, bytes)
	}
	// Both managers are under their own cap (10); the shared one (3) refuses either.
	if _, err := read(t, c.m, "tok-4", schemaA); !errors.Is(err, ErrCapacity) {
		t.Fatalf("over the budget's streams: %v, want ErrCapacity", err)
	}
	if _, err := read(t, a.m, "tok-5", schemaA); !errors.Is(err, ErrCapacity) {
		t.Fatalf("over the budget's streams, the other manager: %v, want ErrCapacity", err)
	}
	if c.o.opens("tok-4")+a.o.opens("tok-5") != 0 {
		t.Fatal("a read refused by the budget opened a stream")
	}
	// A stream closed in one manager frees a slot for the other.
	a.c.add(2 * time.Minute)
	a.m.Sweep()
	if n, _ := b.InUse(); n != 1 {
		t.Fatalf("after two idle closes %d in use, want 1", n)
	}
	if _, err := read(t, c.m, "tok-4", schemaA); err != nil {
		t.Fatalf("after the other manager's closes: %v", err)
	}
}

// The budget's bytes bind apart from its stream count: a manager whose streams reserve more takes
// fewer of them.
func TestABudgetsBytesBindBeforeItsStreamCount(t *testing.T) {
	b := NewBudget(100, 250)
	h := newHarness(t, Options{MaxStreams: 10, Budget: b, Reserve: 100})
	for _, tok := range []string{"tok-1", "tok-2"} {
		if _, err := read(t, h.m, tok, schemaA); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := read(t, h.m, "tok-3", schemaA); !errors.Is(err, ErrCapacity) {
		t.Fatalf("a third 100-byte reservation in 250: %v, want ErrCapacity", err)
	}
	// Closed streams give their shares back.
	h.m.Close()
	if n, bytes := b.InUse(); n != 0 || bytes != 0 {
		t.Fatalf("after Close %d streams, %d bytes in use; want none", n, bytes)
	}
}

// 🔴 The registry refusing the token a stream was opened with calls InvalidToken (the level manager's
// token is the service's own, re-minted then); no other ending does.
func TestARefusedTokenCallsInvalidToken(t *testing.T) {
	calls := 0
	h := newHarness(t, Options{InvalidToken: func() { calls++ }})
	h.o.refuse["tok-a"] = &registry.Error{Code: registry.InvalidToken, Status: 401}
	if _, err := read(t, h.m, "tok-a", schemaA); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("got %v, want ErrInvalidToken", err)
	}
	if calls != 1 {
		t.Fatalf("InvalidToken called %d times, want 1", calls)
	}
	h.o.refuse["tok-b"] = &registry.Error{Code: registry.Unavailable, Status: 503}
	if _, err := read(t, h.m, "tok-b", schemaA); errors.Is(err, ErrInvalidToken) || err == nil {
		t.Fatalf("an unavailable registry: %v", err)
	}
	if calls != 1 {
		t.Fatalf("an unavailable registry called InvalidToken (%d calls)", calls)
	}
}

// MaxOverlayBytes bounds a stream's overlays apart from MaxBytes: an ack that would pass it is not
// overlaid, while the records' bound is untouched.
func TestOverlaysAreBoundedByMaxOverlayBytes(t *testing.T) {
	h := newHarness(t, Options{MaxBytes: 1 << 20, MaxOverlayBytes: 300, OverlayTTL: time.Minute, ReopenEvery: time.Minute})
	h.o.heads["tok-a"] = 5
	if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
		t.Fatal(err)
	}
	body := func(n int) json.RawMessage { return json.RawMessage(`"` + strings.Repeat("x", n) + `"`) }
	h.m.Ack("tok-a", schemaA, Ack{Key: "k1", Seq: 6, URN: "urn:a:1", Body: body(200)})
	h.m.Ack("tok-a", schemaA, Ack{Key: "k2", Seq: 7, URN: "urn:a:2", Body: body(200)})
	ents, err := read(t, h.m, "tok-a", schemaA)
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(ents))
	for _, e := range ents {
		keys = append(keys, e.Key)
	}
	if strings.Join(keys, ",") != "k1" {
		t.Fatalf("overlaid %v, want only k1 (k2 would pass the 300-byte overlay bound)", keys)
	}
}
