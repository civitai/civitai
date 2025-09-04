import * as z from 'zod';
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

export const contentRouter = router({
  get: publicProcedure.input(slugSchema).query(({ input, ctx }) => getStaticContent({ ...input, ctx })),
  getMarkdown: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(({ input }) => getMarkdownContent(input)),
  checkTosUpdate: protectedProcedure.query(async ({ ctx }) => {
    const tos = await getStaticContent({ slug: ['tos'] });
    const userSettings = await getUserSettings(ctx.user.id);
    const userTosLastSeen = userSettings.tosLastSeenDate;
    const tosLastMod = tos.lastmod ? new Date(tos.lastmod) : undefined;

    return {
      hasUpdate: !userTosLastSeen || (tosLastMod && tosLastMod > userTosLastSeen),
      lastmod: tosLastMod,
      userLastSeen: userTosLastSeen,
    };
  }),
});
