import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import { postRateLimits } from '~/server/schema/post.schema';
import { PostIntentRefusal } from '~/server/services/post-intent/post-intent.logic';
import { publishIntent, stageIntent } from '~/server/services/post-intent/post-intent.service';
import { guardedProcedure, isFlagProtected, router } from '~/server/trpc';

const manifestInput = z.object({ manifestUrl: z.url() });

function toTrpcError(err: unknown): never {
  if (err instanceof PostIntentRefusal) {
    const code =
      err.code === 'rate-limited' || err.code === 'busy'
        ? 'TOO_MANY_REQUESTS'
        : err.code === 'already-posted' || err.code === 'claimed'
        ? 'CONFLICT'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

const postIntentProcedure = guardedProcedure.use(isFlagProtected('appPostIntent'));

export const postIntentRouter = router({
  stage: postIntentProcedure
    .input(manifestInput)
    .mutation(({ ctx, input }) =>
      stageIntent({ manifestUrl: input.manifestUrl, userId: ctx.user.id }).catch(toTrpcError)
    ),
  publish: postIntentProcedure
    .input(
      manifestInput.extend({
        title: z.string().max(255).nullish(),
        description: z.string().max(10_000).nullish(),
        tags: z.array(z.string().max(50)).max(POST_TAG_LIMIT).optional(),
        publish: z.boolean(),
      })
    )
    .use(rateLimit(postRateLimits, undefined, { sharedKey: 'post:create' }))
    .mutation(({ ctx, input }) =>
      publishIntent({ ...input, userId: ctx.user.id }).catch(toTrpcError)
    ),
});
