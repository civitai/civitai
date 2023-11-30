import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  createClubMembershipInput,
  getInfiniteClubMembershipsSchema,
  updateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import {
  createClubMembershipHandler,
  getInfiniteClubMembershipsHandler,
  updateClubMembershipHandler,
} from '~/server/controllers/clubMembership.controller';

export const clubMembershipRouter = router({
  getInfinite: publicProcedure
    .input(getInfiniteClubMembershipsSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubMembershipsHandler),
  createClubMembership: protectedProcedure
    .input(createClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(createClubMembershipHandler),
  updateClubMembership: protectedProcedure
    .input(updateClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(updateClubMembershipHandler),
});
