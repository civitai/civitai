/**
 * Routes that have moved from the main app's `/moderator/*` to the standalone moderator app
 * (`apps/moderator`). Shared so the redirect and the nav read the SAME list: the catchall decides where
 * a path goes, and the nav marks the links that will leave — two copies would drift the moment a page
 * migrated, and the nav's copy would be the one nobody noticed was stale.
 *
 * Key = path under `/moderator`; value = the corresponding base path on the moderator app. A request
 * matches a key when it equals the key OR is nested under it (`key/...`), and the trailing sub-path is
 * preserved (longest matching key wins). So one entry covers a whole subtree with dynamic segments
 * (`images` → the /images hub + every [slug] mode; `review/training-data` → the queue + each version),
 * and a renamed page maps cleanly (`image-tags` → `images/tags`).
 *
 * Client-safe: no env, no server imports. The nav is a client component.
 */
export const MIGRATED_ROUTES: Record<string, string> = {
  reports: 'reports',
  articles: 'articles',
  'article-rating-review': 'articles/ratings',
  'cosmetics/grant': 'cosmetics/grant',
  'comics-review': 'comics-review',
  blocklists: 'blocklists',
  // Audit tools now live under /audit in the spoke.
  auditor: 'audit/prompt-tester',
  'prompt-audit-test': 'audit/prohibited-prompts',
  'scanner-audit': 'audit/scanner-audit',
  'generation-restrictions': 'audit/generator-restrictions',
  'training-models': 'audit/training-models',
  'review/training-data': 'audit/training-data',
  images: 'images',
  // Renamed image task pages — legacy top-level path → new nested spoke path.
  'image-tags': 'images/tags',
  'image-rating-review': 'images/ratings',
  'downleveled-review': 'images/downleveled',
  'ingestion-error-review': 'images/ingestion-errors',
};

const MODERATOR_PREFIX = '/moderator/';

/** The longest key covering `path` (a path already stripped of `/moderator/`), or undefined. */
export function migratedRouteKey(path: string): string | undefined {
  return Object.keys(MIGRATED_ROUTES)
    .filter((key) => path === key || path.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/** The moderator-app path for `path`, sub-path preserved, or undefined if it has not migrated. */
export function resolveMigratedRoute(path: string): string | undefined {
  const key = migratedRouteKey(path);
  return key === undefined ? undefined : MIGRATED_ROUTES[key] + path.slice(key.length);
}

/** Whether a main-app href (`/moderator/foo`) now redirects out to the moderator app. */
export function isMigratedModeratorHref(href: string): boolean {
  if (!href.startsWith(MODERATOR_PREFIX)) return false;
  return migratedRouteKey(href.slice(MODERATOR_PREFIX.length)) !== undefined;
}
