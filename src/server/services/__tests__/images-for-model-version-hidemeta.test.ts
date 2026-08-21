import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getImagesForModelVersion` feeds the public v1 model-version endpoints, which
 * spread the raw row into the response. Nothing downstream re-filters it, so the
 * `hideMeta` decision has to be made in SQL and the query text is the only
 * observable — a fixture-driven assertion would describe the fixture instead.
 *
 * It gates the column rather than dropping it, unlike `getImagesByEntity` and
 * `getEntityCoverImage`: `images[].meta` is a documented v1 field, so dropping it
 * breaks every caller rather than the hidden rows. Filtering the rows out — what
 * `getAllImages` does, where `include: ['meta']` is a caller-facing filter rather
 * than a redaction — would silently shorten the `images` array instead.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { getImagesForModelVersion } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_VERSION_ID = 1;

/**
 * Removes every expression that reads `i.meta` legitimately — the gated
 * projection, the two derived booleans, the `onSite` fragment and the `remixOfId`
 * extraction. Anything still naming the column afterwards is an ungated
 * projection, in whatever spelling it was reintroduced.
 */
function stripMetaReaders(sql: string) {
  return sql
    .replace(/CASE\s+WHEN\s+i\."hideMeta"\s+THEN\s+NULL\s+ELSE\s+i\.meta\s+END\s+AS\s+meta/g, '')
    .replace(/\(\s*CASE[\s\S]*?END\s*\)/g, '')
    .replace(/\(\s*i\.meta[\s\S]*?\)\s*as\s+"onSite"/g, '')
    .replace(/i\."meta"[^,]*as\s+"remixOfId"/g, '');
}

/** Runs the service and returns the query text it built. */
async function captureQuery(include: Array<'meta' | 'tags'>) {
  const queryRaw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
  let query: { strings: string[] } | undefined;
  queryRaw.mockImplementation((q: { strings: string[] }) => {
    query = q;
    return Promise.resolve([]);
  });

  await getImagesForModelVersion({ modelVersionIds: [MODEL_VERSION_ID], include });

  expect(query, 'getImagesForModelVersion never issued its query').toBeDefined();
  const sql = (query as { strings: string[] }).strings.join('?');

  // The negative assertions below hold over any text, the empty string included.
  expect(sql, 'captured a query other than the model-version one').toContain('t."modelVersionId"');

  return sql;
}

describe('getImagesForModelVersion withholds meta the creator chose to hide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gates the projected meta column on hideMeta', async () => {
    expect(
      await captureQuery(['meta']),
      'getImagesForModelVersion projects meta without consulting hideMeta'
    ).toMatch(/CASE\s+WHEN\s+i\."hideMeta"\s+THEN\s+NULL\s+ELSE\s+i\.meta\s+END\s+AS\s+meta\b/);
  });

  // Both branches, because the `include: []` one reaches far more callers — the
  // day-long `imagesForModelVersionsCache`, the model cards, vault and webhooks.
  it('projects the column nowhere else, with or without include', async () => {
    for (const include of [['meta'], []] as Array<Array<'meta' | 'tags'>>) {
      const where = `include: ${JSON.stringify(include)}`;
      const rest = stripMetaReaders(await captureQuery(include));

      expect(rest, `${where} — selects the meta column ungated, which ships to the client`).not.toMatch(
        /\bmeta\b/
      );

      // A wildcard names no column, so the assertion above passes over `i.*`
      // while every column including meta ships.
      expect(rest, `${where} — selects whole rows, which carries meta past the check above`).not.toMatch(
        /\bi\.\*/
      );
    }
  });

  it('derives hasMeta from hideMeta, matching the other read paths', async () => {
    const sql = await captureQuery(['meta']);

    // Drop the `i."hideMeta"` term from the CASE and this goes red naming it —
    // a `hasMeta` that ignores the flag is the same leak one level down.
    expect(sql).toMatch(/OR i\."hideMeta" THEN FALSE[\s\S]{0,80}?AS "hasMeta"/);
    expect(sql).toMatch(/AND NOT i\."hideMeta"[\s\S]{0,160}?AS "hasPositivePrompt"/);
  });

  // The redaction is per row, not per result set. Adopting `getAllImages`' filter
  // here would drop hidden-meta images out of the public `images` array entirely,
  // changing its length for every version that has one.
  it('redacts the column rather than filtering the row out', async () => {
    const sql = await captureQuery(['meta']);
    const rowSelection = sql.slice(0, sql.indexOf('LIMIT'));

    expect(rowSelection, 'sliced past the row-selection predicate').toContain('p."publishedAt"');
    expect(rowSelection, 'hidden-meta rows are excluded from the result set').not.toMatch(
      /hideMeta/
    );
  });
});
