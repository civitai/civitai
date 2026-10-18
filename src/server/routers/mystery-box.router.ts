import { itemHolderInFlightLimit } from '~/server/middleware.trpc';
import {
  getEventMysteryBoxesInput,
  getMysteryBoxOddsPageInput,
  getMysteryBoxOpeningsInput,
  openMysteryBoxInput,
} from '~/server/schema/mystery-box.schema';
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
    .query(({ input, ctx }) => getMysteryBoxOddsPage({ ...input, ...publicMysteryBoxViewer(ctx) })),
  // For a viewer not on a team, signed in or not. Per viewer, like the odds page.
  getCatalogForEvent: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .use(noEdgeCache())
    .input(getEventMysteryBoxesInput)
    .query(({ input, ctx }) =>
      getMysteryBoxCatalogForEvent({ ...input, ...publicMysteryBoxViewer(ctx) })
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
