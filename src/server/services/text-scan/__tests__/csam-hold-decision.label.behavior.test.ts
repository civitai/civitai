import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Hand-listed: only the decision's own SQL runs against the real label store here.
vi.mock('~/server/services/comment.service', () => ({ bulkSetCommentTosViolation: vi.fn() }));
vi.mock('~/server/services/commentsv2.service', () => ({
  bulkSetCommentV2TosViolation: vi.fn(async () => ({ count: 1 })),
}));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: vi.fn(),
  clearUserProfileFields: vi.fn(),
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ deletePost: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ closeAppealsDeletedByOwner: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

const { decideCsamHold } = await import('~/server/services/text-scan/csam-hold-decision');

const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
});
afterAll(async () => {
  await db.pg.close();
});

const tracker = { userActivity: vi.fn(), post: vi.fn(), modelEvent: vi.fn() };

beforeEach(async () => {
  await db.pg.exec('TRUNCATE label_store.label, label_store.subject RESTART IDENTITY CASCADE');
  dbMock.dbWrite.textScanHold.findFirst.mockResolvedValue({
    id: 12,
    status: 'Pending',
    entityType: 'CommentV2',
    entityId: 55,
    userId: 900,
    text: 'held text',
    meta: null,
  });
  dbMock.dbWrite.textScanHold.updateMany.mockResolvedValue({ count: 1 });
  // Prisma's tagged template reaches the mock as (strings, ...values); run it as the real $1 form.
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values) => {
    const sql = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
      ''
    );
    const params = values.map((v) => (v instanceof Date ? v.toISOString() : v));
    return (await db.pg.query(sql, params)).rows;
  });
});

const decide = (decision: 'dismiss' | 'remove', note?: string) =>
  decideCsamHold({
    holdId: 12,
    decision,
    note,
    actor: { id: 7 },
    tracker: tracker as never,
  });

const labels = async () =>
  (
    await db.pg.query<{ value: string; reason: string; subjectType: string; subjectId: string }>(
      `SELECT l."value", l."reason", s."subjectType", s."subjectId"
       FROM label_store.label l JOIN label_store.subject s ON s."id" = l."subjectId"`
    )
  ).rows;

describe('the csam hold decision record, against the real label store', () => {
  it('records a removal as a csam label with the action as its reason', async () => {
    await decide('remove', 'gone');
    expect(await labels()).toEqual([
      { value: 'csam', reason: 'remove', subjectType: 'comment_v2_text', subjectId: '55' },
    ]);
    expect((await db.pg.query('SELECT * FROM label_store.record_failure')).rows).toEqual([]);
  });

  it('records a dismissal as not csam', async () => {
    await decide('dismiss');
    expect(await labels()).toMatchObject([{ value: 'not_csam', reason: 'dismiss' }]);
  });

  it('records one label per hold: the same source ref twice adds nothing', async () => {
    await decide('remove');
    await decide('remove');
    expect(await labels()).toHaveLength(1);
  });
});
