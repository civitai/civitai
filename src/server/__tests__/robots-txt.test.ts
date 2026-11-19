import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ServerDomain from '~/server/utils/server-domain';
import type * as Sitemap from '~/server/utils/sitemap';
import type * as UrlHelpers from '~/server/utils/url-helpers';

const { respondWithText, getRequestDomainColor } = vi.hoisted(() => ({
  respondWithText: vi.fn(),
  getRequestDomainColor: vi.fn(),
}));

vi.mock('~/server/utils/sitemap', async (importOriginal) => ({
  ...(await importOriginal<typeof Sitemap>()),
  respondWithText,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  getRequestDomainColor,
}));
vi.mock('~/server/utils/url-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof UrlHelpers>()),
  getBaseUrl: () => 'https://civitai.test',
}));

import { getServerSideProps } from '~/pages/robots.txt';

/**
 * A crawler obeys only the most specific `User-agent` group that matches it. The AI-crawler group
 * that adds a Crawl-delay must therefore carry every Allow/Disallow rule of the `*` group, or those
 * crawlers would be allowed everywhere.
 */

type Group = { agents: string[]; lines: string[] };

async function render() {
  getRequestDomainColor.mockReturnValue('green');
  await getServerSideProps({ req: { headers: {} }, res: {} } as never);
  return respondWithText.mock.calls[0][1] as string;
}

// Groups as a robots.txt parser sees them: a run of `User-agent:` lines opens a group, and every
// following non-comment line belongs to it until the next `User-agent:` run.
function parseGroups(body: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('User-agent:')) {
      const agent = line.slice('User-agent:'.length).trim();
      if (!lastWasAgent || !current) {
        current = { agents: [], lines: [] };
        groups.push(current);
      }
      current.agents.push(agent);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    current?.lines.push(line);
  }
  return groups;
}

const accessRules = (group: Group) =>
  group.lines.filter((line) => line.startsWith('Allow:') || line.startsWith('Disallow:'));

// How RFC 9309 crawlers apply a group to a URL path: a rule matches from the start of the path
// (query included), `*` matches any run of characters and a trailing `$` anchors the end. The
// longest matching rule wins, and on a tie Allow wins.
function isDisallowed(rules: string[], path: string) {
  let best: { length: number; allow: boolean } | undefined;
  for (const rule of rules) {
    const [directive, ...rest] = rule.split(':');
    const pattern = rest.join(':').trim();
    if (!pattern) continue;
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (!new RegExp(`^${source}${anchored ? '$' : ''}`).test(path)) continue;
    const allow = directive === 'Allow';
    if (
      !best ||
      pattern.length > best.length ||
      (pattern.length === best.length && allow && !best.allow)
    )
      best = { length: pattern.length, allow };
  }
  return best ? !best.allow : false;
}

const RULES = `Allow: /api/trpc/*
Disallow: /*/create
Disallow: /api/*
Disallow: /discord/*
Disallow: /dmca/*
Disallow: /intent/*
Disallow: /models/train
Disallow: /models/*/wizard
Disallow: /models/*/model-versions/*/wizard
Disallow: /moderator/*
Disallow: /payment/*
Disallow: /redirect
Disallow: /search/*
Disallow: /testing/*
Disallow: /user/account
Disallow: /user/downloads
Disallow: /user/notifications
Disallow: /user/transactions
Disallow: /user/buzz-dashboard
Disallow: /user/vault
Disallow: /user/membership
Disallow: /user/stripe-connect/onboard
Disallow: /user/earn-potential
Disallow: /tipalti/*
Disallow: /research/*
Disallow: /claim/*
Disallow: /collections/youtube/auth`;

const LOGIN = `Disallow: /login`;
const ADID = `Disallow: /*?adid=
Disallow: /*&adid=`;
const QUERY = `Disallow: /*?query=
Disallow: /*&query=`;
const PROFILE_TABS = `Disallow: /user/*/storylines
Disallow: /user/*/sticker-book
Disallow: /user/*/comics
Disallow: /user/*/3d-models
Disallow: /user/*/articles
Disallow: /user/*/followers
Disallow: /user/*/following`;
const IMAGE_DETAIL = `Disallow: /images/0
Disallow: /images/1
Disallow: /images/2
Disallow: /images/3
Disallow: /images/4
Disallow: /images/5
Disallow: /images/6
Disallow: /images/7
Disallow: /images/8
Disallow: /images/9`;

