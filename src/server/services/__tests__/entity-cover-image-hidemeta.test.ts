import { describe, it, expect, vi, beforeEach } from 'vitest';

import type * as PromClient from '~/server/prom/client';

/**
 * `getEntityCoverImage` backs a `publicProcedure` callable with arbitrary ids,
 * so the `hideMeta` decision has to be made in SQL: the return map spreads the
 * raw row, and nothing downstream re-filters it.
 *
 * The gate is therefore only observable as query text. A fixture-driven test
 * would prove nothing — feed it a row carrying `meta` and the row leaks, which
 * is a statement about the fixture rather than about the query.
 */

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
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
}));

import { getEntityCoverImage } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const ENTITY = { entityId: 1, entityType: 'Image' as const };

const RAW_ROW = {
  id: 1,
  name: 'x',
  url: 'x',
  nsfwLevel: 1,
  width: 1,
  height: 1,
  hash: 'x',
  hideMeta: true,
  hasMeta: false,
  hasPositivePrompt: false,
  createdAt: new Date(0),
  mimeType: 'image/jpeg',
  type: 'image',
  metadata: null,
  scannedAt: new Date(0),
  needsReview: null,
  userId: 1,
  index: 0,
  postId: null,
  entityId: ENTITY.entityId,
  entityType: ENTITY.entityType,
};

/** Runs the service and returns the query text it built. */
async function captureQuery() {
  const queryRaw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
  let strings: TemplateStringsArray | undefined;
  queryRaw.mockImplementation((s: TemplateStringsArray) => {
    strings = s;
    return Promise.resolve([RAW_ROW]);
  });

  const result = await getEntityCoverImage({ entities: [ENTITY] });

  // Positive control: an early return or a throw would leave every assertion
  // below a statement about nothing.
  expect(strings, 'getEntityCoverImage never issued its query').toBeDefined();
  expect(result).toHaveLength(1);

  return { sql: (strings as TemplateStringsArray).join('?'), row: result[0] };
}

describe('getEntityCoverImage withholds meta the creator chose to hide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not select the meta column at all', async () => {
    const { sql } = await captureQuery();

    // A bare `i.meta,` on its own line is the leak: the row spreads straight to
    // the client. The `hasMeta` CASE below mentions `i.meta` too, hence the
    // line anchor rather than a substring.
    expect(sql, 'getEntityCoverImage selects i.meta, which ships to the client').not.toMatch(
      /^\s*i\.meta,\s*$/m
    );
  });

  it('derives hasMeta from hideMeta, matching the other read paths', async () => {
    const { sql } = await captureQuery();

    // Drop the `i."hideMeta"` term from the CASE and this goes red naming it —
    // a `hasMeta` that ignores the flag is the same leak one level down.
    expect(sql).toMatch(/OR i\."hideMeta" THEN FALSE[\s\S]{0,80}?AS "hasMeta"/);
    expect(sql).toMatch(/AND NOT i\."hideMeta"[\s\S]{0,160}?AS "hasPositivePrompt"/);
  });

  it('returns the derived booleans and no meta', async () => {
    const { row } = await captureQuery();

    expect(row).toMatchObject({ hideMeta: true, hasMeta: false, hasPositivePrompt: false });
    expect(Object.keys(row)).not.toContain('meta');
  });
});
