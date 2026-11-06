import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { getEmbedAvailabilityHandler } from '~/server/controllers/civitai-embed.controller';
import { cacheIt, rateLimit } from '~/server/middleware.trpc';
import { getEmbedAvailabilitySchema } from '~/server/schema/civitai-embed.schema';
import { getMarkdownContent, getStaticContent } from '~/server/services/content.service';
import { resolveBandcampEmbed } from '~/server/services/embed-lookup.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const slugSchema = z.object({
  slug: z.preprocess(
    (v) => (Array.isArray(v) ? (v as string[]) : (v as string).split('/')),
    z.array(
      z.string().refine((value) => /^[\w-]+$/.test(value), {
        error: 'Invalid slug segment',
      })
    )
  ),
});

export const contentRouter = router({
  get: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(slugSchema)
    .query(({ input, ctx }) => getStaticContent({ ...input, ctx })),
  getMarkdown: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ key: z.string() }))
    .query(({ input }) => getMarkdownContent(input)),
  /** Bandcamp page URL -> player URL, for the editor's Embed dialog. Fetches Bandcamp hosts only. */
  resolveBandcampEmbed: protectedProcedure
    .meta({ blockApiKeys: true })
    .input(z.object({ url: z.string().max(500) }))
    .use(rateLimit({ limit: 30, period: 60 * 60 }))
    .mutation(({ input }) => resolveBandcampEmbed(input.url)),
  /** Article cards a reader can't see: content-free, so mature-off readers get a placeholder. */
  getEmbedAvailability: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getEmbedAvailabilitySchema)
    .use(rateLimit({ limit: 300, period: 60 * 60 }))
    .query(getEmbedAvailabilityHandler),
});
