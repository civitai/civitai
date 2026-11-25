package server

import (
	"context"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/flipt"
)

// MusicFlag is the `music` feature flag's Flipt key (src/server/services/feature-flags.service.ts).
const MusicFlag = "music"

// canSeeSongs is the Node app's canSeeSongs (src/server/services/image-visibility.service.ts): a
// moderator, or a viewer the `music` flag is on for. When Flipt cannot answer, Node falls back to the
// flag's static availability (moderators only), so a nil reader or a failed read is off here too.
func (s *Server) canSeeSongs(ctx context.Context, user *auth.SessionUser, isModerator bool) bool {
	if isModerator {
		return true
	}
	if user == nil || s.Music == nil {
		return false
	}
	on, err := s.Music.Enabled(ctx, strconv.Itoa(user.ID), flipt.UserContext(personalHotLeadTarget(user), s.FliptDeploymentID))
	return err == nil && on
}
