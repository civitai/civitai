import { ModelUsageControl } from '~/shared/utils/prisma/enums';

export const GENERATION_ONLY_FEATURE_KEY = 'generationOnlyModels';

/**
 * Which branch of the `generationOnlyModels` gate let a non-Download usage control through.
 * `tier` is a regular user let through by the flag's availability list (any signed-in user since the
 * flag opened to everyone); the value is kept so existing log queries still match.
 */
export type GenerationOnlyGateOutcome = 'moderator' | 'granted' | 'tier' | 'denied';

/**
 * Decide the usage control a non-Download request may keep. Callers must only invoke this when
 * the requested control is not `Download` — an absent control counts as non-Download, matching
 * the write path (an unset control on an update would otherwise leave a stored gen-only value in
 * place).
 */
export function resolveGenerationOnlyGate({
  requested,
  hasFeature,
  isModerator,
  permissions,
}: {
  requested: ModelUsageControl | undefined;
  hasFeature: boolean;
  isModerator: boolean;
  permissions?: string[];
}): { usageControl: ModelUsageControl | undefined; outcome: GenerationOnlyGateOutcome } {
  if (!hasFeature) return { usageControl: ModelUsageControl.Download, outcome: 'denied' };

  const outcome: GenerationOnlyGateOutcome = isModerator
    ? 'moderator'
    : permissions?.includes(GENERATION_ONLY_FEATURE_KEY)
    ? 'granted'
    : 'tier';

  return { usageControl: requested, outcome };
}
