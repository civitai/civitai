import { moderatorProcedure, publicProcedure, router } from '../trpc';
import { availabilitySchema, getByEntitySchema } from '~/server/schema/base.schema';
import {
  getEntityAccessHandler,
  updateEntityAvailabilityHandler,
} from '~/server/controllers/common.controller';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const commonRouter = router({
  getEntityAccess: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByEntitySchema)
    .query(getEntityAccessHandler),
  updateAvailability: moderatorProcedure
    .input(availabilitySchema)
    .mutation(updateEntityAvailabilityHandler),
});
