/** `User.onboarding` is a bitfield, mirrored from the main app's `OnboardingSteps`. Kept here because
 *  the moderator app reads the column but has no import path to that enum, and testing it by
 *  truthiness — which is what shipped — makes every flag read as "accepted the TOS". */
export const OnboardingStep = {
  TOS: 1,
  Profile: 2,
  BrowsingLevels: 4,
  Buzz: 8,
  CreatorProgram: 16,
  BannedCreatorProgram: 32,
  RedTOS: 64,
} as const;

export const hasOnboardingStep = (onboarding: number | null, step: number) =>
  ((onboarding ?? 0) & step) !== 0;
