import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { access } from 'fs/promises';
import matter from 'gray-matter';
import { join, resolve } from 'path';
import { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } from '~/server/redis/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { Context } from '~/server/createContext';

const contentRoot = 'src/static-content';

type StaticContentResult = {
  title: string;
  description: string;
  lastmod: Date | undefined;
  content: string;
  // sha256 of the body ONLY (frontmatter excluded). This is the trigger signal
  // for the ToS-update modal: it changes iff the terms text changes, so a stray
  // `lastmod` bump (or any frontmatter edit) can't force a global re-accept.
  hash: string;
};

// Hash the rendered body, not the raw file or re-serialized doc — gray-matter
// has already stripped the frontmatter, so `lastmod`/`title` never feed the hash.
// Normalize line endings + trailing whitespace so cosmetic/EOL churn is inert.
function hashContent(content: string) {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized).digest('hex');
}

// Static-content files are bundled into the image and read-only at runtime — they
// change only on deploy (new deploy = new process = fresh cache). `getStaticContent`
// is now on the SSR critical path (ToS metadata is resolved on every full render
// via `getTosMeta`), so an uncached `readFile` + gray-matter
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
        hash: hashContent(content),
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
// `getTosMeta` resolver and the client-side comparison in `useToSUpdateModal`.
// The date fields are written on accept for audit ("when did they last accept")
// but no longer drive the show/hide decision — that's purely hash-based now.
export const tosFieldMap = {
  green: 'tosGreenLastSeenDate',
  red: 'tosRedLastSeenDate',
  blue: 'tosLastSeenDate', // default
} as const;

// Parallel map of the per-domain settings field that stores the content hash the
// user last accepted. This is the ONLY trigger signal: re-prompt iff the current
// body hash differs from the user's stored (or default-baseline) hash.
export const tosHashFieldMap = {
  green: 'tosGreenAcceptedHash',
  red: 'tosRedAcceptedHash',
  blue: 'tosAcceptedHash', // default
} as const;

// Body hashes of the ToS as of the hash-mechanism rollout. Used as the DEFAULT
// "accepted hash" for any user who has none recorded — so existing users are
// credited with having accepted the rollout text WITHOUT a data backfill, and are
// re-prompted only once the body changes away from this baseline. (red has no
// tos.red.md, so it falls back to tos.md → same hash as blue.)
//
// IMPORTANT: these must equal `hashContent(<deployed body>)` for each domain at
// rollout. Regenerate (gray-matter body → CRLF→LF → trimEnd → sha256) ONLY if you
// deliberately intend a body change to re-prompt the not-yet-hash-backed users.
export const tosBaselineHashMap = {
  green: '8dd1cc867cdd5f320ca139243c4533871f0e5a1dbd8c23df3770f77020a6b293',
  red: '33d6e2d123ef60d6f7a3eb1b0988879a957b13a6b6fffe63bd35f2a7f0b4748a',
  blue: '33d6e2d123ef60d6f7a3eb1b0988879a957b13a6b6fffe63bd35f2a7f0b4748a', // default
} as const;

// Aliases a new body hash back to the hash users already accepted, for edits that
// carry no legal meaning (typo/punctuation fixes). Keyed by the NEW hash, valued
// with the OLD one, so `getTosMeta` advertises the old content identity and the
// client's stored-vs-current comparison stays equal — no re-prompt. The next real
// edit produces an unmapped hash and re-prompts as normal.
//
// Resolution is a single lookup, NOT transitive: a later cosmetic edit must map its
// hash to the same original anchor, never to an intermediate key, or the alias
// resolves to a hash nobody has stored and everyone is re-prompted.
const tosHashOverrideMap: Record<string, string> = {
  // 2026-07-20 §9.2 "unless a another license" -> "unless another license"
  '9fd2f1de839bd54420c16ee18bd3a6be64e8de6e80b8ba98c1c6b034d2684996': // tos.md (blue/red)
    'f25e3738258c4bc10f41131b9f695430e387cb17b6a081d16b6235a5bcd33ae4',
  'fd2d6aab421c43e48513d67e233f17c7faa5216b50470324d31c2f5955f53ecc': // tos.green.md
    '7777d54b7357eb7b1aea4f05c96f2c664d24d5311cb5db8b75ed92e172398d87',
};

/**
 * The ToS content identity to compare against and persist on accept. Every writer
 * of a `tos*AcceptedHash` MUST go through this — writing a raw `getStaticContent`
 * hash while `getTosMeta` advertises an alias would leave the user permanently
 * mismatched, and thus permanently prompted.
 */
export function resolveTosHash(hash: string) {
  return tosHashOverrideMap[hash] ?? hash;
}

// The static, per-domain ToS metadata the client needs to decide whether to show
// the ToS modal. It depends ONLY on the deployed content + frozen baseline, never
// on the user — the per-user comparison happens client-side against the already-
// seeded `user.getSettings`. Every field is a plain string, so the object survives
// the pageProps JSON round-trip with no revival needed.
export type TosMeta = {
  hash: string;
  // The default accepted-hash for users with none stored (see tosBaselineHashMap).
  baselineHash: string;
  // The per-domain settings fields the client compares against (hash) and writes
  // on accept (both). Resolved here so the client never imports the domain maps
  // (and thus never pulls this fs-touching module into its bundle).
  fieldKey: (typeof tosFieldMap)[keyof typeof tosFieldMap];
  hashFieldKey: (typeof tosHashFieldMap)[keyof typeof tosHashFieldMap];
};

/**
 * Resolve the static ToS metadata for a domain. Cheap and cached (rides the
 * in-memory `getStaticContent` cache), and — unlike the old `checkTosUpdate` —
 * takes no user settings: the modal's show/hide decision is computed client-side
 * from the seeded `user.getSettings` against this metadata.
 *
 * @param domainColor the request's resolved domain color (green/red/blue)
 */
export async function getTosMeta({
  domainColor,
}: {
  domainColor: string | undefined;
}): Promise<TosMeta> {
  const tos = await getStaticContent({ slug: ['tos'], ctx: { domain: domainColor } as Context });
  return {
    hash: resolveTosHash(tos.hash),
    baselineHash:
      tosBaselineHashMap[domainColor as keyof typeof tosBaselineHashMap] || tosBaselineHashMap.blue,
    fieldKey: tosFieldMap[domainColor as keyof typeof tosFieldMap] || 'tosLastSeenDate',
    hashFieldKey: tosHashFieldMap[domainColor as keyof typeof tosHashFieldMap] || 'tosAcceptedHash',
  };
}

export async function getMarkdownContent({ key }: { key: string }) {
  try {
    // Wall-clock deadline: bounds a silent sysRedis half-open (this awaited hGet
    // would otherwise park ~11min on the region-warning content query). The fail
    // direction is UNCHANGED — a timeout rejects into the catch below, which
    // already collapses any read error to a 404 (same as a fast DOWN).
    const content = await withSysReadDeadline(
      sysRedis.hGet(REDIS_SYS_KEYS.CONTENT.REGION_WARNING, key)
    );
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
