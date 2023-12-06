import { isFlagProtected, middleware, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  clubMembershipOnClubInput,
  createClubMembershipInput,
  getInfiniteClubMembershipsSchema,
  ownerRemoveClubMembershipInput,
  updateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import {
  createClubMembershipHandler,
  getClubMembershipOnClubHandler,
  getInfiniteClubMembershipsHandler,
  removeAndRefundMemberHandler,
  updateClubMembershipHandler,
} from '~/server/controllers/clubMembership.controller';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';

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
  getClubMembershipOnClub: protectedProcedure
    .input(clubMembershipOnClubInput)
    .use(isFlagProtected('clubs'))
    .query(getClubMembershipOnClubHandler),
  removeAndRefundMember: protectedProcedure
    .input(ownerRemoveClubMembershipInput)
    .mutation(removeAndRefundMemberHandler),
});
