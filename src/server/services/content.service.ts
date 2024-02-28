import { readFile } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

const contentRoot = 'src/static-content';
export async function getStaticContent({ slug }: { slug: string[] }) {
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
