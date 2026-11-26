package server

import (
	"context"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/flipt"
)

// UserHubsFlag is the Flipt key of the Node app's `userHubs` feature (feature-flags.service.ts:
// `availability: []`, fliptKey 'user-hubs'): off for a viewer, getInfiniteImagesHandler refuses any
// `hubId` with an UNAUTHORIZED ('Hubs are not available yet') before anything else runs.
const UserHubsFlag = "user-hubs"

// The `hubId` port's flag fallbacks (feed.InfinitePorts.HubID).
const (
	// ReasonHubFlagOff is a viewer the flag is off for: Node's UNAUTHORIZED, which it answers itself.
	ReasonHubFlagOff = "infinite-hub-flag-off"
	// ReasonHubFlagUnknown is a `hubId` request whose flag could not be read (no Flipt configured,
	// unreachable, an error, a key Flipt does not know): never served without knowing it is on.
	ReasonHubFlagUnknown = "infinite-hub-flag-unknown"
)

// userHubs is the handler's `if (input.hubId && !features.userHubs)` gate: nil to serve the hub,
// else the fallback. The flag is read as createContext's getFeatureFlagsLazy reads it: for the session
// user (a banned one included: createContext evaluates the flags before trpcViewer moves it aside)
// with their id and buildFliptContext(user), or as 'anonymous' with the signed-out context. Flipt's
// answer decides, as in hasFeature (no region or domain rule applies to an `availability: []` flag);
// a flag that cannot be read falls back, as Node's static fallback for this flag is off.
//
// The evaluation is the Flipt server's, not the engine Node runs (flipt.UserFlag), and an answer is
// reused for its TTL: a viewer the two disagree on is answered differently. Off here while on in Node
// only hands a request back. On here while off in Node serves a hub Node would refuse: the hub's
// contents are still resolved for the viewer's own access, so what it can show is what that viewer
// may open, but the product gate is not held for that window. DESIGN.md §14.2.3.
func (s *Server) userHubs(ctx context.Context, user *auth.SessionUser) error {
	if s.UserHubs == nil {
		return fallback.New(ReasonHubFlagUnknown)
	}
	entity, evalCtx := flipt.AnonymousEntityID, flipt.AnonymousContext(s.FliptDeploymentID)
	if user != nil {
		entity, evalCtx = strconv.Itoa(user.ID), flipt.UserContext(personalHotLeadTarget(user), s.FliptDeploymentID)
	}
	on, err := s.UserHubs.Enabled(ctx, entity, evalCtx)
	if err != nil {
		return fallback.Wrap(ReasonHubFlagUnknown, err)
	}
	if !on {
		return fallback.New(ReasonHubFlagOff)
	}
	return nil
}
