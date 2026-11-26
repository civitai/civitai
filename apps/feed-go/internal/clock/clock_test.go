package clock

import (
	"testing"
	"time"
)

func TestNowIsTheWallClockUnlessFrozen(t *testing.T) {
	t.Cleanup(Reset)
	before := time.Now()
	got := Now()
	if got.Before(before) || got.After(time.Now()) || Frozen() {
		t.Fatalf("unfrozen Now = %v (frozen %v), want the wall clock", got, Frozen())
	}
	at := time.Date(2025, 2, 3, 4, 5, 6, 0, time.UTC)
	Freeze(at)
	if !Frozen() {
		t.Fatal("Frozen() = false after Freeze")
	}
	for range 3 {
		if got := Now(); !got.Equal(at) {
			t.Fatalf("frozen Now = %v, want %v", got, at)
		}
	}
	Reset()
	if got := Now(); got.Equal(at) || Frozen() {
		t.Fatalf("after Reset Now = %v (frozen %v), want the wall clock", got, Frozen())
	}
}
