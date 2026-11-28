import { credentialViews } from '~/server/services/oauth/enforce-token-scope';
import { TRPCError } from '@trpc/server';
import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { refuseProfaneSearch } from '~/server/utils/refuse-profane-search';
import {
  type SemanticImageSearchInput,
  semanticImageSearchSchema,
  semanticSearchFeedbackSchema,
} from '~/server/schema/semantic-image-search.schema';
import {
  createFeedback,
  FEEDBACK_AREA_DISABLED_MESSAGE,
  isFeedbackAreaEnabled,
} from '~/server/services/feedback.service';
import { searchSemanticImages } from '~/server/services/semantic-image-search.service';
import {
  guardedProcedure,
  guardFlagEnabled,
  isFlagProtected,
  middleware,
  publicProcedure,
  router,
} from '~/server/trpc';
import { sleep } from '~/server/utils/concurrency-helpers';
import { getRequestBoardDomainColor } from '~/server/utils/server-domain';
import { FEEDBACK_FILTER_VALUE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

// Without `imageSearch` or `feedSearch` (the images feed answers its ?query= from here), a signed-in
// user may still search their own images: the showcase picker. The request must name exactly their
// username, and it is narrowed to their id, so it cannot reach anyone else's images.
const imageSearchOrOwnImages = middleware(({ ctx, input, next }) => {
  if (guardFlagEnabled(ctx, 'imageSearch') || guardFlagEnabled(ctx, 'feedSearch'))
    return next({ ctx: { ownImagesOf: undefined as number | undefined } });

  const { usernames, userIds, cursor, imageId } = input as SemanticImageSearchInput;
  const username = ctx.user?.username?.toLowerCase();
  const ownOnly =
    !!username &&
    usernames?.length === 1 &&
    usernames[0].toLowerCase() === username &&
    !userIds &&
    // No paging or image-similarity search on this path.
    !cursor &&
    !imageId;
  if (!ownOnly) throw new TRPCError({ code: 'FORBIDDEN' });

  return next({ ctx: { ownImagesOf: ctx.user!.id as number | undefined } });
});

const OWN_IMAGES_PAGE = 25;
// Only what the picker sends; anything else on this path is dropped.
const ownImagesInput = (
  { query, limit, browsingLevel }: SemanticImageSearchInput,
  userId: number
): SemanticImageSearchInput => ({
  query,
  limit: Math.min(limit, OWN_IMAGES_PAGE),
  browsingLevel,
  userIds: [userId],
});

// The own-images path has its own, lower limit: the picker needs no more.
const ownImagesRateLimit = rateLimit(
  { limit: 20, period: 60 },
  (_, ctx) => !!(ctx as { ownImagesOf?: number }).ownImagesOf,
  { sharedKey: 'semanticImageSearch:search:own' }
);

// shortcut: estimated, as own-images latency was not yet logged; re-derive from the `ownImages`
// search log rows.
export const OWN_IMAGES_FLOOR_MS = 200;
export const OWN_IMAGES_JITTER_MS = 500;
const holdOwnImages = async (started: number) => {
  const wait = started + OWN_IMAGES_FLOOR_MS + Math.random() * OWN_IMAGES_JITTER_MS - Date.now();
  if (wait > 0) await sleep(wait);
};

// Refused, not dropped: results that ignore the image or resource asked for would read as answering it.
const refuseUnflaggedFilters = (
  ctx: Parameters<typeof guardFlagEnabled>[0],
  { imageId, modelVersionIds }: SemanticImageSearchInput
) => {
  if (imageId && !guardFlagEnabled(ctx, 'moreLikeThis'))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'More like this is not available yet' });
  if (modelVersionIds?.length && !guardFlagEnabled(ctx, 'imageSearchResources'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Searching by resource is not available yet',
    });
};

// Timed first, so flag and rate-limit refusals land on the dashboard too.
const semanticSearchProcedure = publicProcedure.use(timeSemanticSearch('images'));
const semanticVideoSearchProcedure = publicProcedure.use(timeSemanticSearch('videos'));

export const semanticImageSearchRouter = router({
  search: semanticSearchProcedure
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticImageSearchSchema)
    .use(refuseProfaneSearch)
    .use(imageSearchOrOwnImages)
    .use(ownImagesRateLimit)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const { ownImagesOf } = ctx;
      const asked = ownImagesOf ? ownImagesInput(input, ownImagesOf) : input;
      // Dropped, not refused: a shared ?prefer= link or a stale tab gets plain "more like this".
      const steer =
        guardFlagEnabled(ctx, 'moreLikeThis') && guardFlagEnabled(ctx, 'moreLikeThisSteer');
      const searched = steer ? asked : { ...asked, preferTagIds: undefined };
      refuseUnflaggedFilters(ctx, searched);
      const result = await searchSemanticImages({
        input: searched,
        user: ctx.user,
        ...credentialViews(ctx),
        domain: getRequestBoardDomainColor(ctx.req),
        track: ctx.track,
        refuseNarrowing: !!ownImagesOf,
        tagMatchesFirst: !!ownImagesOf,
      }).catch(async (error) => {
        if (ownImagesOf) await holdOwnImages(started);
        throw error;
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        // Logged as searched, so the row says what ran.
        const { query, imageId, cursor, limit, ...filters } = searched;
        void ctx.track
          .search({
            query: query ?? '',
            index: 'images_semantic',
            filters: {
              ...filters,
              imageId,
              resultCount: result.items.length,
              latencyMs,
              ...(ownImagesOf && { ownImages: true }),
            },
          })
          .catch(() => undefined);
      }

      // The picker reads one page and shows neither a correction nor a timing.
      if (ownImagesOf) {
        await holdOwnImages(started);
        return {
          items: result.items,
          nextCursor: undefined,
          correctedQuery: undefined,
          latencyMs: 0,
          refused: result.refused,
          ...('refusedBy' in result && result.refusedBy !== undefined
            ? { refusedBy: result.refusedBy }
            : {}),
        };
      }
      return { ...result, latencyMs };
    }),

  searchVideos: semanticVideoSearchProcedure
    .use(isFlagProtected('semanticVideoSearch'))
    // As search: signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticImageSearchSchema)
    .use(refuseProfaneSearch)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      refuseUnflaggedFilters(ctx, input);
      const result = await searchSemanticImages({
        input,
        user: ctx.user,
        ...credentialViews(ctx),
        domain: getRequestBoardDomainColor(ctx.req),
        track: ctx.track,
        collection: 'videos',
      });
      const latencyMs = Date.now() - started;
      if (!input.cursor) {
        const { query, imageId, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query: query ?? '',
            index: 'videos_semantic',
            filters: { ...filters, imageId, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }
      return { ...result, latencyMs };
    }),

  feedback: guardedProcedure
    .use(isFlagProtected('imageSearch'))
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
