import { moderatorProcedure, publicProcedure, router } from '../trpc';
import { availabilitySchema, getByEntitySchema } from '~/server/schema/base.schema';
import {
  getEntityAccessHandler,
  getEntityClubRequirementHandler,
  updateEntityAvailabilityHandler,
} from '~/server/controllers/common.controller';

export const commonRouter = router({
  getEntityAccess: publicProcedure.input(getByEntitySchema).query(getEntityAccessHandler),
  getEntityClubRequirement: publicProcedure
    .input(getByEntitySchema)
    .query(getEntityClubRequirementHandler),
  updateAvailability: moderatorProcedure
    .input(availabilitySchema)
    .mutation(updateEntityAvailabilityHandler),
});
