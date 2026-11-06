import { TRPCError } from '@trpc/server';
import { rateLimit } from '~/server/middleware.trpc';
import {
  semanticImageSearchSchema,
  semanticSearchFeedbackSchema,
} from '~/server/schema/semantic-image-search.schema';
import {
  createFeedback,
  FEEDBACK_AREA_DISABLED_MESSAGE,
  isFeedbackAreaEnabled,
} from '~/server/services/feedback.service';
import { searchSemanticImages } from '~/server/services/semantic-image-search.service';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getRequestBoardDomainColor } from '~/server/utils/server-domain';
import { FEEDBACK_FILTER_VALUE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

const semanticSearchProcedure = protectedProcedure.use(isFlagProtected('semanticImageSearch'));

export const semanticImageSearchRouter = router({
  search: semanticSearchProcedure
    .use(rateLimit({ limit: 60, period: 60 }))
    .input(semanticImageSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticImages({
        input,
        user: ctx.user,
        domain: getRequestBoardDomainColor(ctx.req),
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, imageId, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query: query ?? '',
            index: 'images_semantic',
            filters: { ...filters, imageId, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),

  feedback: guardedProcedure
    .use(isFlagProtected('semanticImageSearch'))
    .use(rateLimit({ limit: 30, period: 60 * 60 }))
    .input(semanticSearchFeedbackSchema)
    .mutation(async ({ input, ctx }) => {
      const area = 'semantic-image-search' as const;
      if (!(await isFeedbackAreaEnabled({ area, user: ctx.user })))
        throw new TRPCError({ code: 'FORBIDDEN', message: FEEDBACK_AREA_DISABLED_MESSAGE });

      const clip = (value?: string) => value?.slice(0, FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      const { rating, comment, query, imageId, filters, resultCount, latencyMs } = input;
      return createFeedback({
        userId: ctx.user.id,
        area,
        message: comment || (rating === 'up' ? 'Thumbs up' : 'Thumbs down'),
        context: {
          path: '/search/semantic',
          filters: Object.fromEntries(
            Object.entries({
              rating,
              query: clip(query),
              imageId,
              filters: clip(filters),
              resultCount,
              latencyMs,
            }).filter(([, v]) => v !== undefined)
          ) as Record<string, string | number>,
        },
      });
    }),
});
