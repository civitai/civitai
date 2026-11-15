import { itemHolderInFlightLimit } from '~/server/middleware.trpc';
import {
  getCreatorMysteryPacksInput,
  getEventMysteryBoxesInput,
  getMysteryBoxOddsPageInput,
  getSellerMysteryBoxesInput,
  getMysteryBoxOpeningsInput,
  openMysteryBoxInput,
} from '~/server/schema/mystery-box.schema';
import { creatorMysteryPacksEnabled } from '~/server/schema/creator-shop.schema';
import {
  getCreatorMysteryPacks,
  getMysteryPackViewsForSeller,
} from '~/server/services/creator-mystery-pack-read.service';
import { getMysteryBoxOddsPage } from '~/server/services/mystery-box-odds-page.service';
import {
  getHeldMysteryBoxes,
  getMysteryBoxOpenings,
} from '~/server/services/mystery-box-inventory.service';
import {
  getMysteryBoxCatalogForEvent,
  getMysteryBoxesForEvent,
  openMysteryBox,
} from '~/server/services/mystery-box.service';
import { noEdgeCache } from '~/server/middleware.trpc';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { getRegion } from '~/server/utils/region-blocking';
import { mysteryBoxViewer, publicMysteryBoxViewer } from '~/server/utils/mystery-box-viewer';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const mysteryBoxRouter = router({
  getForEvent: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getEventMysteryBoxesInput)
    .query(({ input, ctx }) => getMysteryBoxesForEvent({ ...input, ...mysteryBoxViewer(ctx) })),
  // Per viewer (flag, country, event access): a signed-out answer is otherwise edge-cached by URL.
  getOddsPage: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .use(noEdgeCache())
    .input(getMysteryBoxOddsPageInput)
    .query(({ input, ctx }) =>
      getMysteryBoxOddsPage({
        ...input,
        ...publicMysteryBoxViewer(ctx),
        creatorPacksEnabled: creatorMysteryPacksEnabled(ctx.features),
      })
    ),
  // For a viewer not on a team, signed in or not. Per viewer, like the odds page.
  getCatalogForEvent: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .use(noEdgeCache())
    .input(getEventMysteryBoxesInput)
    .query(({ input, ctx }) =>
      getMysteryBoxCatalogForEvent({ ...input, ...publicMysteryBoxViewer(ctx) })
    ),
  // Per viewer: flags and country.
  getForCreator: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .use(noEdgeCache())
    .input(getCreatorMysteryPacksInput)
    .query(({ input, ctx }) =>
      getCreatorMysteryPacks({
        sellerId: input.sellerId,
        enabled: creatorMysteryPacksEnabled(ctx.features),
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
      })
    ),
  getForSeller: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getSellerMysteryBoxesInput)
    .query(({ input, ctx }) =>
      getMysteryPackViewsForSeller({
        sellerId: input.sellerId,
        userId: ctx.user.id,
        enabled: creatorMysteryPacksEnabled(ctx.features),
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
      })
    ),
  open: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite, blockApiKeys: true })
    .input(openMysteryBoxInput)
    .use(itemHolderInFlightLimit)
    .mutation(({ input, ctx }) => openMysteryBox({ ...input, ...mysteryBoxViewer(ctx) })),
  getHeld: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => getHeldMysteryBoxes(mysteryBoxViewer(ctx))),
  getOpenings: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getMysteryBoxOpeningsInput)
    .query(({ input, ctx }) => getMysteryBoxOpenings({ ...input, ...mysteryBoxViewer(ctx) })),
});
