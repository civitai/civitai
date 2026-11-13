import * as z from 'zod';
import {
  router,
  publicProcedure,
  guardedProcedure,
  protectedProcedure,
  moderatorProcedure,
  isFlagProtected,
  middleware,
} from '~/server/trpc';
import type { UpsertArticleInput } from '~/server/schema/article.schema';
import {
  getInfiniteArticlesSchema,
  upsertArticleInput,
  articleRateLimits,
  unpublishArticleSchema,
  resolveArticleImageScanSchema,
  rescanArticleImageSchema,
  setArticleOfficialSchema,
  createArticleShareLinkSchema,
  getArticleShareLinksSchema,
  getSharedArticleSchema,
  openShareLinkSchema,
  articleShareTokenRateLimits,
  articleShareCreateRateLimits,
} from '~/server/schema/article.schema';
import {
  createArticleShareLink,
  getArticleByShareToken,
  getArticleShareLinks,
  openArticleShareLink,
  revokeArticleShareLink,
} from '~/server/services/article-share.service';
import { articleShareCookieName } from '~/server/services/article-share.helpers';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteArticleById,
  getArticleById,
  getArticles,
  getOfficialArticleTag,
  setArticleOfficial,
  getArticleScanStatus,
  isArticleProcessing,
  getCivitaiNews,
  getDraftArticlesByUserId,
  rescanArticle,
  resolveArticleImageScan,
  rescanArticleImage,
} from '~/server/services/article.service';
import {
  unpublishArticleHandler,
  upsertArticleHandler,
} from '~/server/controllers/article.controller';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { logToAxiom } from '~/server/logging/client';
import { getEventDecorationsForEntity } from '~/server/services/cosmetic.service';
import { eventViewerOf } from '~/server/events/event-viewer';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { isArticleServableWhenRestricted } from '~/server/utils/article-region';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { getCaller } from '~/server/routers/remix-app.router';
import {
  keepArticleReframe,
  quoteArticleReframe,
  submitArticleReframe,
} from '~/server/services/article-reframe.service';

const reframeTarget = z.enum(['banner', 'cover']);
const reframeSource = z.object({ imageId: z.number().int().positive(), target: reframeTarget });
/** Each quote and each submit runs an orchestrator what-if. */
const reframeRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  if (!isModerator && !!id) {
    const ownerId = (await dbRead.article.findUnique({ where: { id }, select: { userId: true } }))
      ?.userId;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      user: ctx.user,
    },
  });
});

