package session

import "testing"

// Release closes a stream only one read used, with no cooldown (it reopens on the next read), and
// keeps one a second read used, and every other token's and schema's.
func TestReleaseClosesOnlyAStreamOneReadUsed(t *testing.T) {
	h := newHarness(t, Options{})
	for _, tok := range []string{"tok-one", "tok-two"} {
		if _, err := read(t, h.m, tok, schemaA); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := read(t, h.m, "tok-two", schemaA); err != nil {
		t.Fatal(err)
	}
	if _, err := read(t, h.m, "tok-one", schemaB); err != nil {
		t.Fatal(err)
	}
	h.m.Release("tok-one", schemaA)
	h.m.Release("tok-two", schemaA)
	h.m.Release("tok-none", schemaA)
	if n, c := h.m.Stats().Streams, h.closedFor(CloseReleased); n != 2 || c != 1 {
		t.Fatalf("after the releases: %d streams open, %d released; want 2 open (tok-two's, read twice, and tok-one's other schema), 1 released", n, c)
	}
	opened := h.o.opened.Load()
	if _, err := read(t, h.m, "tok-one", schemaA); err != nil {
		t.Fatalf("a released key reopens at once (no cooldown): %v", err)
	}
	if h.o.opened.Load() != opened+1 {
		t.Fatal("the read after a release did not reopen the stream")
	}
}
