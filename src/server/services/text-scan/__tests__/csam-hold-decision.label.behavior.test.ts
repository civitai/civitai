import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({ toggleBan: vi.fn(), removeV2: vi.fn() }));

// Hand-listed: only the decision's own SQL runs against the real label store here.
vi.mock('~/server/services/comment.service', () => ({ bulkSetCommentTosViolation: vi.fn() }));
vi.mock('~/server/services/commentsv2.service', () => ({
  bulkSetCommentV2TosViolation: mocks.removeV2,
}));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: mocks.toggleBan,
  clearUserProfileFields: vi.fn(),
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ deletePost: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ closeAppealsDeletedByOwner: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

const { decideCsamHold, decideCsamHoldBatch } = await import(
  '~/server/services/text-scan/csam-hold-decision'
);

const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
  await db.pg.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../../packages/civitai-db-schema/prisma/migrations/20261016150000_text_scan_hold/migration.sql'
      ),
      'utf8'
    )
  );
});
afterAll(async () => {
  await db.pg.close();
});

const tracker = { userActivity: vi.fn(), post: vi.fn(), modelEvent: vi.fn() };

beforeEach(async () => {
  await db.pg.exec('TRUNCATE label_store.label, label_store.subject RESTART IDENTITY CASCADE');
  await db.pg.exec(`TRUNCATE "TextScanHold" RESTART IDENTITY`);
  await db.pg
    .exec(`INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","userId","text","reason","updatedAt","meta")
    VALUES (12, 'CommentV2', 55, 'csam', 'h', 900, 'held text', 'r', now(), '{"chatId": 3}')`);
  mocks.removeV2.mockReset();
  mocks.toggleBan.mockReset();
  mocks.removeV2.mockResolvedValue({ count: 1 });
  mocks.toggleBan.mockResolvedValue({});
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null });
  dbMock.dbWrite.textScanHold.findFirst.mockResolvedValue({
    id: 12,
    status: 'Pending',
    entityType: 'CommentV2',
    entityId: 55,
    userId: 900,
    text: 'held text',
    textHash: 'h',
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
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) => {
      const sql = strings.reduce(
        (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
        ''
      );
      return (await db.pg.query(sql, values)).affectedRows ?? 0;
    }
  );
});

const decide = (decision: 'dismiss' | 'remove' | 'remove_ban', note?: string, textHash = 'h') =>
  decideCsamHold({
    holdId: 12,
    textHash,
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
    // The mocked final update does not run, so the claim it would have cleared is cleared here.
    await db.pg.exec(`UPDATE "TextScanHold" SET meta = meta - 'decisionClaim'`);
    await decide('remove');
    expect(await labels()).toHaveLength(1);
  });
});

describe("a decision applied to the author's other holds", () => {
  beforeEach(async () => {
    await db.pg
      .exec(`INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","userId","text","reason","updatedAt")
      VALUES (13, 'CommentV2', 56, 'csam', 'h13', 900, 'other held text', 'r', now())`);
    dbMock.dbWrite.textScanHold.findFirst.mockImplementation(
      (async ({ where }: { where: { id: number } }) =>
        (
          await db.pg.query(
            `SELECT "id","status"::text AS "status","entityType","entityId","userId","text","textHash","meta"
           FROM "TextScanHold" WHERE "id" = $1`,
            [where.id]
          )
        ).rows[0] ?? null) as never
    );
  });

  it.each(['remove', 'dismiss'] as const)(
    '%s: records the batched hold apart from the one the moderator reviewed',
    async (decision) => {
      await decide(decision);
      const results = await decideCsamHoldBatch({
        holds: [{ holdId: 13, textHash: 'h13' }],
        decision,
        actor: { id: 7 },
        tracker: tracker as never,
      });
      expect(results).toMatchObject([{ holdId: 13, ok: true }]);
      const value = decision === 'remove' ? 'csam' : 'not_csam';
      expect((await labels()).sort((a, b) => Number(a.subjectId) - Number(b.subjectId))).toEqual([
        { value, reason: decision, subjectType: 'comment_v2_text', subjectId: '55' },
        { value, reason: 'batch_apply', subjectType: 'comment_v2_text', subjectId: '56' },
      ]);
    }
  );
});

describe('claiming the hold before its effects run, against the real hold table', () => {
  const claim = async () =>
    (
      await db.pg.query<{ claim: unknown }>(
        `SELECT meta->'decisionClaim' AS claim FROM "TextScanHold"`
      )
    ).rows[0].claim;
  const setClaim = (age: string) =>
    db.pg.exec(`UPDATE "TextScanHold" SET meta = meta || jsonb_build_object('decisionClaim',
      jsonb_build_object('by', 8, 'at', now() - interval '${age}'))`);

  it('refuses a second decision while a live claim exists, running no effect', async () => {
    await setClaim('1 minute');
    await expect(decide('remove_ban')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.removeV2).not.toHaveBeenCalled();
    expect(mocks.toggleBan).not.toHaveBeenCalled();
  });

  it('takes over a claim whose holder is long gone', async () => {
    await setClaim('10 minutes');
    await decide('remove_ban');
    expect(mocks.toggleBan).toHaveBeenCalledTimes(1);
  });

  it('claims the hold during the effects and releases it when one fails', async () => {
    let during: unknown;
    mocks.toggleBan.mockImplementation(async () => {
      during = await claim();
      throw new Error('ban down');
    });
    await expect(decide('remove_ban')).rejects.toThrow('ban down');
    expect(during).toMatchObject({ by: 7 });
    expect(await claim()).toBeNull();
    mocks.toggleBan.mockResolvedValue({});
    await decide('remove_ban');
    expect(mocks.toggleBan).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two overlapping decisions through', async () => {
    const results = await Promise.allSettled([decide('remove_ban'), decide('remove_ban')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mocks.toggleBan).toHaveBeenCalledTimes(1);
  });
});

describe('deciding text that changed underneath the moderator', () => {
  it('refuses a hash that no longer matches, running no effect and leaving no claim', async () => {
    dbMock.dbWrite.textScanHold.findFirst.mockResolvedValueOnce({
      id: 12,
      status: 'Pending',
      entityType: 'CommentV2',
      entityId: 55,
      userId: 900,
      text: 'newer text',
      textHash: 'h2',
      meta: null,
    });
    await expect(decide('remove_ban')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.removeV2).not.toHaveBeenCalled();
    expect(mocks.toggleBan).not.toHaveBeenCalled();
  });

  it('fails the claim when a rescan swapped the text after the hold was read', async () => {
    await db.pg.exec(`UPDATE "TextScanHold" SET "textHash" = 'h2'`);
    await expect(decide('remove_ban')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.toggleBan).not.toHaveBeenCalled();
    const { rows } = await db.pg.query(`SELECT meta->'decisionClaim' AS claim FROM "TextScanHold"`);
    expect(rows[0]).toEqual({ claim: null });
  });
});

describe('the final update', () => {
  it('takes the per-entity lock a new detection takes before it checks for rulings', async () => {
    await decide('remove');
    expect(
      dbMock.dbWrite.$executeRaw.mock.calls.some(([strings]) =>
        String(strings).includes('pg_advisory_xact_lock')
      )
    ).toBe(true);
  });
});
