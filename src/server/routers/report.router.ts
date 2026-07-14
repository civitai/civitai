import {
  createEntityAppealHandler,
  createReportHandler,
  getRecentAppealsHandler,
} from '~/server/controllers/report.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createEntityAppealSchema,
  createReportInputSchema,
  getRecentAppealsSchema,
} from '~/server/schema/report.schema';
import { getAppealDetails } from '~/server/services/report.service';
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const reportRouter = router({
  create: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createReportInputSchema)
    .mutation(createReportHandler),
  // #region [appeal]
  getRecentAppeals: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getRecentAppealsSchema)
    .query(getRecentAppealsHandler),
  getAppealDetails: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input }) => getAppealDetails({ ...input })),
  createAppeal: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createEntityAppealSchema)
    .mutation(createEntityAppealHandler),
  // #endregion
});
