package auth

import "testing"

// The saved browsing level and showNsfw getServerBrowsingLevel reads: a number and a boolean are read;
// absent or null is unset; any other kind (a numeric string, a fraction, a negative level, a showNsfw
// that is not a boolean) is marked unread, since JavaScript's truthiness of it is not reproduced.
func TestSessionUserBrowsingPrefs(t *testing.T) {
	for _, c := range []struct {
		name     string
		m        map[string]any
		level    int
		showNsfw bool
		unread   bool
	}{
		{"absent", map[string]any{}, 0, false, false},
		{"null", map[string]any{"browsingLevel": nil, "showNsfw": nil}, 0, false, false},
		{"set", map[string]any{"browsingLevel": int64(31), "showNsfw": true}, 31, true, false},
		{"msgpack unsigned", map[string]any{"browsingLevel": uint64(7), "showNsfw": false}, 7, false, false},
		{"integral float", map[string]any{"browsingLevel": float64(3)}, 3, false, false},
		{"numeric string", map[string]any{"browsingLevel": "31"}, 0, false, true},
		{"fraction", map[string]any{"browsingLevel": 1.5}, 0, false, true},
		{"negative", map[string]any{"browsingLevel": int64(-1)}, 0, false, true},
		{"showNsfw not a boolean", map[string]any{"showNsfw": int64(1)}, 0, false, true},
	} {
		u, err := SessionUserFrom(5, c.m)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if u.BrowsingLevel != c.level || u.ShowNsfw != c.showNsfw || u.BrowsingPrefsUnread != c.unread {
			t.Errorf("%s: level %d showNsfw %v unread %v, want %d %v %v", c.name, u.BrowsingLevel, u.ShowNsfw, u.BrowsingPrefsUnread, c.level, c.showNsfw, c.unread)
		}
	}
}
