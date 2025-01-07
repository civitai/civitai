import {
  createFeatureStatusSchema,
  getFeatureStatusPagedSchema,
  getFeatureStatusSchema,
  resolveFeatureStatusSchema,
} from '~/server/schema/feature-status.schema';
import {
  createFeatureStatus,
  getFeatureStatus,
  getFeatureStatusDistinct,
  getFeatureStatusInfinite,
  resolveFeatureStatus,
} from '~/server/services/feature-status.service';

import { router, publicProcedure, moderatorProcedure } from '~/server/trpc';

export const featureStatusRouter = router({
  getFeatureStatuses: publicProcedure.query(() => getFeatureStatus()),
  // #region [mod only]
  createFeatureStatus: moderatorProcedure
    .input(createFeatureStatusSchema)
    .mutation(({ input, ctx }) => createFeatureStatus({ ...input, userId: ctx.user.id })),
  resolveFeatureStatus: moderatorProcedure
    .input(resolveFeatureStatusSchema)
    .mutation(({ input, ctx }) => resolveFeatureStatus({ ...input, userId: ctx.user.id })),
  getFeatureStatusesDistinct: moderatorProcedure.query(() => getFeatureStatusDistinct()),
  getFeatureStatusesInfinite: moderatorProcedure
    .input(getFeatureStatusPagedSchema)
    .query(({ input }) => getFeatureStatusInfinite(input)),
  // #endregion
});