export const articleRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getInfiniteArticlesSchema)
    .query(({ input, ctx }) =>
      getArticles({
        ...input,
        sessionUser: ctx?.user,
        include: ['cosmetics'],
        // Uncached per viewer, so a flagged viewer may see decorations before launch.
        eventDecorationViewer: eventViewerOf(ctx),
      })
    ),
  getCivitaiNews: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getCivitaiNews()),
  // `tag.getAll` hides adminOnly tags from non-admins; the feed's chip row needs this one's id.
  getOfficialTag: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(() => getOfficialArticleTag()),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getByIdSchema)
    .query(async ({ input, ctx }) => {
      const [article, eventDecorations] = await Promise.all([
        getArticleById({
          ...input,
          userId: ctx.user?.id,
          isModerator: ctx.user?.isModerator,
        }),
        // The hat the cover wears. A signed-out response is edge-cached for every signed-out
        // viewer (createContext), so the hat gate must read nothing but the user.
        // A hat is decoration: its lookup failing must not fail the article.
        getEventDecorationsForEntity({
          ids: [input.id],
          entity: 'Article',
          viewer: eventViewerOf(ctx),
        }).catch((error) => {
          logToAxiom({
            type: 'error',
            name: 'article-get-event-decoration',
            message: (error as Error).message,
            articleId: input.id,
          }).catch(() => undefined);
          return {} as Awaited<ReturnType<typeof getEventDecorationsForEntity>>;
        }),
      ]);
      // Region-dependent above SFW: a restricted region gets the same NOT_FOUND as a missing article
      // (as on /api/v1/articles/[id]), its owner and moderators excepted, and the answer stays out of
      // the edge cache, which does not key on region.
      if (!isArticleServableWhenRestricted(article)) {
        // A moderator only on a session or a full-access personal key, as for moderatorProcedure.
        const viewerMayRead =
          eventViewerOf(ctx).isModerator || (!!ctx.user && ctx.user.id === article.userId);
        if (!viewerMayRead && isRegionRestricted(getRegion(ctx.req)))
          throw throwNotFoundError(`No article with id ${input.id}`);
        if (ctx.cache) {
          ctx.cache.edgeTTL = 0;
          ctx.cache.browserTTL = 0;
          ctx.cache.staleWhileRevalidate = 0;
        }
      }
      return { ...article, eventDecoration: eventDecorations[article.id] ?? null };
    }),
  // Deliberately narrower than `getScanStatus`, which is owner/moderator-facing and returns
  // per-image blocked/error detail. This answers only "come back in a minute" for a viewer
  // `getById` just refused, so it must not distinguish Blocked from never-existed.
  isProcessing: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getByIdSchema)
    .query(({ input }) => isArticleProcessing(input)),
  // Draft share links. The token is accepted by `openShareLink` (once, to set the cookie) and read
  // from that cookie by `getShared`; nothing else reads it.
  createShareLink: guardedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(createArticleShareLinkSchema)
    .use(isFlagProtected('articleCreate'))
    .use(rateLimit(articleShareCreateRateLimits))
    .mutation(({ input, ctx }) => createArticleShareLink({ ...input, userId: ctx.user.id })),
  getShareLinks: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getArticleShareLinksSchema)
    .query(({ input, ctx }) =>
      getArticleShareLinks({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  revokeShareLink: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      revokeArticleShareLink({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  // Called only by the link page's server render, which turns a valid token into a cookie.
  openShareLink: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(openShareLinkSchema)
    .use(rateLimit(articleShareTokenRateLimits, undefined, { sharedKey: 'article:share-token' }))
    .query(({ input, ctx }) => {
      // The token is in this query's input: never let a cache keep the answer.
      if (ctx.cache) Object.assign(ctx.cache, { skip: true, edgeTTL: 0, browserTTL: 0 });
      return openArticleShareLink(input.shareToken);
    }),
  // The token arrives in its HttpOnly cookie, never in the input. A mutation, so no cache keeps it.
  getShared: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getSharedArticleSchema)
    .use(rateLimit(articleShareTokenRateLimits, undefined, { sharedKey: 'article:share-token' }))
    .mutation(({ input, ctx }) =>
      getArticleByShareToken({
        articleId: input.articleId,
        shareToken: ctx.req?.cookies?.[articleShareCookieName(input.articleId)],
        viewerId: ctx.user?.id,
      })
    ),
  getMyDraftArticles: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getAllQuerySchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) => getDraftArticlesByUserId({ ...input, userId: ctx.user.id })),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(upsertArticleInput)
    .use(isFlagProtected('articleCreate'))
    .use(
      rateLimit(articleRateLimits, (input: UpsertArticleInput) => !input.id, {
        onlyCountSuccess: true,
      })
    )
    .mutation(upsertArticleHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesDelete })
    .input(getByIdSchema)
    .use(isFlagProtected('articleCreate'))
    .mutation(async ({ input, ctx }) => {
      const result = await deleteArticleById({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });
      await ctx.track.article({ type: 'Delete', articleId: input.id, nsfw: false });
      return result;
    }),
  unpublish: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(unpublishArticleSchema)
    .use(isFlagProtected('articles'))
    .use(isOwnerOrModerator)
    .mutation(unpublishArticleHandler),
  rescan: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .use(isOwnerOrModerator)
    .mutation(({ input, ctx }) => rescanArticle({ ...input, isModerator: ctx.user.isModerator })),
  // Author-facing scan detail: per-image URLs, `blockedFor` moderation labels, scan failure
  // reasons and the article's text-moderation verdict, for any id including an unpublished
  // draft. Same guard as its `rescan` sibling, which takes the same input — every caller is
  // the author's own editor or their article page behind `isOwner`.
  getScanStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .use(isOwnerOrModerator)
    .query(({ input }) => getArticleScanStatus(input)),
  resolveImageScan: moderatorProcedure
    .input(resolveArticleImageScanSchema)
    .use(isFlagProtected('articleImageScanning'))
    .mutation(({ input, ctx }) => resolveArticleImageScan({ ...input, userId: ctx.user.id })),
  rescanImage: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(rescanArticleImageSchema)
    .use(isFlagProtected('articleImageScanning'))
    .mutation(({ input, ctx }) =>
      rescanArticleImage({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
  reframeQuote: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(reframeSource)
    .use(isFlagProtected('articleTypography'))
    .use(reframeRateLimit)
    .query(async ({ input, ctx }) =>
      quoteArticleReframe({ ...input, caller: await getCaller(ctx) })
    ),
  reframeSubmit: guardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      reframeSource.extend({
        quote: z.number().int().nonnegative(),
        nonce: z.string().min(8).max(64),
      })
    )
    .use(isFlagProtected('articleTypography'))
    .use(reframeRateLimit)
    .mutation(async ({ input, ctx }) =>
      submitArticleReframe({ ...input, caller: await getCaller(ctx) })
    ),
  reframeKeep: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ workflowId: z.string().min(1).max(64), target: reframeTarget }))
    .use(isFlagProtected('articleTypography'))
    .use(reframeRateLimit)
    .mutation(async ({ input, ctx }) =>
      keepArticleReframe({ ...input, caller: await getCaller(ctx) })
    ),
  // Moderator-only, exactly like `model.setOfficial`. This is a provenance claim, so the
  // authority is the procedure, not anything in the payload.
  setOfficial: moderatorProcedure
    .input(setArticleOfficialSchema)
    .mutation(({ input, ctx }) =>
      setArticleOfficial({ ...input, isModerator: ctx.user.isModerator ?? false })
    ),
});
