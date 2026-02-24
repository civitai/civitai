import {
  getBadgeHistoryInput,
  getProductsWithBadgesInput,
  upsertProductBadgeInput,
} from '~/server/schema/product-badge.schema';
import {
  getBadgeHistory,
  getProductsWithBadges,
  upsertProductBadge,
} from '~/server/services/product-badge.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const productBadgeRouter = router({
  getProductsWithBadges: moderatorProcedure.input(getProductsWithBadgesInput).query(({ input }) => {
    return getProductsWithBadges(input);
  }),
  getBadgeHistory: moderatorProcedure.input(getBadgeHistoryInput).query(({ input }) => {
    return getBadgeHistory(input);
  }),
  upsertProductBadge: moderatorProcedure.input(upsertProductBadgeInput).mutation(({ input }) => {
    return upsertProductBadge(input);
  }),
});
