import { router, moderatorProcedure } from '~/server/trpc';
import {
  getRewardsBonusEventsPagedSchema,
  upsertRewardsBonusEventSchema,
} from '~/server/schema/rewards-bonus-event.schema';
import {
  deleteRewardsBonusEvent,
  getRewardsBonusEventById,
  getRewardsBonusEventsPaged,
  upsertRewardsBonusEvent,
} from '~/server/services/rewards-bonus-event.service';
import { getByIdSchema } from '~/server/schema/base.schema';

export const rewardsBonusEventRouter = router({
  upsert: moderatorProcedure
    .input(upsertRewardsBonusEventSchema)
    .mutation(({ input, ctx }) => upsertRewardsBonusEvent(input, ctx.user.id)),
  delete: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteRewardsBonusEvent(input.id)),
  getById: moderatorProcedure
    .input(getByIdSchema)
    .query(({ input }) => getRewardsBonusEventById(input.id)),
  getPaged: moderatorProcedure
    .input(getRewardsBonusEventsPagedSchema)
    .query(({ input }) => getRewardsBonusEventsPaged(input)),
});
