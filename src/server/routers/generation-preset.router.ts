import {
  createHandler,
  deleteHandler,
  getByIdHandler,
  getForEcosystemHandler,
  getOwnHandler,
  reorderHandler,
  updateHandler,
} from '~/server/controllers/generation-preset.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createGenerationPresetInputSchema,
  getPresetsForEcosystemInputSchema,
  reorderGenerationPresetsInputSchema,
  updateGenerationPresetInputSchema,
} from '~/server/schema/generation-preset.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const generationPresetRouter = router({
  getForEcosystem: protectedProcedure
    .input(getPresetsForEcosystemInputSchema)
    .query(getForEcosystemHandler),
  getOwn: protectedProcedure.query(getOwnHandler),
  getById: protectedProcedure.input(getByIdSchema).query(getByIdHandler),
  create: protectedProcedure.input(createGenerationPresetInputSchema).mutation(createHandler),
  update: protectedProcedure.input(updateGenerationPresetInputSchema).mutation(updateHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteHandler),
  reorder: protectedProcedure.input(reorderGenerationPresetsInputSchema).mutation(reorderHandler),
});
