import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { cacheIt } from '~/server/middleware.trpc';
import { getMarkdownContent, getStaticContent } from '~/server/services/content.service';
import { publicProcedure, router } from '~/server/trpc';
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
});
