import {
  claimGiftSchema,
  createGiftLinkSchema,
  giftLinksForVersionSchema,
  revokeGiftLinksSchema,
} from '~/server/schema/model-version-gift.schema';
import {
  claimGift,
  createGiftLink,
  listGiftLinks,
  revokeGiftLinks,
} from '~/server/services/model-version-gift.service';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Token callers use the /api/v1/model-versions gift routes; create and claim here are session-only.
const giftRead = protectedProcedure.use(isFlagProtected('modelGiftLinks'));
const giftWrite = guardedProcedure.use(isFlagProtected('modelGiftLinks'));

export const modelVersionGiftRouter = router({
  list: giftRead
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(giftLinksForVersionSchema)
    .query(({ input, ctx }) =>
      listGiftLinks({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  create: giftWrite
    .meta({ requiredScope: TokenScope.ModelsWrite, blockApiKeys: true })
    .input(createGiftLinkSchema)
    .mutation(({ input, ctx }) => createGiftLink({ ...input, userId: ctx.user.id })),
  revoke: giftWrite
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(revokeGiftLinksSchema)
    .mutation(({ input, ctx }) =>
      revokeGiftLinks({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  claim: giftWrite
    .meta({ requiredScope: TokenScope.ModelsWrite, blockApiKeys: true })
    .input(claimGiftSchema)
    .mutation(({ input, ctx }) => claimGift({ user: ctx.user, code: input.code })),
});
