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

const auctionProcedure = protectedProcedure.use(isFlagProtected('auctions'));

// .use(edgeCacheIt({ ttl: CacheTTL.hour }))

export const auctionRouter = router({
  getAll: publicProcedure.query(getAllAuctions),
  getBySlug: publicProcedure
    .input(getAuctionBySlugInput)
    .query(({ input }) => getAuctionBySlug(input)),
  getMyBids: auctionProcedure.query(({ ctx }) => getMyBids({ userId: ctx.user.id })),
  getMyRecurringBids: auctionProcedure.query(({ ctx }) =>
    getMyRecurringBids({ userId: ctx.user.id })
  ),
  createBid: auctionProcedure
    .input(createBidInput)
    .mutation(({ input, ctx }) => createBid({ ...input, userId: ctx.user.id })),
  deleteBid: auctionProcedure
    .input(deleteBidInput)
    .mutation(({ input, ctx }) => deleteBid({ ...input, userId: ctx.user.id })),
  deleteRecurringBid: auctionProcedure
    .input(deleteBidInput)
    .mutation(({ input, ctx }) => deleteRecurringBid({ ...input, userId: ctx.user.id })),
  togglePauseRecurringBid: auctionProcedure
    .input(togglePauseRecurringBidInput)
    .mutation(({ input, ctx }) => togglePauseRecurringBid({ ...input, userId: ctx.user.id })),
  modGetAuctionBases: moderatorProcedure
    .input(getAuctionBasesInput)
    .query(({ input }) => getAuctionBases(input)),
  modUpdateAuctionBase: moderatorProcedure
    .input(updateAuctionBaseInput)
    .mutation(({ input }) => updateAuctionBase(input)),
});
