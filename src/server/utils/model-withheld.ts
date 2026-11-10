import { ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * A deleted or taken-down model, whose files and weights are moderators-only. Kept apart from
 * `model-version-gates` so the file reads that use it don't load the paid-access service.
 */
export const isModelDeletedOrTakenDown = (model: { status: string; mode: string | null }) =>
  model.status === ModelStatus.Deleted || model.mode === ModelModifier.TakenDown;
