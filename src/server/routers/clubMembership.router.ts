import { isFlagProtected, middleware, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  cancelClubMembershipInput,
  clubMembershipOnClubInput,
  createClubMembershipInput,
  getInfiniteClubMembershipsSchema,
  ownerRemoveClubMembershipInput,
  updateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import {
  cancelClubMembershipHandler,
  createClubMembershipHandler,
  getClubMembershipOnClubHandler,
  getInfiniteClubMembershipsHandler,
  removeAndRefundMemberHandler,
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
  getClubMembershipOnClub: protectedProcedure
    .input(clubMembershipOnClubInput)
    .use(isFlagProtected('clubs'))
    .query(getClubMembershipOnClubHandler),
  removeAndRefundMember: protectedProcedure
    .input(ownerRemoveClubMembershipInput)
    .mutation(removeAndRefundMemberHandler),
  cancelClubMembership: protectedProcedure
    .input(cancelClubMembershipInput)
    .mutation(cancelClubMembershipHandler),
});
