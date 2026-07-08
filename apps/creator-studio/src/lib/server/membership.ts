import type { SessionUser } from '@civitai/auth';

// The auth session already resolves the user's membership (tier + bad-state) via the shared session cache /
// hub identity endpoint, so we read it off SessionUser rather than re-querying subscriptions. Every capability
// gate routes through the can*() helpers, so the still-open "tier vs full CP membership" decision
// (docs/creator-studio/pre-implementation-decisions.md B1) stays a one-line change.

export type Membership = {
  tier: string | null;
  isMember: boolean;
  // TODO(creator-studio): wire the real CP check (creator score ≥40k) once the indefinite-sale backend
  // (decisions A4/B2) lands. Stubbed false until then.
  isCreatorProgramMember: boolean;
};

export function getMembership(user: SessionUser | undefined): Membership {
  // Mirrors the main app's isPaidMember (CivitaiSessionProvider): a non-free tier that isn't in a bad state.
  const tier = user?.tier ?? null;
  const isMember = tier !== null && tier !== 'free' && !user?.memberInBadState;
  return { tier, isMember, isCreatorProgramMember: false };
}

// Capability gates — the ONLY thing callers (page loads, form actions, nav) should ask. Flip B1 here.
export const canSetLicensingFee = (m: Membership): boolean => m.isMember;
export const canSellIndefinitely = (m: Membership): boolean => m.isCreatorProgramMember;
