import { getByIdSchema } from '~/server/schema/base.schema';
import { upsertPostPresetSchema } from '~/server/schema/post-preset.schema';
import {
  deletePostPreset,
  getPostPresets,
  upsertPostPreset,
} from '~/server/services/post-preset.service';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const postPresetRouter = router({
  getAll: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(isFlagProtected('postPresets'))
    .query(({ ctx }) => getPostPresets({ userId: ctx.user.id })),
  upsert: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(upsertPostPresetSchema)
    .use(isFlagProtected('postPresets'))
    .mutation(({ ctx, input }) => upsertPostPreset({ userId: ctx.user.id, input })),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('postPresets'))
    .mutation(({ ctx, input }) => deletePostPreset({ userId: ctx.user.id, id: input.id })),
});
