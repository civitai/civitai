import { openMysteryBoxInput } from '~/server/schema/mystery-box.schema';
import { openMysteryBox } from '~/server/services/mystery-box.service';
import { protectedProcedure, router } from '~/server/trpc';
import { getRegion } from '~/server/utils/region-blocking';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const mysteryBoxRouter = router({
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
