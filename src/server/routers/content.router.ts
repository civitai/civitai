import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { cacheIt } from '~/server/middleware.trpc';
import { getMarkdownContent, getStaticContent } from '~/server/services/content.service';
import { getUserSettings } from '~/server/services/user.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

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

// Map domain colors to ToS field names
const tosFieldMap = {
  green: 'tosGreenLastSeenDate',
  red: 'tosRedLastSeenDate',
  blue: 'tosLastSeenDate', // default
} as const;

export const contentRouter = router({
  get: publicProcedure
    .input(slugSchema)
    .query(({ input, ctx }) => getStaticContent({ ...input, ctx })),
  getMarkdown: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(({ input }) => getMarkdownContent(input)),
  checkTosUpdate: protectedProcedure.query(async ({ ctx }) => {
    const tos = await getStaticContent({ slug: ['tos'], ctx });
    const userSettings = ctx.user ? await getUserSettings(ctx.user.id) : {};

    // Get domain color from request context to determine which ToS field to check
    const domainColor = ctx.domain;
    const tosFieldKey = tosFieldMap[domainColor as keyof typeof tosFieldMap] || 'tosLastSeenDate';
    const userTosLastSeen = userSettings[tosFieldKey] as Date | undefined;
    const tosLastMod = tos.lastmod ? new Date(tos.lastmod) : undefined;

    return {
      hasUpdate: !userTosLastSeen || (tosLastMod && tosLastMod > userTosLastSeen),
      lastmod: tosLastMod,
      userLastSeen: userTosLastSeen,
      domainColor,
      tosFieldKey,
    };
  }),
});
