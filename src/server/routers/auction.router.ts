import {
  createBidInput,
  deleteBidInput,
  getAuctionBasesInput,
  getAuctionBySlugInput,
  togglePauseRecurringBidInput,
  updateAuctionBaseInput,
} from '~/server/schema/auction.schema';
import {
  createBid,
  deleteBid,
  deleteRecurringBid,
  getAllAuctions,
  getAuctionBases,
  getAuctionBySlug,
  getMyBids,
  getMyRecurringBids,
  moveRecurringBidToLatest,
  togglePauseRecurringBid,
  updateAuctionBase,
} from '~/server/services/auction.service';
import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const auctionProcedure = protectedProcedure.use(isFlagProtected('auctions'));

// .use(edgeCacheIt({ ttl: CacheTTL.hour }))

export const auctionRouter = router({
  getAll: publicProcedure.meta({ requiredScope: TokenScope.BountiesRead }).query(getAllAuctions),
  getBySlug: publicProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .input(getAuctionBySlugInput)
    .query(({ input }) => getAuctionBySlug(input)),
  getMyBids: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .query(({ ctx }) => getMyBids({ userId: ctx.user.id })),
  getMyRecurringBids: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesRead })
    .query(({ ctx }) => getMyRecurringBids({ userId: ctx.user.id })),
  createBid: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite, blockApiKeys: true })
    .input(createBidInput)
    .mutation(({ input, ctx }) =>
      createBid({
        ...input,
        userId: ctx.user.id,
        accountTypes: getAllowedAccountTypes(ctx.features),
      })
    ),
  deleteBid: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(deleteBidInput)
    .mutation(({ input, ctx }) => deleteBid({ ...input, userId: ctx.user.id })),
  deleteRecurringBid: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(deleteBidInput)
    .mutation(({ input, ctx }) => deleteRecurringBid({ ...input, userId: ctx.user.id })),
  moveRecurringBidToLatest: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(deleteBidInput)
    .mutation(({ input, ctx }) => moveRecurringBidToLatest({ ...input, userId: ctx.user.id })),
  togglePauseRecurringBid: auctionProcedure
    .meta({ requiredScope: TokenScope.BountiesWrite })
    .input(togglePauseRecurringBidInput)
    .mutation(({ input, ctx }) => togglePauseRecurringBid({ ...input, userId: ctx.user.id })),
  modGetAuctionBases: moderatorProcedure
    .input(getAuctionBasesInput)
    .query(({ input }) => getAuctionBases(input)),
  modUpdateAuctionBase: moderatorProcedure
    .input(updateAuctionBaseInput)
    .mutation(({ input }) => updateAuctionBase(input)),
});
