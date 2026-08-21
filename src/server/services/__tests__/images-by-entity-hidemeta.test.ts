import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getImagesByEntity` backs the bounty and bounty-entry read paths, whose
 * handlers spread the raw row to the client. Nothing downstream re-filters it,
 * so the `hideMeta` decision has to be made in SQL.
 *
 * The gate is therefore only observable as query text. A fixture-driven test
 * would prove nothing — feed it a row carrying `meta` and the row leaks, which
 * is a statement about the fixture rather than about the query.
 */

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

import { getImagesByEntity } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const ENTITY_ID = 1;

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
  ingestion: 'Scanned',
  scannedAt: new Date(0),
  needsReview: null,
  userId: 1,
  index: 0,
  poi: false,
  minor: false,
  entityId: ENTITY_ID,
};

/** Runs the service and returns the query text it built. */
async function captureQuery() {
  const queryRaw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
  let strings: TemplateStringsArray | undefined;
  queryRaw.mockImplementation((s: TemplateStringsArray) => {
    strings = s;
    return Promise.resolve([RAW_ROW]);
  });

  const result = await getImagesByEntity({ id: ENTITY_ID, type: 'BountyEntry' });

  // Positive control: the `!id && !ids` early return would leave every assertion
  // below a statement about nothing.
  expect(strings, 'getImagesByEntity never issued its query').toBeDefined();
  expect(result).toHaveLength(1);

  return { sql: (strings as TemplateStringsArray).join('?'), row: result[0] };
}

describe('getImagesByEntity withholds meta the creator chose to hide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not select the meta column at all', async () => {
    const { sql } = await captureQuery();

    // The two CASE blocks read `i.meta` legitimately, so they come out first and
    // whatever remains must not mention the column in any spelling. Pinning one
    // spelling instead — `i.meta,` — would pass on `i."meta",`, on
    // `i.meta AS meta,` and on a trailing `i.meta` with no comma, each of which
    // re-opens the leak this file exists to catch. `metadata` and `hideMeta`
    // survive the word boundary and the case respectively.
    const withoutDerivations = sql.replace(/\(\s*CASE[\s\S]*?END\s*\)/g, '');

    expect(
      withoutDerivations,
      'getImagesByEntity selects the meta column, which ships to the client'
    ).not.toMatch(/\bmeta\b/);
  });

  it('derives hasMeta from hideMeta, matching the other read paths', async () => {
    const { sql } = await captureQuery();

    // Drop the `i."hideMeta"` term from the CASE and this goes red naming it —
    // a `hasMeta` that ignores the flag is the same leak one level down.
    expect(sql).toMatch(/OR i\."hideMeta" THEN FALSE[\s\S]{0,80}?AS "hasMeta"/);
    expect(sql).toMatch(/AND NOT i\."hideMeta"[\s\S]{0,160}?AS "hasPositivePrompt"/);
  });

  // Pairs with the query assertions above: the gate is in SQL, but it is worth
  // nothing if the return map stops spreading the derived columns through.
  // Deliberately no `meta` absence check here — the fixture decides that, so it
  // passes just as happily against the leaking query.
  it('spreads the derived booleans through the return map', async () => {
    const { row } = await captureQuery();

    expect(row).toMatchObject({ hideMeta: true, hasMeta: false, hasPositivePrompt: false });
  });
});
