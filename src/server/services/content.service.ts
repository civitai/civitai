import { readFile } from 'fs/promises';
import { access } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { Context } from '~/server/context/types';

const contentRoot = 'src/static-content';
export async function getStaticContent({ slug, ctx }: { slug: string[]; ctx?: Context }) {
  const domainColor = ctx?.domain;

  // Build file paths - check domain-specific first, then fallback to default
  const baseName = [...slug].pop()?.replace('.md', '') ?? '';
  const pathWithoutFile = slug.slice(0, -1);

  const filePaths = [];
  if (domainColor) {
    // Try domain-specific file first (e.g., tos.green.md)
    const domainSpecificPath = join(
      contentRoot,
      ...pathWithoutFile,
      `${baseName}.${domainColor}.md`
    );
    filePaths.push(domainSpecificPath);
  }
  // Fallback to default file (e.g., tos.md)
  const defaultPath = join(contentRoot, ...slug) + '.md';
  filePaths.push(defaultPath);

  // Try to read files in order
  for (const filePath of filePaths) {
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(resolve(contentRoot))) continue; // Skip invalid paths

    try {
      // Check if file exists
      await access(resolvedPath);
      const fileContent = await readFile(resolvedPath, 'utf-8');
      const { data: frontmatter, content } = matter(fileContent);
      return {
        title: frontmatter.title as string,
        description: frontmatter.description as string,
        lastmod: frontmatter.lastmod ? new Date(frontmatter.lastmod) : undefined,
        content,
      };
    } catch {
      // File doesn't exist, try next path
      continue;
    }
  }

  throw throwNotFoundError('Not found');
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
