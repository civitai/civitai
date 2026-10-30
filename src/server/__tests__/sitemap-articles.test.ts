import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PgDb from '~/server/db/pgDb';
import type * as ServerDomain from '~/server/utils/server-domain';
import type * as Sitemap from '~/server/utils/sitemap';
import type * as UrlHelpers from '~/server/utils/url-helpers';

const { cancellableQuery, respondWithSitemap, getRequestDomainColor } = vi.hoisted(() => ({
  cancellableQuery: vi.fn(),
  respondWithSitemap: vi.fn(),
  getRequestDomainColor: vi.fn(),
}));

vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbRead: { cancellableQuery },
}));
vi.mock('~/server/utils/sitemap', async (importOriginal) => ({
  ...(await importOriginal<typeof Sitemap>()),
  respondWithSitemap,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  getRequestDomainColor,
}));
vi.mock('~/server/utils/url-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof UrlHelpers>()),
  getBaseUrl: () => 'https://civitai.test',
}));

import { getServerSideProps } from '~/pages/sitemap-articles.xml';

/**
 * The articles sitemap advertises official articles, moderator articles and anything with real
 * engagement — not the whole catalogue, and never a page that tells Google not to index it.
 */

type Row = { id: number; title: string; publishedAt: Date | null };

async function run(rows: Row[], color: 'green' | 'red' = 'green') {
  getRequestDomainColor.mockReturnValue(color);
  cancellableQuery.mockResolvedValue({ result: async () => rows, cancel: vi.fn() });
  await getServerSideProps({ req: { headers: {} }, res: { on: vi.fn() } } as never);
  const [sql, params] = cancellableQuery.mock.calls[0];
  const fields = respondWithSitemap.mock.calls[0][1] as { loc: string }[];
  return { sql: sql as string, params: params as unknown[], fields };
}

describe('sitemap-articles.xml', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes official, moderator and engaged articles', async () => {
    const { sql, params } = await run([]);

    expect(sql).toMatch(/a\."isOfficial"/);
    expect(sql).toMatch(/u\."isModerator" = true/);
    expect(sql).toMatch(/>= \$2/);
    expect(params.slice(1)).toEqual([5]);
  });

  it('does not list a new article on recency alone', async () => {
    const { sql } = await run([]);

    expect(sql).not.toMatch(/"publishedAt" >/);
  });

  it('never lists an article the page marks noindex', async () => {
    const { sql } = await run([]);

    expect(sql).toMatch(/a\.availability != 'Unsearchable'/);
  });

  it('never lists an article the page answers with a 404', async () => {
    const { sql } = await run([]);

    expect(sql).toMatch(/a\.ingestion != 'Blocked'/);
  });

  it('allows up to the protocol limit instead of the newest 1,000', async () => {
    const { sql } = await run([]);

    expect(sql).toMatch(/LIMIT 50000/);
    expect(sql).not.toMatch(/LIMIT 1000;/);
  });

  it('keeps each domain to its own canonical articles', async () => {
    const green = await run([], 'green');
    vi.clearAllMocks();
    const red = await run([], 'red');

    expect(green.sql).toMatch(/\(a\."nsfwLevel" & \$1\) != 0/);
    expect(red.sql).toMatch(/a\."nsfwLevel" != 0 AND \(a\."nsfwLevel" & \$1\) = 0/);
  });

  it('gives a title with no slug-able characters the bare id URL', async () => {
    const { fields } = await run([
      { id: 12, title: 'Hello World', publishedAt: new Date('2026-01-01') },
      { id: 34, title: '墨幽', publishedAt: new Date('2026-01-01') },
    ]);

    expect(fields.map((f) => f.loc)).toEqual([
      'https://civitai.test/articles/12/hello-world',
      'https://civitai.test/articles/34',
    ]);
  });
});
