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

export function getMembership(user: SessionUser | undefined): Membership {
  const tier = user?.tier ?? null;
  const isMember = tier !== null && tier !== 'free' && !user?.memberInBadState;
  const isCreatorProgramMember = ((user?.onboarding ?? 0) & CREATOR_PROGRAM_ONBOARDING_FLAG) !== 0;
  return { tier, isMember, isCreatorProgramMember };
}

// B1 (decided 2026-07-09): Creator Program membership is the single bar for all member-only actions.
export const canSetLicensingFee = (m: Membership): boolean => m.isCreatorProgramMember;
export const canSellIndefinitely = (m: Membership): boolean => m.isCreatorProgramMember;
