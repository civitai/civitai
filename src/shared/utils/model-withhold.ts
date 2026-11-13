import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * Whether a model's images and files are withheld: it is taken down. Who still sees them (its
 * owner, moderators, or no one) is each caller's decision.
 */
export const isModelWithheld = (model: { mode?: string | null }) =>
  model.mode === ModelModifier.TakenDown;
