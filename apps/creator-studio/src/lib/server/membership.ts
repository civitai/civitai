import type { SessionUser } from '@civitai/auth';
import { resolveCapTier, type CapTier } from '@civitai/buzz';

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

// Monetization is open to every creator, free tier included (CU 868kj4q49 / 868kj4q4j) — membership decides
// only HOW MUCH, via maxLicensingFee / maxPaidAccessPrice.

// No subscription and the 'free' tier are the same thing everywhere — both resolve to 'free', so neither
// the caps nor the UI ever needs to tell them apart.
export const displayTier = (m: Membership): string => m.tier ?? 'free';

/**
 * The tier the caps resolve against. Delegates to the shared rule so the spoke and the main app can't
 * disagree about what a lapse, an unknown tier, or founder resolves to.
 */
export const cappedTier: (m: Membership) => CapTier = resolveCapTier;

/** Every capacity fact the models page ships to its editors. `null` cap = unlimited. */
export type CreatorCaps = {
  /** Display label only — cap math uses `capTier`, which drops to free on a lapse. */
  tier: string;
  capTier: CapTier;
  permanentUsed: number;
  permanentCap: number | null;
  maxEarlyAccessDays: number;
  earlyAccessUsed: number;
  earlyAccessCap: number;
};
