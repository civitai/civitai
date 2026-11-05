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

async function groups() {
  const parsed = parseGroups(await render());
  const ai = parsed.find((g) => g.agents.includes('GPTBot'));
  const star = parsed.find((g) => g.agents.includes('*'));
  return { parsed, ai, star };
}

describe('robots.txt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks GPTBot, ClaudeBot and Amazonbot, in one group, to wait 30 s', async () => {
    const { parsed, ai, star } = await groups();

    expect(ai).toBeDefined();
    expect(ai!.agents).toEqual(['GPTBot', 'ClaudeBot', 'Amazonbot']);
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
