import { ModelUsageControl } from '~/shared/utils/prisma/enums';

export const GENERATION_ONLY_FEATURE_KEY = 'generationOnlyModels';

/**
 * The label the `generationOnlyModels` gate's log line carries for a non-Download usage control. The flag
 * admits every signed-in user, so `moderator` and `granted` only describe the caller, and `tier` is any
 * other user; `denied` means an env override switched the flag off. Values kept for existing log queries.
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
