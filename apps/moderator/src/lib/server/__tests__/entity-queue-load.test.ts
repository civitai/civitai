import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainHarness } from '../../../test/explain-harness';

/**
 * The shared-layout queues' reads (`entity-queue-load.ts`): every
 * statement the queue rows and the open items issue, PLANNED against the live schema — none executed
 * (`src/test/explain-harness.ts`). The SQL here is hand-built per type, so a misspelt column is
 * invisible to TypeScript and the mocked tier.
 */

const h = explainHarness();
vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));
vi.mock('$app/server', () => ({ getRequestEvent: () => null }));
vi.mock('../access', () => ({ canAccess: () => true }));
// A real article, so its item plans past the lookup — the DummyDriver returns no rows, and every
// other type stops at its first read.
vi.mock('../article-lookup.service', () => ({
  getArticle: vi.fn(async (id: number) => ({ id, userId: 3, coverId: 11 })),
}));
// The transcript's edit history is ClickHouse; nothing to plan there.
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: async () => [] }) }));

const { queueSubjects, loadEntityItem } = await import('../entity-queue-load');
const { getImagesForConnection } = await import('../bulk-image.service');
const { ENTITY_QUEUE_TYPES } = await import('$lib/entity-report-queues');

beforeEach(() => h.reset());
afterAll(() => h.destroy());

describe.skipIf(!h.hasDb)('entity queue reads plan against the real schema', () => {
  it.each(ENTITY_QUEUE_TYPES)('queueSubjects(%s)', async (type) => {
    await queueSubjects(type, [
      { id: 1, entityId: 10, reportedById: 5, alsoReportedBy: [7] },
      { id: 2, entityId: 11, reportedById: 6, alsoReportedBy: [] },
    ]);
    expect(h.queries.length).toBeGreaterThan(0);
    await h.explainAll();
  });

  it('queueSubjects reads nothing for a page with no ids', async () => {
    expect(
      (
        await queueSubjects('article', [
          { id: 1, entityId: null, reportedById: 5, alsoReportedBy: [] },
        ])
      ).size
    ).toBe(0);
    expect(h.queries.length).toBe(0);
  });

  it.each(ENTITY_QUEUE_TYPES)('loadEntityItem(%s)', async (type) => {
    await loadEntityItem(
      type,
      10,
      { user: { id: 1 } } as never,
      new URL('https://mod.example/?imgPage=2')
    );
    await h.explainAll();
  });

  it.each(['Article', 'Bounty', 'BountyEntry'] as const)(
    'getImagesForConnection(%s) reads the ids, then the images by id',
    async (entityType) => {
      await getImagesForConnection(entityType, 10, { limit: 200 }, [11]);
      // An `IN (subquery) OR IN (list)` over Image cannot use the index: it took an article minutes.
      expect(h.queries[0].sql).toContain('"ImageConnection"');
      expect(h.queries.some((q) => /\bor\b/i.test(q.sql) && q.sql.includes('"Image"'))).toBe(false);
      await h.explainAll();
    }
  );
});
