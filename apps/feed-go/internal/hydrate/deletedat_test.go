package hydrate

import (
	"testing"
	"time"
)

// A user's deletedAt is one Date, as Node's cached user object holds one: every image of the user
// carries `deletedAt: userData?.deletedAt ?? null`, the same instance, and the devalue writer writes a
// shared *time.Time once.
func TestBasicUserDeletedAtIsOneDate(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	u := basicUserFrom(7, map[string]any{"username": "x", "deletedAt": at})
	d, ok := u.DeletedAt.(*time.Time)
	if !ok || !d.Equal(at) {
		t.Fatalf("deletedAt = %#v, want a *time.Time of %v", u.DeletedAt, at)
	}
	copied := u // what each image's user reads
	if copied.DeletedAt != u.DeletedAt {
		t.Fatal("a copy of the user carries another Date")
	}
	if u := basicUserFrom(8, map[string]any{"deletedAt": nil}); u.DeletedAt != nil {
		t.Fatalf("no deletedAt: %#v, want nil", u.DeletedAt)
	}
}
