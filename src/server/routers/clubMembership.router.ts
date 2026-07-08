import { isFlagProtected, protectedProcedure, router } from '../trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
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
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getInfiniteClubMembershipsSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubMembershipsHandler),
  createClubMembership: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(createClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(createClubMembershipHandler),
  updateClubMembership: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(updateClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(updateClubMembershipHandler),
  getClubMembershipOnClub: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(clubMembershipOnClubInput)
    .use(isFlagProtected('clubs'))
    .query(getClubMembershipOnClubHandler),
  removeAndRefundMember: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(ownerRemoveClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(removeAndRefundMemberHandler),
  togglePauseBilling: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(ownerRemoveClubMembershipInput)
    .use(isFlagProtected('clubs'))
    .mutation(clubOwnerTogglePauseBillingHandler),
  cancelClubMembership: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(toggleClubMembershipStatusInput)
    .use(isFlagProtected('clubs'))
    .mutation(cancelClubMembershipHandler),
  restoreClubMembership: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(toggleClubMembershipStatusInput)
    .use(isFlagProtected('clubs'))
    .mutation(restoreClubMembershipHandler),
});
