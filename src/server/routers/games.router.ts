import * as z from 'zod';
import { ComputeCost, GAME_TOKEN_LENGTH } from '~/components/Chopped/chopped.utils';
import { env as clientEnv } from '~/env/client';
import { env } from '~/env/server';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  addImageRatingSchema,
  cleanseSmiteSchema,
  getHistorySchema,
  getImageRatersSchema,
  getImagesQueueSchema,
  getPlayersInfiniteSchema,
  resetPlayerByIdSchema,
  smitePlayerSchema,
} from '~/server/schema/games/new-order.schema';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import {
  addImageRating,
  cleanseSmite,
  getImageRaters,
  getImagesQueue,
  getPlayerById,
  getPlayerHistory,
  getPlayersInfinite,
  joinGame,
  resetPlayer,
  smitePlayer,
} from '~/server/services/games/new-order.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  router,
} from '~/server/trpc';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { generateToken } from '~/utils/string-helpers';

const newGameSchema = z.object({
  themeIds: z.array(z.string()).min(1),
  judgeIds: z.array(z.string()).min(1),
  name: z.string(),
  includeAudio: z.boolean(),
  viewOnly: z.boolean(),
  maxPlayers: z.number().max(10).min(2),
});

async function createGameInstance(code: string) {
  const response = await fetch(`${clientEnv.NEXT_PUBLIC_CHOPPED_ENDPOINT}/chopped/new`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      token: env.CHOPPED_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to create game instance');
  }

  return code;
}

export const gamesRouter = router({
  chopped: router({
    start: protectedProcedure.input(newGameSchema).mutation(async ({ ctx, input }) => {
      const code = generateToken(GAME_TOKEN_LENGTH).toUpperCase();
      const cost = ComputeCost(input);
      const { transactionId } = await createBuzzTransaction({
        fromAccountId: ctx.user.id,
        toAccountId: 0,
        amount: cost,
        type: TransactionType.Purchase,
        description: `Chopped game (${code}): ${input.themeIds.length} rounds + ${
          input.includeAudio ? 'audio' : 'no audio'
        }`,
        externalTransactionId: 'chopped-' + code,
      });
      if (!transactionId) {
        throw new Error('Failed to create transaction');
      }

      try {
        await createGameInstance(code);
      } catch (error) {
        await refundTransaction(transactionId, 'Failed to create game instance');
      }

      return { code };
    }),
  }),
  newOrder: router({
    join: guardedProcedure
      .use(isFlagProtected('newOrderGame'))
      .mutation(({ ctx }) => joinGame({ userId: ctx.user.id })),
    getPlayer: guardedProcedure
      .use(isFlagProtected('newOrderGame'))
      .query(({ ctx }) => getPlayerById({ playerId: ctx.user.id })),
    getPlayers: moderatorProcedure
      .input(getPlayersInfiniteSchema)
      .use(isFlagProtected('newOrderGame'))
      .query(({ input }) => getPlayersInfinite({ ...input })),
    getImagesQueue: guardedProcedure
      .use(isFlagProtected('newOrderGame'))
      .input(getImagesQueueSchema.optional())
      .query(({ input, ctx }) =>
        getImagesQueue({ ...input, playerId: ctx.user.id, isModerator: ctx.user.isModerator })
      ),
    getHistory: guardedProcedure
      .input(getHistorySchema)
      .use(isFlagProtected('newOrderGame'))
      .query(({ input, ctx }) => getPlayerHistory({ ...input, playerId: ctx.user.id })),
    smitePlayer: moderatorProcedure
      .input(smitePlayerSchema)
      .use(isFlagProtected('newOrderGame'))
      .mutation(({ input, ctx }) => smitePlayer({ ...input, modId: ctx.user.id })),
    cleanseSmite: moderatorProcedure
      .input(cleanseSmiteSchema)
      .use(isFlagProtected('newOrderGame'))
      .mutation(({ input }) => cleanseSmite({ ...input })),
    addRating: guardedProcedure
      .input(addImageRatingSchema)
      .use(isFlagProtected('newOrderGame'))
      .mutation(({ input, ctx }) =>
        addImageRating({
          ...input,
          playerId: ctx.user.id,
          chTracker: ctx.track,
          isModerator: ctx.user.isModerator,
        })
      ),
    resetCareer: guardedProcedure
      .use(isFlagProtected('newOrderGame'))
      .mutation(({ ctx }) => resetPlayer({ playerId: ctx.user.id })),
    resetPlayerById: moderatorProcedure
      .input(resetPlayerByIdSchema)
      .use(isFlagProtected('newOrderGame'))
      .use(isFlagProtected('newOrderReset'))
      .mutation(({ input }) => resetPlayer({ ...input, withNotification: true })),
    getImageRaters: moderatorProcedure
      .input(getImageRatersSchema)
      .use(isFlagProtected('newOrderGame'))
      .query(async ({ input }) => {
        const ratings = await getImageRaters({ imageIds: [input.imageId] });
        if (!ratings || !ratings[input.imageId])
          return { [NewOrderRankType.Knight]: [], [NewOrderRankType.Templar]: [] };

        return ratings[input.imageId];
      }),
  }),
});
