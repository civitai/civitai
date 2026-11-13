import {
  addHandler,
  deleteHandler,
  getAllHandler,
} from '~/server/controllers/generation-size-preset.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { addSizePresetInputSchema } from '~/server/schema/generation-size-preset.schema';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Custom sizes a user saved — the picker's "Saved" sizes. */
export const generationSizePresetRouter = router({
  getAll: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(getAllHandler),
  add: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(addSizePresetInputSchema)
    .mutation(addHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(getByIdSchema)
    .mutation(deleteHandler),
});
