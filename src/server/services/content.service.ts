import { readFile } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
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
      lastmod: frontmatter.lastmod ? new Date(frontmatter.lastmod) : undefined,
      content,
    };
  } catch {
    throw throwNotFoundError('Not found');
  }
}

export async function getMarkdownContent({ key }: { key: string }) {
  try {
    const content = await sysRedis.hGet(REDIS_SYS_KEYS.CONTENT.REGION_WARNING, key);
    if (!content) throw throwNotFoundError('Content not found');

    const { data: frontmatter, content: markdown } = matter(content);
    return {
      title: frontmatter.title as string,
      description: frontmatter.description as string,
      content: markdown,
      frontmatter,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'Content not found') throw error;
    throw throwNotFoundError('Content not found');
  }
}

export async function setMarkdownContent({ key, content }: { key: string; content: string }) {
  try {
    await sysRedis.hSet(REDIS_SYS_KEYS.CONTENT.REGION_WARNING, key, content);
    return true;
  } catch (error) {
    throw throwBadRequestError('Failed to save content');
  }
}
