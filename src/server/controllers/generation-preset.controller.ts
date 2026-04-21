import type { Context } from '~/server/createContext';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  CreateGenerationPresetInput,
  GetPresetsForEcosystemInput,
  ReorderGenerationPresetsInput,
  UpdateGenerationPresetInput,
} from '~/server/schema/generation-preset.schema';
import {
  createGenerationPreset,
  deleteGenerationPreset,
  getPresetById,
  getPresetsForEcosystem,
  getUserPresets,
  reorderGenerationPresets,
  updateGenerationPreset,
} from '~/server/services/generation-preset.service';

type AuthedCtx = Context & { user: { id: number } };

export function getForEcosystemHandler({
  input,
  ctx,
}: {
  input: GetPresetsForEcosystemInput;
  ctx: AuthedCtx;
}) {
  return getPresetsForEcosystem({ userId: ctx.user.id, ecosystem: input.ecosystem });
}

export function getOwnHandler({ ctx }: { ctx: AuthedCtx }) {
  return getUserPresets({ userId: ctx.user.id });
}

export function getByIdHandler({ input, ctx }: { input: GetByIdInput; ctx: AuthedCtx }) {
  return getPresetById({ id: input.id, userId: ctx.user.id });
}

export function createHandler({
  input,
  ctx,
}: {
  input: CreateGenerationPresetInput;
  ctx: AuthedCtx;
}) {
  return createGenerationPreset({ userId: ctx.user.id, input });
}

export function updateHandler({
  input,
  ctx,
}: {
  input: UpdateGenerationPresetInput;
  ctx: AuthedCtx;
}) {
  return updateGenerationPreset({ userId: ctx.user.id, input });
}

export function deleteHandler({ input, ctx }: { input: GetByIdInput; ctx: AuthedCtx }) {
  return deleteGenerationPreset({ userId: ctx.user.id, id: input.id });
}

export function reorderHandler({
  input,
  ctx,
}: {
  input: ReorderGenerationPresetsInput;
  ctx: AuthedCtx;
}) {
  return reorderGenerationPresets({ userId: ctx.user.id, input });
}
