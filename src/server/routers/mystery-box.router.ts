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
import { getMysteryBoxesForEvent, openMysteryBox } from '~/server/services/mystery-box.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { mysteryBoxViewer } from '~/server/utils/mystery-box-viewer';
import { getRegion } from '~/server/utils/region-blocking';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const mysteryBoxRouter = router({
  getForEvent: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getEventMysteryBoxesInput)
    .query(({ input, ctx }) => getMysteryBoxesForEvent({ ...input, ...mysteryBoxViewer(ctx) })),
  // Per viewer (flag, country, event access): never edge-cache.
  getOddsPage: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getMysteryBoxOddsPageInput)
    .query(({ input, ctx }) =>
      getMysteryBoxOddsPage({
        ...input,
        viewer: ctx.user ? { id: ctx.user.id, isModerator: ctx.user.isModerator } : undefined,
        mysteryBoxEnabled: ctx.features.mysteryBox,
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
      })
    ),
  open: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite, blockApiKeys: true })
    .input(openMysteryBoxInput)
    .mutation(({ input, ctx }) => openMysteryBox({ ...input, ...mysteryBoxViewer(ctx) })),
  getHeld: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => getHeldMysteryBoxes(mysteryBoxViewer(ctx))),
  getOpenings: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getMysteryBoxOpeningsInput)
    .query(({ input, ctx }) => getMysteryBoxOpenings({ ...input, ...mysteryBoxViewer(ctx) })),
});
