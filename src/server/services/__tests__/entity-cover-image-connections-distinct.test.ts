import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The `CONNECTIONS` branch of `getEntityCoverImage`'s UNION is the only one of the
 * six that can emit more than one row per entity: `ImageConnection` holds one row
 * per linked image, so the branch fans out (p50 1, p99 11, max 525 on production)
 * and the result set stops being bounded by the number of entities requested.
 *
 * De-duplicating it has a trap. The `ingestion`/`needsReview` predicate used to sit
 * in the outer WHERE, i.e. *after* the UNION, so every connection's image was
 * emitted and the JS join picked the first surviving row. A `DISTINCT ON` added
 * without moving that predicate inward picks its row *before* the filter runs: land
 * on an unscanned image and the entity loses its cover entirely, where today a
 * sibling connection would have supplied one. That is a user-visible regression, so
 * it gets its own assertion below.
 *
 * None of this is observable from a fixture. The de-duplication and the ordering are
 * decided by Postgres, and this suite has no database -- feed the mock two rows for
 * one entity and the first still wins, which is a statement about the fixture rather
 * than about the query. So the query text is the artifact under test, and the branch
 * is pinned as a whole normalised string: a loose regex is satisfied by SQL that is
 * semantically inverted, and this is exactly the shape where that matters.
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

import { getEntityCoverImage } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const ENTITY = { entityId: 1, entityType: 'Bounty' as const };

const RAW_ROW = {
  id: 1,
  name: 'x',
  url: 'x',
  nsfwLevel: 1,
  width: 1,
  height: 1,
  hash: 'x',
  hideMeta: false,
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

  // Positive control: an early return or a throw would leave every assertion below
  // a statement about nothing.
  expect(strings, 'getEntityCoverImage never issued its query').toBeDefined();
  expect(result).toHaveLength(1);

  return (strings as TemplateStringsArray).join('?');
}

/**
 * The text of the CONNECTIONS branch alone, whitespace-normalised.
 *
 * The end marker is the outer join onto the UNION's output (`t."imageId"`), which is
 * distinct from the branch's own join (`ic."imageId"`) -- so the slice deliberately
 * stops short of the outer WHERE. That is what lets the eligibility assertion below
 * distinguish "inside the branch" from "after the UNION": leave the predicate where
 * it used to be and it falls outside this slice.
 */
function connectionsBranch(sql: string) {
  const start = sql.indexOf('-- CONNECTIONS');
  const end = sql.indexOf('JOIN "Image" i ON i.id = t."imageId"');

  // Positive control on the slice itself. A marker that stopped matching would hand
  // every assertion below a garbage string, and `.not.toMatch` assertions would pass
  // against it.
  expect(start, 'the CONNECTIONS branch marker is gone -- re-anchor this slice').toBeGreaterThan(
    -1
  );
  expect(end, 'the outer UNION join is gone -- re-anchor this slice').toBeGreaterThan(start);

  return sql.slice(start, end);
}

/**
 * The branch with comments dropped and whitespace normalised -- the SQL as Postgres
 * sees it. Comments have to go before the newlines do: a `--` comment runs to end of
 * line, so stripping it after normalising would swallow the statement behind it.
 */
function connectionsSql(sql: string) {
  return connectionsBranch(sql)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('getEntityCoverImage bounds the CONNECTIONS branch to one row per entity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('de-duplicates the branch instead of emitting one row per connection', async () => {
    const branch = connectionsSql(await captureQuery());

    // Without this the branch fans out with `ImageConnection`, and the JS join
    // downstream degrades to a scan of an unbounded result set per entity.
    expect(
      branch,
      'the CONNECTIONS branch emits one row per connection, not one per entity'
    ).toMatch(/SELECT DISTINCT ON \(/);
  });

  it('keys the de-duplication on entityType as well as entityId', async () => {
    const branch = connectionsSql(await captureQuery());

    // The other five branches each pin a single `entityType`, so `entityId` alone
    // identifies a row for them. This branch joins on the pair, so an id can recur
    // across types -- dropping `entityType` here would collapse two distinct
    // entities into one and hand one of them the other's cover image.
    const key = branch.match(/SELECT DISTINCT ON \(([^)]*)\)/)?.[1];
    expect(key, 'no DISTINCT ON key list to inspect').toBeDefined();
    expect(key, 'DISTINCT ON drops entityType, so ids collide across entity types').toContain(
      'e."entityType"'
    );
    expect(key).toContain('e."entityId"');
  });

  it('filters ineligible images inside the branch, before de-duplication', async () => {
    const branch = connectionsSql(await captureQuery());

    // The trap this file exists for. DISTINCT ON picks before the outer WHERE runs,
    // so if the predicate is left outside, an entity whose connections hold an
    // unscanned image alongside an eligible one can have the unscanned one picked
    // and then filtered away -- losing a cover image it has today.
    expect(
      branch,
      'the eligibility predicate is outside the branch, so DISTINCT ON can pick an ineligible image and drop the entity'
    ).toContain(`WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL`);
  });

  it('orders by the DISTINCT ON key columns first, then a total-order tiebreak', async () => {
    const branch = connectionsSql(await captureQuery());

    // Postgres requires the ORDER BY to lead with the DISTINCT ON expressions; the
    // trailing key decides which row survives. `i.id` is the primary key, so it is
    // never null and leaves no residual tie.
    expect(branch, 'the surviving connection row is not deterministic').toContain(
      'ORDER BY e."entityId", e."entityType", i.id'
    );
  });

  it('pins the whole branch, so a reword cannot leave it semantically inverted', async () => {
    const branch = connectionsSql(await captureQuery());

    // A partial pattern is satisfied by SQL that means the opposite -- a predicate
    // negated, a key column reordered out of the DISTINCT ON, an ORDER BY direction
    // flipped. This is the machine-readable claim; the assertions above exist to say
    // which property broke when it goes red. Cosmetic edits to the branch must
    // update this string.
    expect(branch).toBe(
      'SELECT * FROM ( ' +
        'SELECT DISTINCT ON (e."entityId", e."entityType") ' +
        'e."entityId", e."entityType", i.id AS "imageId", 0 "order1", 0 "order2", 0 "order3" ' +
        'FROM entities e ' +
        'JOIN "ImageConnection" ic ON ic."entityId" = e."entityId" AND ic."entityType" = e."entityType" ' +
        'JOIN "Image" i ON i.id = ic."imageId" ' +
        `WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL ` +
        'ORDER BY e."entityId", e."entityType", i.id ' +
        ') t ) t'
    );
  });

  it('keeps the first row for an entity when two branches both supply one', async () => {
    // An Article is served by its own branch (the cover) and by CONNECTIONS (its
    // content images), so the UNION can still hand this function two rows for one
    // entity. The JS join is indexed rather than scanned now, and first-wins has to
    // survive that: a plain `set` per row would silently switch to last-wins.
    const first = { ...RAW_ROW, id: 10, entityId: 7, entityType: 'Article' };
    const second = { ...RAW_ROW, id: 20, entityId: 7, entityType: 'Article' };

    const queryRaw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValue([first, second]);

    const result = await getEntityCoverImage({
      entities: [{ entityId: 7, entityType: 'Article' }],
    });

    expect(result).toHaveLength(1);
    expect(result[0].id, 'the indexed join changed which row an entity resolves to').toBe(10);
  });
});
