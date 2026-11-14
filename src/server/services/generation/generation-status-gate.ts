import {
  assertGenerationStatusAllows,
  GenerationConfigUnavailableError,
} from '~/server/services/generation/generation-kill-switch';

/**
 * The generation kill switch, read now, for one caller: the check a step that runs before a
 * generation applies (a preset action, onsite prompt enhancement). The rule is
 * `generationStatusRefusal`'s, and a switch that cannot be read refuses everyone, moderators
 * included, as `buildGenerationContext` refuses it for an onsite submit: the moderator bypass
 * applies to an operator's decision, not to a state nobody knows.
 */
export async function assertGenerationAllowedNow(user: {
  isModerator?: boolean;
  tier?: string;
}): Promise<void> {
  // Imported at call time, as the other kill-switch readers do: generation.service is a large graph.
  const generation = await import('~/server/services/generation/generation.service');
  const { status, known } = await generation.getGenerationStatusState();
  if (!known) throw new GenerationConfigUnavailableError();
  assertGenerationStatusAllows(status, { isModerator: user.isModerator, tier: user.tier });
}
