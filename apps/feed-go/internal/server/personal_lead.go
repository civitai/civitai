package server

import (
	"context"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/flipt"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

// PersonalHotLeadFlag is the Node app's FLIPT_FEATURE_FLAGS.PERSONAL_HOT_LEAD: on for a viewer, page 1
// of their default Hot model feed leads with models picked for them (getPersonalLeadIdsForFeed), which
// this service does not port.
const PersonalHotLeadFlag = "personal-hot-lead"

// The personal Hot lead's fallbacks (temporary, until the experiment is decided: DESIGN.md §15.2.3).
const (
	// ReasonPersonalHotLead is a viewer the flag is on for, on any page of a feed Node leads (page 1
	// carries the lead; later pages drop its ids).
	ReasonPersonalHotLead = "model-getall-personal-hot-lead"
	// ReasonPersonalHotLeadUnknown is the same page when the flag could not be read (no Flipt
	// configured, unreachable, an error, a key Flipt does not know): never served without the lead.
	ReasonPersonalHotLeadUnknown = "model-getall-personal-hot-lead-unknown"
)

// UserFlagReader answers a per-viewer boolean flag (flipt.UserFlag).
type UserFlagReader interface {
	Enabled(ctx context.Context, entityID string, evalCtx map[string]string) (bool, error)
}

// personalHotLead is the personal Hot lead's gate on model.getAll: nil to serve, else the fallback.
// The flag is read only for a signed-in viewer (a banned one has none, as Node's ctx.user) on any page
// of a feed Node leads (modelfeed.Input.PersonalHotLeadEligible), with the entity id and context Node's
// isFlipt is called with (the user id, buildFliptContext(user)). It fails closed: a flag it cannot
// read falls back, so a viewer in the cohort is never served a page that differs from Node's.
func (s *Server) personalHotLead(ctx context.Context, req modelfeed.Request, user *auth.SessionUser) error {
	if req.Viewer == nil || user == nil || req.Input == nil || !req.Input.PersonalHotLeadEligible() {
		return nil
	}
	if s.PersonalHotLead == nil {
		return fallback.New(ReasonPersonalHotLeadUnknown)
	}
	on, err := s.PersonalHotLead.Enabled(ctx, strconv.Itoa(user.ID), flipt.UserContext(personalHotLeadTarget(user), s.FliptDeploymentID))
	if err != nil {
		return fallback.Wrap(ReasonPersonalHotLeadUnknown, err)
	}
	if on {
		return fallback.New(ReasonPersonalHotLead)
	}
	return nil
}

// onboardingCreatorProgram is OnboardingSteps.CreatorProgram (src/server/common/enums.ts).
const onboardingCreatorProgram = 16

// personalHotLeadTarget is the session user as buildFliptContext reads it. isInCreatorProgram is
// Flags.hasFlag(onboarding, CreatorProgram): `(onboarding | flag) === onboarding`, on JS's int32
// bitwise result, so a value outside int32 is never a member.
func personalHotLeadTarget(u *auth.SessionUser) flipt.TargetUser {
	ob := u.Onboarding
	return flipt.TargetUser{
		ID: u.ID, IsModerator: u.IsModerator, Tier: u.Tier, IsEarlyAdopter: u.IsEarlyAdopter,
		AppBuilderApproved: u.AppBuilderApproved,
		InCreatorProgram:   ob == int(int32(ob)) && ob&onboardingCreatorProgram != 0,
	}
}
