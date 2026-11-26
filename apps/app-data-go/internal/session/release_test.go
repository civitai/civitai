package session

import (
	"context"
	"testing"
)

// A read's Lease is on the stream it OPENED, and its Release closes that stream only while no other
// read has taken it: a read that took a stream already open holds no lease, a stream another read
// took is kept, and a released key reopens at once (no cooldown).
func TestALeaseReleasesOnlyAStreamItsReadOpenedAndNoOtherTook(t *testing.T) {
	h := newHarness(t, Options{})
	ctx := context.Background()
	alone, err := h.m.View(ctx, "tok-one", schemaA, 0)
	if err != nil || alone.Lease == (Lease{}) {
		t.Fatalf("the opening read: lease %v, %v; want a lease", alone.Lease, err)
	}
	shared, err := h.m.View(ctx, "tok-two", schemaA, 0)
	if err != nil || shared.Lease == (Lease{}) {
		t.Fatalf("tok-two's opening read: %v", err)
	}
	joined, err := h.m.View(ctx, "tok-two", schemaA, 0)
	if err != nil || joined.Lease != (Lease{}) {
		t.Fatalf("a read of an open stream: lease %v, %v; want none", joined.Lease, err)
	}
	if _, err := h.m.View(ctx, "tok-one", schemaB, 0); err != nil {
		t.Fatal(err)
	}
	alone.Lease.Release()
	shared.Lease.Release()
	joined.Lease.Release()
	alone.Lease.Release() // a second release of a closed stream does nothing
	if n, c := h.m.Stats().Streams, h.closedFor(CloseReleased); n != 2 || c != 1 {
		t.Fatalf("after the releases: %d streams open, %d released; want 2 open (tok-two's, taken twice, and tok-one's other schema), 1 released", n, c)
	}
	opened := h.o.opened.Load()
	again, err := h.m.View(ctx, "tok-one", schemaA, 0)
	if err != nil || h.o.opened.Load() != opened+1 || again.Lease == (Lease{}) {
		t.Fatalf("a released key reopens at once (no cooldown), leased to its new opener: %v", err)
	}
}
