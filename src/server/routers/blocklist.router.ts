import { router, moderatorProcedure } from '~/server/trpc';

import {
  getBlocklistSchema,
  removeBlocklistItemSchema,
  upsertBlocklistSchema,
} from '~/server/schema/blocklist.schema';
import {
  getBlocklistDTO,
  removeBlocklistItems,
  upsertBlocklist,
} from '~/server/services/blocklist.service';

export const blocklistRouter = router({
  upsertBlocklist: moderatorProcedure
    .input(upsertBlocklistSchema)
    .mutation(({ input }) => upsertBlocklist(input)),
  removeItems: moderatorProcedure
    .input(removeBlocklistItemSchema)
    .mutation(({ input }) => removeBlocklistItems(input)),
  getBlocklist: moderatorProcedure
    .input(getBlocklistSchema)
    .query(({ input }) => getBlocklistDTO(input)),
});
