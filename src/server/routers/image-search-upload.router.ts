import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { countSearchUpload } from '~/server/metrics/semantic-search.metrics';
import { TRPCError } from '@trpc/server';
import { rateLimit } from '~/server/middleware.trpc';
import {
  imageSearchUploadSearchSchema,
  imageSearchUploadStatusSchema,
  prepareImageSearchUploadSchema,
} from '~/server/schema/semantic-image-search.schema';
import {
  claimSearchUploadUserDay,
  getSearchUploadStatus,
  withSearchUploadSearch,
  prepareSearchUpload,
  resolveSearchUploadAnchor,
} from '~/server/services/image-search-upload.service';
import { searchSemanticImages } from '~/server/services/semantic-image-search.service';
import { credentialViews } from '~/server/services/oauth/enforce-token-scope';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getRequestBoardDomainColor } from '~/server/utils/server-domain';

const imageSearchUploadProcedure = protectedProcedure
  .meta({ blockApiKeys: true })
  .use(isFlagProtected('imageSearchUpload'))
  .use(isFlagProtected('moreLikeThis'))
  // Moderator-only until further gates, whatever the flag says.
  .use(({ ctx, next }) => {
    if (!credentialViews(ctx).asModerator) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });

export const imageSearchUploadRouter = router({
  prepare: imageSearchUploadProcedure
    .use(
      rateLimit([
        { limit: 10, period: 10 * 60 },
        { limit: 50, period: 24 * 60 * 60 },
      ])
    )
    .input(prepareImageSearchUploadSchema)
    .mutation(({ input, ctx }) =>
      prepareSearchUpload({
        userId: ctx.user.id,
        url: input.uploadUrl,
        source: input.source,
        req: ctx.req,
      })
    ),

  status: imageSearchUploadProcedure
    .use(rateLimit({ limit: 120, period: 60 }))
    .input(imageSearchUploadStatusSchema)
    .query(({ input, ctx }) =>
      getSearchUploadStatus({
        userId: ctx.user.id,
        uploadId: input.uploadId,
        isModerator: credentialViews(ctx).asModerator && !!ctx.user.isModerator,
      })
    ),

  search: imageSearchUploadProcedure
    .use(timeSemanticSearch('images'))
    .use(rateLimit({ limit: 60, period: 60 }))
    .input(imageSearchUploadSearchSchema)
    .query(async ({ input, ctx }) => {
      // A GET puts the upload URL in the query string, where access logs keep it.
      if (ctx.req.method === 'GET') throw new TRPCError({ code: 'METHOD_NOT_SUPPORTED' });
      return withSearchUploadSearch(ctx.user.id, async () => {
        await claimSearchUploadUserDay({ userId: ctx.user.id, action: 'search', req: ctx.req });
        const views = credentialViews(ctx);
        const uploadAnchor = await resolveSearchUploadAnchor({
          userId: ctx.user.id,
          uploadId: input.uploadId,
          url: input.uploadUrl,
          isModerator: views.asModerator && !!ctx.user.isModerator,
        });
        const started = Date.now();
        const result = await searchSemanticImages({
          input: { browsingLevel: input.browsingLevel, limit: input.limit, cursor: input.cursor },
          user: ctx.user,
          ...views,
          domain: getRequestBoardDomainColor(ctx.req),
          track: ctx.track,
          uploadAnchor,
        });
        if (!input.cursor) countSearchUpload('embedded');
        return { ...result, latencyMs: Date.now() - started };
      });
    }),
});