const EXPECTED_ROBOTS_TXT = `# AI training crawlers — same rules as *, plus a crawl delay
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Amazonbot
User-agent: meta-externalagent
Crawl-delay: 30
${RULES}
${LOGIN}
${ADID}
${QUERY}
${PROFILE_TABS}
${IMAGE_DETAIL}

# *
User-agent: *
${RULES}

# Login pages — high alternate-canonical volume from /login?returnUrl=... variants
${LOGIN}

# Ad/affiliate tracking parameters — canonical handles correctness, but each
# variant wastes crawl budget
${ADID}

# Site-search query URLs — thin/duplicate content, low SEO value
${QUERY}

# Low-value profile tabs — the items they list stay crawlable at their own URLs
${PROFILE_TABS}

# Image detail pages — noindex on every domain, so a crawl only costs a render
${IMAGE_DETAIL}

# Host
Host: https://civitai.test

# Sitemaps
Sitemap: https://civitai.test/sitemap.xml
Sitemap: https://civitai.test/sitemap-pages.xml
Sitemap: https://civitai.test/sitemap-articles.xml
Sitemap: https://civitai.test/sitemap-models.xml
`;

async function groups() {
  const parsed = parseGroups(await render());
  const ai = parsed.find((g) => g.agents.includes('GPTBot'));
  const star = parsed.find((g) => g.agents.includes('*'));
  return { parsed, ai, star };
}

describe('robots.txt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks GPTBot, ClaudeBot, Amazonbot and meta-externalagent, in one group, to wait 30 s', async () => {
    const { parsed, ai, star } = await groups();

    expect(ai).toBeDefined();
    expect(ai!.agents).toEqual(['GPTBot', 'ClaudeBot', 'Amazonbot', 'meta-externalagent']);
    expect(ai!.lines).toContain('Crawl-delay: 30');
    // Placed before the catch-all group.
    expect(parsed.indexOf(ai!)).toBeLessThan(parsed.indexOf(star!));
  });

  it('gives the AI crawlers exactly the Allow/Disallow rules of the * group', async () => {
    const { ai, star } = await groups();

    const aiRules = accessRules(ai!);
    const starRules = accessRules(star!);
    expect(new Set(aiRules)).toEqual(new Set(starRules));
    expect(aiRules).toHaveLength(starRules.length);

    expect(aiRules).toContain('Allow: /api/trpc/*');
    expect(aiRules).toContain('Disallow: /api/*');
    expect(aiRules).toContain('Disallow: /search/*');
    expect(aiRules).toContain('Disallow: /login');
    expect(aiRules).toContain('Disallow: /*?query=');
  });

  it('does not slow down other crawlers', async () => {
    const { star } = await groups();

    expect(star!.agents).toEqual(['*']);
    expect(star!.lines.some((line) => line.startsWith('Crawl-delay:'))).toBe(false);
  });

  it('disallows the low-value profile tabs and keeps the rest of the profile crawlable', async () => {
    const { ai, star } = await groups();

    for (const group of [ai!, star!]) {
      const rules = accessRules(group);
      for (const path of [
        '/user/alice/storylines',
        '/user/alice/sticker-book',
        '/user/alice/comics',
        '/user/alice/3d-models',
        '/user/alice/articles',
        '/user/alice/followers',
        '/user/alice/following',
        '/user/alice/comics?sort=Newest',
      ])
        expect(isDisallowed(rules, path), `${group.agents.join(',')} ${path}`).toBe(true);

      for (const path of [
        '/user/alice',
        '/user/articles',
        '/user/alice/models',
        '/user/alice/images',
        '/user/alice/videos',
        '/user/alice/posts',
        '/user/alice/achievements',
        '/user/alice/collections',
        '/user/alice/collections?sort=Newest',
        '/articles/123/some-article',
        '/collections/123',
        '/comics/123',
      ])
        expect(isDisallowed(rules, path), `${group.agents.join(',')} ${path}`).toBe(false);
    }
  });

  it('disallows image detail pages, not the image index or static images', async () => {
    const { ai, star } = await groups();

    for (const group of [ai!, star!]) {
      const rules = accessRules(group);
      for (const path of ['/images/1', '/images/123', '/images/9876?x=1'])
        expect(isDisallowed(rules, path), `${group.agents.join(',')} ${path}`).toBe(true);

      // Static assets under public/images are served from the same path and must stay fetchable:
      // the site logo in the Organization schema, app icons and og:images.
      for (const path of [
        '/images/logo_light_mode.png',
        '/images/training-landing/og-train.jpg',
        '/images/apple-touch-icon.png',
        '/images',
        '/images?sort=Newest',
        '/user/alice/images',
      ])
        expect(isDisallowed(rules, path), `${group.agents.join(',')} ${path}`).toBe(false);
    }
  });

  it('renders exactly this robots.txt', async () => {
    expect(await render()).toBe(EXPECTED_ROBOTS_TXT);
  });

  it('still ends with the Host and Sitemap lines', async () => {
    const body = await render();

    expect(body).toContain('Host: https://civitai.test\n');
    expect(body.trimEnd().split('\n').slice(-4)).toEqual([
      'Sitemap: https://civitai.test/sitemap.xml',
      'Sitemap: https://civitai.test/sitemap-pages.xml',
      'Sitemap: https://civitai.test/sitemap-articles.xml',
      'Sitemap: https://civitai.test/sitemap-models.xml',
    ]);
  });
});
