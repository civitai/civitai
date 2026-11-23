import { TRPCError } from '@trpc/server';
import { profaneSearchCheck } from '~/server/services/profanity-list.service';
import { middleware } from '~/server/trpc';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

/**
 * Refuses a profane semantic search on civitai.com before it runs: UNPROCESSABLE_CONTENT whose
 * message is `SEARCH_REFUSED_CODE`, a verdict only, never which word matched. Reads `input.query`.
 */
export const refuseProfaneSearch = middleware(async ({ ctx, input, next }) => {
  const query = (input as { query?: unknown } | undefined)?.query;
  if (!ctx.features.isGreen || typeof query !== 'string') return next();
  if ((await profaneSearchCheck([query])) === 'profane')
    throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: SEARCH_REFUSED_CODE });
  return next();
});
