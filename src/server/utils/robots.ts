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
 * the emitted file.
 */
export const crawlBudgetDisallowPaths = [
  '/login',
  '/*?adid=',
  '/*&adid=',
  '/*?query=',
  '/*&query=',
];

/**
 * Disallowed for `meta-externalagent` only, on top of everything the `*` group
 * disallows. The review routes are server-rendered per request and the
 * canonical model page already carries the same content.
 */
export const metaExternalAgentDisallowPaths = ['/models/*/reviews'];

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

  lines.push('# Login pages — high alternate-canonical volume from /login?returnUrl=... variants');
  lines.push('Disallow: /login');
  lines.push('');

  lines.push(
    '# Ad/affiliate tracking parameters — canonical handles correctness, but each',
    '# variant wastes crawl budget'
  );
  lines.push('Disallow: /*?adid=');
  lines.push('Disallow: /*&adid=');
  lines.push('');

  lines.push('# Site-search query URLs — thin/duplicate content, low SEO value');
  lines.push('Disallow: /*?query=');
  lines.push('Disallow: /*&query=');
  lines.push('');

  // Meta's declared AI/content crawler. It is a large and growing share of the
  // requests to the server-rendered review routes, which are expensive to
  // render; the canonical model page carries the same content and stays fully
  // crawlable.
  //
  // 🔴 robots.txt group semantics: a crawler obeys ONLY its most specific
  // matching group and ignores `User-agent: *` entirely. This block therefore
  // repeats every `*` disallow on purpose. Removing that repetition would leave
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
    const dis = /^Disallow:\s*(.+)$/i.exec(line);
    if (dis && current) groups[current].push(dis[1].trim());
  }
  return groups;
}
