import * as z from 'zod/v4';
import { getMarkdownContent, getStaticContent } from '~/server/services/content.service';
import { publicProcedure, router } from '~/server/trpc';

const slugSchema = z.object({
  slug: z.preprocess(
    (v) => (Array.isArray(v) ? (v as string[]) : (v as string).split('/')),
    z.array(
      z.string().refine((value) => /^[\w-]+$/.test(value), {
        message: 'Invalid slug segment',
      })
    )
  ),
});

export const contentRouter = router({
  get: publicProcedure.input(slugSchema).query(({ input }) => getStaticContent(input)),
  getMarkdown: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(({ input }) => getMarkdownContent(input)),
});
