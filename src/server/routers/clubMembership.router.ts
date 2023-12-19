import { isFlagProtected, protectedProcedure, router } from '../trpc';
import {
  toggleClubMembershipStatusInput,
  clubMembershipOnClubInput,
  createClubMembershipInput,
  getInfiniteClubMembershipsSchema,
  ownerRemoveClubMembershipInput,
  updateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import {
  cancelClubMembershipHandler,
  clubOwnerTogglePauseBillingHandler,
  createClubMembershipHandler,
  getClubMembershipOnClubHandler,
  getInfiniteClubMembershipsHandler,
  removeAndRefundMemberHandler,
  restoreClubMembershipHandler,
  updateClubMembershipHandler,
} from '~/server/controllers/clubMembership.controller';

export const clubMembershipRouter = router({
  getInfinite: protectedProcedure
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
    .use(isFlagProtected('clubs'))
    .mutation(removeAndRefundMemberHandler),
  togglePauseBilling: protectedProcedure
    .input(ownerRemoveClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(clubOwnerTogglePauseBillingHandler),
  cancelClubMembership: protectedProcedure
    .input(toggleClubMembershipStatusInput)
    .use(isFlagProtected('clubs'))
    .mutation(cancelClubMembershipHandler),
  restoreClubMembership: protectedProcedure
    .input(toggleClubMembershipStatusInput)
    .use(isFlagProtected('clubs'))
    .mutation(restoreClubMembershipHandler),
});
