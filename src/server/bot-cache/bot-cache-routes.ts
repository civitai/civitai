/**
 * The pages a verified crawler's render may be cached for (`~/server/bot-cache/bot-cache`), keyed
 * by page pattern. A leaf with no imports: the proxy reads it on every request, before deciding to
 * load anything else.
 */
export const BOT_CACHE_ROUTES = {
  '/models/[id]/[[...slug]]': 'models',
  '/images/[imageId]': 'images',
  '/posts/[postId]/[[...postSlug]]': 'posts',
  '/articles/[id]/[[...slug]]': 'articles',
  // The profile and its public tabs. Not `manage-categories` (owner only) or `shop/manage`.
  '/user/[username]': 'user',
  '/user/[username]/[list]': 'user',
  '/user/[username]/3d-models': 'user',
  '/user/[username]/achievements': 'user',
  '/user/[username]/articles': 'user',
  '/user/[username]/collections': 'user',
  '/user/[username]/comics': 'user',
  '/user/[username]/images': 'user',
  '/user/[username]/models': 'user',
  '/user/[username]/posts': 'user',
  '/user/[username]/shop': 'user',
  '/user/[username]/sticker-book': 'user',
  '/user/[username]/storylines': 'user',
  '/user/[username]/videos': 'user',
} as const;

export type BotCacheRoutePattern = keyof typeof BOT_CACHE_ROUTES;
export type BotCacheRouteName = (typeof BOT_CACHE_ROUTES)[BotCacheRoutePattern];

const staticSegments = (segments: string[]) => segments.filter((s) => !s.startsWith('[')).length;

// Most static segments first, as Next prefers `/user/[username]/models` over `[list]`.
const CANDIDATES = (Object.keys(BOT_CACHE_ROUTES) as BotCacheRoutePattern[])
  .map((pattern) => ({ pattern, segments: pattern.split('/').filter(Boolean) }))
  .sort((a, b) => staticSegments(b.segments) - staticSegments(a.segments));

function matchesPattern(segments: string[], parts: string[]) {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startsWith('[[...')) return true;
    if (i >= parts.length) return false;
    if (!segment.startsWith('[') && segment !== parts[i]) return false;
  }
  return parts.length === segments.length;
}

/**
 * The allowlisted page pattern a URL path most likely renders as, or `null` when it can be none of
 * them: lets the proxy skip the lookup for every other path. Only a guess — it does not know the
 * app's other static pages (`/user/[username]/manage-categories` reads as `[list]`) — so the
 * pattern a stored entry was RENDERED as is what a hit is checked against.
 */
export function botCacheCandidatePattern(pathname: string): BotCacheRoutePattern | null {
  const parts = pathname.split('/').filter(Boolean);
  return CANDIDATES.find(({ segments }) => matchesPattern(segments, parts))?.pattern ?? null;
}
