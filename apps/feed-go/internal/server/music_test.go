package server

import (
	"context"
	"errors"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
)

// canSeeSongs: a moderator always, anyone else only with the `music` flag; no reader or a failed read
// is off, as Node's static fallback (moderators only) answers when Flipt cannot.
func TestCanSeeSongs(t *testing.T) {
	user := &auth.SessionUser{ID: 4101}
	ctx := context.Background()
	for _, c := range []struct {
		name   string
		reader UserFlagReader
		user   *auth.SessionUser
		mod    bool
		want   bool
	}{
		{"moderator, no reader", nil, user, true, true},
		{"no reader", nil, user, false, false},
		{"flag on", &stubUserFlag{on: true}, user, false, true},
		{"flag off", &stubUserFlag{on: false}, user, false, false},
		{"read failed", &stubUserFlag{on: true, err: errors.New("down")}, user, false, false},
		{"signed out", &stubUserFlag{on: true}, nil, false, false},
	} {
		s := &Server{Music: c.reader}
		if got := s.canSeeSongs(ctx, c.user, c.mod); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
