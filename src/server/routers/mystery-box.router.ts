import {
  getEventMysteryBoxesInput,
  getMysteryBoxOddsPageInput,
  openMysteryBoxInput,
} from '~/server/schema/mystery-box.schema';
import { getMysteryBoxOddsPage } from '~/server/services/mystery-box-odds-page.service';
import { getMysteryBoxesForEvent, openMysteryBox } from '~/server/services/mystery-box.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { getRegion } from '~/server/utils/region-blocking';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const mysteryBoxRouter = router({
  getForEvent: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getEventMysteryBoxesInput)
    .query(({ input, ctx }) =>
      getMysteryBoxesForEvent({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
        mysteryBoxEnabled: ctx.features.mysteryBox,
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
      })
    ),
  // The public odds page: signed out too, under the event's own access. Per viewer (flag, country,
  // event access), so never edge-cached.
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
    .mutation(({ input, ctx }) =>
      openMysteryBox({
        ...input,
        userId: ctx.user.id,
        mysteryBoxEnabled: ctx.features.mysteryBox,
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
      })
    ),
});
