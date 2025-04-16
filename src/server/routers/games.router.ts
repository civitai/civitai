import { z } from 'zod';
import { ComputeCost, GAME_TOKEN_LENGTH } from '~/components/Chopped/chopped.utils';
import { env as clientEnv } from '~/env/client';
import { env } from '~/env/server';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  addImageRatingSchema,
  cleanseSmiteSchema,
  getHistorySchema,
  getImageQueueSchema,
  smitePlayerSchema,
} from '~/server/schema/games/new-order.schema';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import {
  addImageRating,
  cleanseSmite,
  getImagesQueue,
  getPlayerById,
  getPlayerHistory,
  joinGame,
  resetPlayer,
  smitePlayer,
} from '~/server/services/games/new-order.service';
import { guardedProcedure, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
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
    join: guardedProcedure.mutation(({ ctx }) => joinGame({ userId: ctx.user.id })),
    getPlayer: guardedProcedure.query(({ ctx }) => getPlayerById({ playerId: ctx.user.id })),
    getImagesQueue: guardedProcedure
      .input(getImageQueueSchema.optional())
      .query(({ input, ctx }) =>
        getImagesQueue({ ...input, playerId: ctx.user.id, isModerator: ctx.user.isModerator })
      ),
    getHistory: guardedProcedure
      .input(getHistorySchema)
      .query(({ input, ctx }) => getPlayerHistory({ ...input, playerId: ctx.user.id })),
    smitePlayer: moderatorProcedure
      .input(smitePlayerSchema)
      .mutation(({ input, ctx }) => smitePlayer({ ...input, modId: ctx.user.id })),
    cleanseSmite: moderatorProcedure
      .input(cleanseSmiteSchema)
      .mutation(({ input }) => cleanseSmite({ ...input })),
    addRating: guardedProcedure
      .input(addImageRatingSchema)
      .mutation(({ input, ctx }) =>
        addImageRating({ ...input, playerId: ctx.user.id, chTracker: ctx.track })
      ),
    resetCareer: guardedProcedure.mutation(({ ctx }) => resetPlayer({ playerId: ctx.user.id })),
  }),
});
