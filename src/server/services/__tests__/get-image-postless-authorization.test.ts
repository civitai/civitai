import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// `Image.postId` is ON DELETE SET NULL, so an image outlives a deleted post. `getImage` used to
// inner-join Post for non-moderators, which dropped those rows before the ownership clause was
// ever evaluated — the owner got a 404 on their own image while a moderator loaded it fine.
//
// The gates now sit in the WHERE against a LEFT JOIN, so the shape of the statement IS the
// authorization decision and is what these assert on. Two mutations this exists to kill: putting
// the post gate back in the JOIN (postless rows vanish again for everyone but mods), and dropping
// the `i."userId"` conjunct from the postless branch (every never-posted upload on the site
// becomes fetchable by id).
//
// Mock recipe follows image-hide-challenges-exclusion.test.ts.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImage } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 71806;
const IMAGE_ID = 137353037;

// The embedded `Prisma.sql` fragments arrive as values, not as template text, so the statement has
// to be reassembled from both halves before it can be read. Prisma flattens nested fragments at
// construction, so each value's own `.sql` already carries its full text.
function renderLastQuery() {
  const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
  if (!call) throw new Error('$queryRaw was never called');
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings
    .map((chunk, i) => {
      if (i === 0) return chunk;
      const value = values[i - 1] as { sql?: string } | undefined;
      return (typeof value?.sql === 'string' ? value.sql : '?') + chunk;
    })
    .join('');
}

// getImage throws not-found on an empty result, before any of the enrichment fetches. The
// statement is already assembled by then, which is all these need.
async function captureQuery(args: Parameters<typeof getImage>[0]) {
  await expect(getImage(args)).rejects.toThrow();
  return renderLastQuery().replace(/\s+/g, ' ');
}

describe('getImage postless authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  });

  it('left-joins Post so a postless row survives to the WHERE', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain('LEFT JOIN "Post" p ON p.id = i."postId"');
    // The gate must not move back into the ON clause: there it discards the row instead of
    // failing it, and no WHERE conjunct can recover a row the join never produced.
    expect(sql).not.toMatch(/JOIN "Post" p ON p\.id = i\."postId" AND/);
  });

  it('admits a postless image only to its owner', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain('i."postId" IS NULL AND i."userId" = ?');
    expect(sql).toContain('i."postId" IS NULL OR p."availability" != \'Private\'');
  });

  it('still requires a published or owned post when one exists', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    expect(sql).toContain('p."publishedAt" < now() OR p."userId" = ?');
  });

  it('binds the viewer as the owner the postless branch checks against', async () => {
    await captureQuery({ id: IMAGE_ID, userId: VIEWER });

    const values = (dbMock.dbRead.$queryRaw.mock.calls.at(-1) as [string[], ...unknown[]])
      .slice(1)
      .flatMap((value) => (value as { values?: unknown[] })?.values ?? []);
    expect(values).toContain(VIEWER);
  });

  it('leaves the moderator path ungated', async () => {
    const sql = await captureQuery({ id: IMAGE_ID, userId: VIEWER, isModerator: true });

    expect(sql).toContain('LEFT JOIN "Post" p ON p.id = i."postId"');
    expect(sql).not.toContain('p."publishedAt" < now()');
  });
});
