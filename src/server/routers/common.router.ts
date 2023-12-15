import { publicProcedure, router } from '../trpc';
import { getByEntitySchema } from '~/server/schema/base.schema';
import {
  getEntityAccessHandler,
  getEntityClubRequirementHandler,
} from '~/server/controllers/common.controller';

export const commonRouter = router({
  getEntityAccess: publicProcedure.input(getByEntitySchema).query(getEntityAccessHandler),
  getEntityClubRequirement: publicProcedure
    .input(getByEntitySchema)
    .query(getEntityClubRequirementHandler),
});
