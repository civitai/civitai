import { readFile } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { z } from 'zod';
import { publicProcedure, router } from '~/server/trpc';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

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
type Slug = z.infer<typeof slugSchema>;

const contentRoot = 'src/static-content';
async function getContentHandler({ input: { slug } }: { input: Slug }) {
  // Confirm path
  const filePath = join(contentRoot, ...slug) + '.md';
  const resolvedPath = resolve(filePath);
  if (!resolvedPath.startsWith(resolve(contentRoot))) throw throwBadRequestError('Invalid slug');

  // Read file
  try {
    const fileContent = await readFile(resolvedPath, 'utf-8');
    const { data: frontmatter, content } = matter(fileContent);
    return {
      title: frontmatter.title as string,
      description: frontmatter.description as string,
      content,
    };
  } catch {
    throw throwNotFoundError('Not found');
  }
}

export const contentRouter = router({
  get: publicProcedure.input(slugSchema).query(getContentHandler),
});
