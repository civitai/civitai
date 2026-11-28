package tracker

import (
	"strings"
	"testing"
)

// Reserve holds room without queuing: refused beyond the room (nothing held, nothing counted), held
// room is out of reach of Enqueue and EnqueueAll, Commit queues the rows in order, Cancel gives the
// room back, and either ends the reservation (a second call does nothing).
func TestReserve(t *testing.T) {
	var recorded []string
	cl := idleClient(5, func(table, result string) { recorded = append(recorded, table+":"+result) })
	if !cl.Enqueue(rows("pre", 1)[0]) {
		t.Fatal("prefill refused")
	}
	if _, ok := cl.Reserve(5); ok {
		t.Fatal("reserved past the room")
	}
	r, ok := cl.Reserve(3)
	if !ok {
		t.Fatal("room for 3 refused")
	}
	// 1 queued + 3 held: one slot left.
	if cl.EnqueueAll(rows("all", 2)) {
		t.Fatal("EnqueueAll took held room")
	}
	if !cl.Enqueue(rows("one", 1)[0]) {
		t.Fatal("the last free slot refused")
	}
	if cl.Enqueue(rows("two", 1)[0]) {
		t.Fatal("Enqueue took held room")
	}
	if len(recorded) != 1 || recorded[0] != "search:dropped" {
		t.Fatalf("recorded %v", recorded)
	}
	if _, ok := cl.Reserve(1); ok {
		t.Fatal("a second reservation past the room")
	}
	r.Commit(rows("res", 3))
	r.Commit(rows("again", 3))
	r.Cancel()
	if cl.Depth() != 5 || cl.reserved != 0 {
		t.Fatalf("depth %d, reserved %d", cl.Depth(), cl.reserved)
	}
	var bodies []string
	for cl.Depth() > 0 {
		bodies = append(bodies, string((<-cl.queue).Body))
	}
	if got := strings.Join(bodies, ","); got != "pre-0,one-0,res-0,res-1,res-2" {
		t.Fatalf("queued %s", got)
	}
	// Cancel gives the room back; a Commit after it does nothing.
	r2, ok := cl.Reserve(5)
	if !ok {
		t.Fatal("the empty queue refused 5")
	}
	r2.Cancel()
	r2.Commit(rows("late", 5))
	if cl.reserved != 0 || cl.Depth() != 0 {
		t.Fatalf("after cancel: reserved %d, depth %d", cl.reserved, cl.Depth())
	}
	// Committing more rows than held drops the extra; a commit after Close drops them all.
	r3, _ := cl.Reserve(1)
	recorded = nil
	r3.Commit(rows("x", 2))
	if cl.Depth() != 1 || len(recorded) != 1 {
		t.Fatalf("over-commit: depth %d, recorded %v", cl.Depth(), recorded)
	}
	<-cl.queue
	r4, _ := cl.Reserve(2)
	cl.closed = true
	recorded = nil
	r4.Commit(rows("y", 2))
	if cl.Depth() != 0 || len(recorded) != 2 || cl.reserved != 0 {
		t.Fatalf("after close: depth %d, recorded %v, reserved %d", cl.Depth(), recorded, cl.reserved)
	}
	if _, ok := cl.Reserve(1); ok {
		t.Fatal("reserved on a closed client")
	}
}
