import { readFile } from 'fs/promises';
import { access } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { Context } from '~/server/createContext';

const contentRoot = 'src/static-content';

type StaticContentResult = {
  title: string;
  description: string;
  lastmod: Date | undefined;
  content: string;
};

// Static-content files are bundled into the image and read-only at runtime — they
// change only on deploy (new deploy = new process = fresh cache). `getStaticContent`
// is now on the SSR critical path (ToS checks run in `_app` getInitialProps on every
// logged-in full render via `checkTosUpdate`), so an uncached `readFile` + gray-matter
// parse per call is wasteful. Cache parsed results in-memory with a short TTL; keyed
// by slug + domain so domain-specific variants (e.g. tos.green.md) don't collide. The
// key set is bounded by the (small, fixed) number of static-content files × domains.
// NOTE: runtime content edits go through the SEPARATE redis-backed get/setMarkdownContent
// path, not these files — so this cache cannot serve stale user-editable content.
const STATIC_CONTENT_TTL_MS = 5 * 60 * 1000;
const staticContentCache = new Map<string, { value: StaticContentResult; expires: number }>();

export async function getStaticContent({ slug, ctx }: { slug: string[]; ctx?: Context }) {
  const domainColor = ctx?.domain;

  const cacheKey = `${slug.join('/')}::${domainColor ?? ''}`;
  const cached = staticContentCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

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
      const value: StaticContentResult = {
        title: frontmatter.title as string,
        description: frontmatter.description as string,
        lastmod: frontmatter.lastmod ? new Date(frontmatter.lastmod) : undefined,
        content,
      };
      staticContentCache.set(cacheKey, { value, expires: Date.now() + STATIC_CONTENT_TTL_MS });
      return value;
    } catch {
      // File doesn't exist, try next path
      continue;
    }
  }

  throw throwNotFoundError('Not found');
}

// Map domain colors to ToS field names. Single source of truth shared by the
// `content.checkTosUpdate` resolver and the SSR seed in _app getInitialProps.
export const tosFieldMap = {
  green: 'tosGreenLastSeenDate',
  red: 'tosRedLastSeenDate',
  blue: 'tosLastSeenDate', // default
} as const;

export type CheckTosUpdateResult = {
  // Matches the original resolver expression exactly: `!userTosLastSeen` is a
  // boolean, the right branch is `Date | undefined` (truthy when an update
  // exists). Consumers only read it for truthiness, so the union is preserved
  // verbatim to keep the SSR seed byte-identical to a live fetch.
  hasUpdate: boolean | Date | undefined;
  lastmod: Date | undefined;
  userLastSeen: Date | undefined;
  domainColor: string | undefined;
  tosFieldKey: (typeof tosFieldMap)[keyof typeof tosFieldMap];
};

/**
 * Pure-ish computation of the `content.checkTosUpdate` result. Single source of
 * truth shared by the tRPC resolver and the SSR seed in _app getInitialProps so
 * the injected initialData byte-matches a live fetch.
 *
 * @param domainColor the request's resolved domain color (green/red/blue)
 * @param userSettings the user's JSON settings (reads `tos*LastSeenDate`)
 */
// Only the three ToS-last-seen fields are read here. Typed structurally so both
// `UserSettingsSchema` (resolver) and `UserContentSettings` (SSR seed) — and the
// `{}` no-settings case — are assignable without an index-signature cast.
type TosUserSettings = Partial<
  Record<(typeof tosFieldMap)[keyof typeof tosFieldMap], Date | string | null>
>;

export async function checkTosUpdate({
  domainColor,
  userSettings,
}: {
  domainColor: string | undefined;
  userSettings: TosUserSettings;
}): Promise<CheckTosUpdateResult> {
  const tos = await getStaticContent({ slug: ['tos'], ctx: { domain: domainColor } as Context });

  const tosFieldKey = tosFieldMap[domainColor as keyof typeof tosFieldMap] || 'tosLastSeenDate';
  const userTosLastSeenRaw = userSettings[tosFieldKey] as Date | string | undefined;
  const userTosLastSeen = userTosLastSeenRaw ? new Date(userTosLastSeenRaw) : undefined;
  const tosLastMod = tos.lastmod ? new Date(tos.lastmod) : undefined;

  return {
    hasUpdate: !userTosLastSeen || (tosLastMod && tosLastMod > userTosLastSeen),
    lastmod: tosLastMod,
    userLastSeen: userTosLastSeen,
    domainColor,
    tosFieldKey,
  };
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
