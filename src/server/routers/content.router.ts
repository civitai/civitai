import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { cacheIt } from '~/server/middleware.trpc';
import {
  checkTosUpdate,
  getMarkdownContent,
  getStaticContent,
} from '~/server/services/content.service';
import { getUserSettings } from '~/server/services/user.service';
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
  checkTosUpdate: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .query(async ({ ctx }) => {
      const userSettings = ctx.user ? await getUserSettings(ctx.user.id) : {};
      // Shared computation — also used by the SSR seed in _app getInitialProps.
      return checkTosUpdate({ domainColor: ctx.domain, userSettings });
    }),
});
