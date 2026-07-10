import type { SessionUser } from '@civitai/auth';

// Read membership off SessionUser (resolved by the shared session cache / hub) rather than re-querying.

// OnboardingSteps.CreatorProgram — set once a user joins the Creator Program (which requires creator score
// ≥ MIN_CREATOR_SCORE). The main app reads CP membership the same way: Flags.hasFlag(onboarding, 16).
const CREATOR_PROGRAM_ONBOARDING_FLAG = 16;

export type Membership = {
  tier: string | null;
  isMember: boolean;
  isCreatorProgramMember: boolean;
};

// Moderator-only testing override (this app only): the `cs-test-membership` cookie set to `creator-program`
// simulates Creator Program membership so CP-gated flows can be exercised without a real account. Set/cleared
// from the sidebar simulator; ignored for non-moderators. Any other value = the user's real membership.
export const TEST_MEMBERSHIP_COOKIE = 'cs-test-membership';

function realMembership(user: SessionUser | undefined): Membership {
  const tier = user?.tier ?? null;
  const isMember = tier !== null && tier !== 'free' && !user?.memberInBadState;
  const isCreatorProgramMember = ((user?.onboarding ?? 0) & CREATOR_PROGRAM_ONBOARDING_FLAG) !== 0;
  return { tier, isMember, isCreatorProgramMember };
}

// Resolve membership, applying the moderator-only Creator-Program override when the cookie is set. Every place
// that gates on membership (layout, form actions) must go through this with the cookie so the simulated state
// is consistent. The override keeps the user's real tier and just forces CP membership on top.
export function resolveMembership(user: SessionUser | undefined, testCookie?: string): Membership {
  const real = realMembership(user);
  if (user?.isModerator && testCookie === 'creator-program') {
    return { ...real, isMember: true, isCreatorProgramMember: true };
  }
  return real;
}

// B1 (decided 2026-07-09): Creator Program membership is the single bar for all member-only actions.
export const canSetLicensingFee = (m: Membership): boolean => m.isCreatorProgramMember;
export const canSellIndefinitely = (m: Membership): boolean => m.isCreatorProgramMember;
