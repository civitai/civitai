import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * A taken-down model's images and files are withheld from everyone but its owner and moderators.
 * Each caller decides who bypasses it; what counts as withheld lives here once.
 */
export const isModelWithheld = (model: { mode?: string | null }) =>
  model.mode === ModelModifier.TakenDown;
