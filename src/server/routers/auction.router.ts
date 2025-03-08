import {
  createBidInput,
  deleteBidInput,
  getAuctionBySlugInput,
  togglePauseRecurringBidInput,
} from '~/server/schema/auction.schema';
import {
  createBid,
  deleteBid,
  deleteRecurringBid,
  getAllAuctions,
  getAuctionBySlug,
  getMyBids,
  getMyRecurringBids,
  togglePauseRecurringBid,
} from '~/server/services/auction.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

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
});
