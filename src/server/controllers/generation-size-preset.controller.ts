import type { Context } from '~/server/createContext';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { AddSizePresetInput } from '~/server/schema/generation-size-preset.schema';
import {
  addSizePreset,
  deleteSizePreset,
  getSizePresets,
} from '~/server/services/generation-size-preset.service';

type AuthedCtx = Context & { user: { id: number } };

export function getAllHandler({ ctx }: { ctx: AuthedCtx }) {
  return getSizePresets({ userId: ctx.user.id });
}

export function addHandler({ input, ctx }: { input: AddSizePresetInput; ctx: AuthedCtx }) {
  return addSizePreset({ userId: ctx.user.id, ...input });
}

export function deleteHandler({ input, ctx }: { input: GetByIdInput; ctx: AuthedCtx }) {
  return deleteSizePreset({ userId: ctx.user.id, id: input.id });
}
