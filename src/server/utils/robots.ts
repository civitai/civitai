/** Paths disallowed for every crawler. */
export const disallowPaths = [
  '/*/create',
  '/api/*',
  '/discord/*',
  '/dmca/*',
  '/intent/*',
  '/models/train',
  '/models/*/wizard',
  '/models/*/model-versions/*/wizard',
  '/moderator/*',
  '/payment/*',
  '/redirect',
  '/search/*',
  '/testing/*',
  '/user/account',
  '/user/downloads',
  '/user/notifications',
  '/user/transactions',
  '/user/buzz-dashboard',
  '/user/vault',
  '/user/membership',
  '/user/stripe-connect/onboard',
  '/user/earn-potential',
  '/tipalti/*',
  '/research/*',
  '/claim/*',
  '/collections/youtube/auth',
  '/questions/*',
];

/**
 * Further disallows for the `*` group. These exist to protect crawl budget
 * rather than to hide content, which is why they carry their own comments in
 * the emitted file. This is the single source for those lines — the `*` group
 * is emitted FROM it, so adding an entry here reaches both groups.
 */
export const crawlBudgetDisallow: { comment: string[]; paths: string[] }[] = [
  {
    comment: ['# Login pages — high alternate-canonical volume from /login?returnUrl=... variants'],
    paths: ['/login'],
  },
  {
    comment: [
      '# Ad/affiliate tracking parameters — canonical handles correctness, but each',
      '# variant wastes crawl budget',
    ],
    paths: ['/*?adid=', '/*&adid='],
  },
  {
    comment: ['# Site-search query URLs — thin/duplicate content, low SEO value'],
    paths: ['/*?query=', '/*&query='],
  },
];

export const crawlBudgetDisallowPaths = crawlBudgetDisallow.flatMap((g) => g.paths);

/**
 * Disallowed for `meta-externalagent` only, on top of everything the `*` group
 * disallows. These review pages are server-rendered per request.
 *
 * Scope note: this covers the paginated review LISTING pages. Individual review
 * permalinks (`/reviews/[reviewId]`) are deliberately left crawlable — they are
 * the canonical URL for a single review, and cheap by comparison.
 */
export const metaExternalAgentDisallowPaths = ['/models/*/reviews', '/3d-models/*/reviews'];

/**
 * Every disallow that applies to the `*` group, in emitted order.
 */
export const allWildcardDisallowPaths = [...disallowPaths, ...crawlBudgetDisallowPaths];

export function buildRobotsTxt(baseUrl: string): string {
  const lines: string[] = [];

  lines.push('# *');
  lines.push('User-agent: *');
  lines.push('Allow: /api/trpc/*');
  for (const path of disallowPaths) lines.push(`Disallow: ${path}`);
  lines.push('');

  // Emitted from `crawlBudgetDisallow` so this block and the meta group below
  // cannot drift apart.
  for (const group of crawlBudgetDisallow) {
    lines.push(...group.comment);
    for (const path of group.paths) lines.push(`Disallow: ${path}`);
    lines.push('');
  }

  // Meta's declared AI/content crawler, which documents itself as honouring
  // robots.txt. These review listing pages are server-rendered per request.
  //
  // 🔴 robots.txt group semantics (RFC 9309 §2.2.1): a crawler that matches a
  // named group obeys ONLY that group — "If no matching group exists, crawlers
  // MUST obey the group with a user-agent line with the `*` value, if present",
  // i.e. a named group suppresses `*` entirely. This block therefore repeats
  // every `*` disallow on purpose. Removing that repetition would leave
  // meta-externalagent LESS restricted than it is today, not more —
  // `robots.test.ts` asserts the superset property so the mistake cannot ship.
  lines.push('# meta-externalagent');
  lines.push('User-agent: meta-externalagent');
  lines.push('Allow: /api/trpc/*');
  for (const path of [...allWildcardDisallowPaths, ...metaExternalAgentDisallowPaths])
    lines.push(`Disallow: ${path}`);
  lines.push('');

  lines.push('# Host');
  lines.push(`Host: ${baseUrl}`);
  lines.push('');

  lines.push('# Sitemaps');
  lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-pages.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-articles.xml`);
  lines.push(`Sitemap: ${baseUrl}/sitemap-models.xml`);

  return lines.join('\n') + '\n';
}

/**
 * Parse the emitted file back into `user-agent -> disallow paths`. Used by the
 * tests so they assert the SHIPPED text rather than the arrays that built it.
 */
export function parseRobotsGroups(txt: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const ua = /^User-agent:\s*(.+)$/i.exec(line);
    if (ua) {
      current = ua[1].trim();
      groups[current] ??= [];
      continue;
    }
    // `(.*)` not `(.+)`: per RFC 9309 an EMPTY `Disallow:` is meaningful — it
    // means "allow everything". `(.+)` would silently skip a group neutered
    // that way, so the parser would not see the very mistake it exists to catch.
    const dis = /^Disallow:\s*(.*)$/i.exec(line);
    if (dis && current) groups[current].push(dis[1].trim());
  }
  return groups;
}
