import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ArticleService from '~/server/services/article.service';
import type * as AutoMute from '~/server/services/scam-auto-mute.service';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as ReportService from '~/server/services/report.service';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanCsamMode: vi.fn(async () => 'review'),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport: vi.fn(),
}));
vi.mock('~/server/services/scam-auto-mute.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AutoMute>()),
  autoMuteScamAccount: vi.fn(async () => ({ muted: false, skipped: 'duplicate' })),
}));
// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));
// Hand-listed: the real action pulls model-version.service and nsfwLevels.service at load.
vi.mock('~/server/services/text-scan/actions/model-nsfw', () => ({
  applyModelNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
  applySystemModelNsfwFlag: vi.fn(),
}));
// Hand-listed: the real action reaches model.service, whose graph builds clients at load.
vi.mock('~/server/services/text-scan/actions/model-poi-minor', () => ({
  applyModelPoiMinor: vi.fn(async () => ({ notified: false })),
}));
// Hand-listed: the real service recomputes ingestion against the database.
vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  recomputeArticleIngestion: vi.fn(),
}));

const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { applyCsamHold, CSAM_HOLD_TEXT_CHARS, CsamHoldBusyError } = await import(
  '~/server/services/text-scan/actions/csam-hold'
);
const { composeUserText } = await import('~/server/services/text-scan/segment');
const { getTextScanCsamMode } = await import('~/server/services/text-scan/mode');
const { createReport } = await import('~/server/services/report.service');
const { autoMuteScamAccount } = await import('~/server/services/scam-auto-mute.service');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');
const { applyModelPoiMinor } = await import('~/server/services/text-scan/actions/model-poi-minor');

type HoldRow = Record<string, unknown> & { id: number };

const db = { pg: null as unknown as PGlite };
const MIGRATIONS = ['20261016150000_text_scan_hold', '20261112120000_text_scan_hold_one_pending'];
const migrationSql = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

// PGlite reads a zone-less timestamp in the machine's zone; the column holds UTC.
const asUtc = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
const rows = async () =>
  (await db.pg.query<HoldRow>('SELECT * FROM "TextScanHold" ORDER BY "id"')).rows.map((row) => ({
    ...row,
    contentAt: row.contentAt instanceof Date ? asUtc(row.contentAt) : row.contentAt,
  }));
const setStatus = (id: number, status: string) =>
  db.pg.query('UPDATE "TextScanHold" SET "status" = $2 WHERE "id" = $1', [id, status]);
const asRawSql = (strings: TemplateStringsArray, values: unknown[]) =>
  strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');

// Only the columns the one-pending migration reads to pick a survivor.
const ENTITY_MODERATION_STUB = `CREATE TABLE "EntityModeration" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INT NOT NULL,
  "result" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await db.pg.exec(ENTITY_MODERATION_STUB);
  for (const name of MIGRATIONS) await db.pg.exec(migrationSql(name));
});
afterAll(async () => {
  await db.pg.close();
});

type ChatWhere = {
  entityType: string;
  label: string;
  userId: number | null;
  status: 'Pending' | { not: 'Pending' };
  meta: { path: string[]; equals: unknown };
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.pg.exec('TRUNCATE "TextScanHold" RESTART IDENTITY');
  // Prisma's tagged template reaches the mock as (strings, ...values); run it as the real $1 form.
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) =>
      (await db.pg.query(asRawSql(strings, values), values)).rows
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) =>
      (await db.pg.query(asRawSql(strings, values), values)).affectedRows ?? 0
  );
  // Only ChatMessage still goes through Prisma's create.
  dbMock.dbWrite.textScanHold.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      try {
        const { rows } = await db.pg.query<{ id: number }>(
          `INSERT INTO "TextScanHold" ("entityType","entityId","label","textHash","userId","text","reason",
             "workflowId","promptId","contentAt","meta","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now()) RETURNING "id"`,
          [
            data.entityType,
            data.entityId,
            data.label,
            data.textHash,
            data.userId,
            data.text,
            data.reason,
            data.workflowId,
            data.promptId,
            data.contentAt instanceof Date ? data.contentAt.toISOString() : null,
            JSON.stringify(data.meta ?? null),
          ]
        );
        return rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        throw error;
      }
    }
  );
  dbMock.dbWrite.textScanHold.findFirst.mockImplementation((async ({
    where,
  }: {
    where: ChatWhere;
  }) => {
    if (JSON.stringify(where.meta.path) !== JSON.stringify(['chatId']))
      throw new Error(`unexpected hold meta path: ${JSON.stringify(where.meta.path)}`);
    const { rows } = await db.pg.query<HoldRow>(
      `SELECT "id","meta" FROM "TextScanHold"
       WHERE "entityType" = $1 AND "label" = $2 AND "userId" IS NOT DISTINCT FROM $3
         AND "meta"->'chatId' = to_jsonb($4::int)
         AND ("status" = 'Pending') = $5
       ORDER BY "id" DESC LIMIT 1`,
      [where.entityType, where.label, where.userId, where.meta.equals, where.status === 'Pending']
    );
    return rows[0] ?? null;
  }) as never);
});

const csamOnly = {
  csam: { detected: true, reason: 'test' },
  triggeredLabels: ['csam' as const],
  nsfwLevel: null,
};
const args = (over: Record<string, unknown> = {}) => ({
  entityId: 77,
  workflowId: 'wf-1',
  outcome: csamOnly,
  subject: {
    fields: [{ heading: 'Comment', text: 'neutral text' }],
    declared: {},
    userId: 5,
    meta: { contentAt: '2026-10-01T00:00:00.000Z', chatId: 4, messageIds: [77, 70] },
  },
  textHash: 'hash-1',
  ...over,
});

const WIRED = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
  'User',
  'ResourceReview',
  'Model',
  'Post',
  'Article',
] as const;

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

describe('csam verdicts through the registered adapters', () => {
  it.each(WIRED)('%s records one pending hold and nothing else', async (entityType) => {
    const adapter = getModerationAdapter(entityType)!;
    await adapter.applyTextScan!(args() as never);
    await adapter.applyTextScan!(args({ workflowId: 'wf-redelivered' }) as never);

    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      entityType,
      entityId: 77,
      label: 'csam',
      textHash: 'hash-1',
      status: 'Pending',
      reason: 'test',
      userId: 5,
      workflowId: 'wf-1',
    });
    expect(createReport).not.toHaveBeenCalled();
    expect(autoMuteScamAccount).not.toHaveBeenCalled();
  });

  it('still holds a verdict that lands after the gate was turned off', async () => {
    vi.mocked(getTextScanCsamMode).mockResolvedValueOnce('off');
    await getModerationAdapter('Comment')!.applyTextScan!(args() as never);
    expect(await rows()).toHaveLength(1);
  });

  it('records nothing for a verdict without csam', async () => {
    await getModerationAdapter('Comment')!.applyTextScan!(
      args({ outcome: { csam: { detected: false, reason: 'test' }, triggeredLabels: [] } }) as never
    );
    expect(await rows()).toHaveLength(0);
  });

  const ACTIONS = [
    ...(
      ['ChatMessage', 'Comment', 'CommentV2', 'UserProfile', 'User', 'ResourceReview'] as const
    ).map((entityType) => [entityType, () => autoMuteScamAccount] as const),
    ['Post', () => applyRatingFloor] as const,
    ['Model', () => applyModelPoiMinor] as const,
  ];
  // ChatMessage still inserts through Prisma; every other type writes through one raw upsert.
  const holdWrite = (entityType: string) =>
    entityType === 'ChatMessage' ? dbMock.dbWrite.textScanHold.create : dbMock.dbWrite.$queryRaw;
  const withScam = { ...csamOnly, scam: { detected: true, reason: 'test' } };

  it.each(ACTIONS)('%s holds before its own action runs', async (entityType, action) => {
    await getModerationAdapter(entityType)!.applyTextScan!(args({ outcome: withScam }) as never);
    expect(await rows()).toHaveLength(1);
    expect(vi.mocked(holdWrite(entityType)).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(action()).mock.invocationCallOrder[0]
    );
  });

  it.each(ACTIONS)(
    '%s fails the callback without running its own action when the hold write fails',
    async (entityType, action) => {
      holdWrite(entityType).mockRejectedValueOnce(new Error('db down'));
      await expect(
        getModerationAdapter(entityType)!.applyTextScan!(args({ outcome: withScam }) as never)
      ).rejects.toThrow('db down');
      expect(action()).not.toHaveBeenCalled();
    }
  );

  it('records the hold on the retry after a failed write, and acts once', async () => {
    dbMock.dbWrite.textScanHold.create.mockRejectedValueOnce(new Error('db down'));
    const outcome = { ...csamOnly, scam: { detected: true, reason: 'test' } };
    const adapter = getModerationAdapter('ChatMessage')!;
    await expect(adapter.applyTextScan!(args({ outcome }) as never)).rejects.toThrow();
    await adapter.applyTextScan!(args({ outcome, workflowId: 'wf-retry' }) as never);
    expect(await rows()).toHaveLength(1);
    expect(autoMuteScamAccount).toHaveBeenCalledTimes(1);
  });

  it('fails the callback when the hold write throws a falsy value', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementationOnce(() => Promise.reject(undefined));
    await expect(getModerationAdapter('Comment')!.applyTextScan!(args() as never)).rejects.toBe(
      undefined
    );
  });

  it('keeps the error message, which can echo the held text, out of the failure log', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(
      Object.assign(new Error('Invalid value: neutral text'), { code: 'P2009' })
    );
    await expect(
      getModerationAdapter('Comment')!.applyTextScan!(args() as never)
    ).rejects.toThrow();
    expect(JSON.stringify(vi.mocked(loggingMock.logToAxiom).mock.calls)).not.toContain(
      'neutral text'
    );
  });

  it('records the csam prompt id handed over by the callback', async () => {
    await getModerationAdapter('Post')!.applyTextScan!(
      args({ promptIds: { base: 1, csam: 9 } }) as never
    );
    expect((await rows())[0].promptId).toBe(9);
  });
});

describe('one pending hold per entity', () => {
  const scan = (over: Record<string, unknown> = {}, entityType: 'Model' | 'Post' = 'Model') =>
    applyCsamHold({ entityType, ...args(over) } as never);
  const edited = (n: number, reason = `reason-${n}`) => ({
    textHash: `hash-${n}`,
    workflowId: `wf-${n}`,
    outcome: { ...csamOnly, csam: { detected: true, reason } },
    subject: {
      ...args().subject,
      fields: [{ heading: 'Model', text: `edit ${n}` }],
      meta: { contentAt: `2026-10-0${n}T00:00:00.000Z`, extra: n },
    },
  });
  const decideRow = (id: number, status: 'Dismissed' | 'Confirmed') =>
    db.pg.query(
      `UPDATE "TextScanHold" SET "status" = $2, "decidedAt" = now(), "meta" = "meta" || '{"decision":"dismiss"}'
       WHERE "id" = $1`,
      [id, status]
    );

  it('updates the one pending hold in place when the text changes', async () => {
    await scan(edited(1));
    await scan(edited(2));
    await scan(edited(3));
    const held = await rows();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      id: 1,
      status: 'Pending',
      textHash: 'hash-3',
      workflowId: 'wf-3',
      reason: 'reason-3',
      contentAt: new Date('2026-10-03T00:00:00.000Z'),
      meta: { extra: 3 },
    });
    expect(held[0].text).toContain('edit 3');
  });

  it('keeps the queue position and every column when the same text is rescanned', async () => {
    await scan(edited(1));
    const [before] = await rows();
    await scan({ ...edited(1), workflowId: 'wf-other' });
    expect(await rows()).toEqual([before]);
  });

  it('holds the same text per entity type and id independently', async () => {
    await scan(edited(1));
    await scan(edited(1), 'Post');
    await scan({ ...edited(1), entityId: 78 });
    expect(await rows()).toHaveLength(3);
  });

  it('does not hold text a moderator already ruled on', async () => {
    await scan(edited(1));
    await decideRow(1, 'Dismissed');
    await scan(edited(1));
    expect(await rows()).toHaveLength(1);
  });

  it('holds changed text after a ruling as a re-detection pointing at the latest ruling', async () => {
    await scan(edited(1));
    await decideRow(1, 'Dismissed');
    await scan(edited(2));
    await decideRow(2, 'Confirmed');
    await scan(edited(3));
    const held = await rows();
    expect(held.map((row) => [row.id, row.status])).toEqual([
      [1, 'Dismissed'],
      [2, 'Confirmed'],
      [3, 'Pending'],
    ]);
    expect(held[1].meta).toMatchObject({ kind: 'redetected', priorHoldId: 1 });
    expect(held[2].meta).toMatchObject({ kind: 'redetected', priorHoldId: 2, extra: 3 });
  });

  it('keeps the replaced text of an unreviewed pending hold, newest first', async () => {
    await scan(edited(1));
    await scan(edited(2));
    await scan(edited(3));
    const [held] = await rows();
    const previous = (held.meta as { previous: Record<string, unknown>[] }).previous;
    expect(previous).toHaveLength(2);
    expect(previous[0]).toMatchObject({
      textHash: 'hash-2',
      reason: 'reason-2',
      workflowId: 'wf-2',
    });
    expect(previous[0].text).toContain('edit 2');
    expect(previous[1]).toMatchObject({ textHash: 'hash-1', reason: 'reason-1' });
    expect(typeof previous[0].at).toBe('string');
  });

  it('stamps when the text was last replaced, and leaves it off a hold never updated', async () => {
    await scan(edited(1));
    expect((await rows())[0].meta).not.toHaveProperty('textUpdatedAt');
    await scan(edited(2));
    const [held] = await rows();
    const { textUpdatedAt, previous } = held.meta as {
      textUpdatedAt: string;
      previous: { at: string }[];
    };
    expect(Number.isNaN(Date.parse(textUpdatedAt))).toBe(false);
    expect(textUpdatedAt).toBe(previous[0].at);
  });

  it('keeps at most the five latest replaced texts', async () => {
    for (let n = 1; n <= 8; n++) await scan(edited(n));
    const [held] = await rows();
    const previous = (held.meta as { previous: { textHash: string }[] }).previous;
    expect(previous.map((p) => p.textHash)).toEqual([
      'hash-7',
      'hash-6',
      'hash-5',
      'hash-4',
      'hash-3',
    ]);
  });

  it('puts old text a moderator ruled on back on the pending hold, noting the earlier ruling', async () => {
    await scan(edited(1));
    await decideRow(1, 'Dismissed');
    await scan(edited(2));
    await scan(edited(1));
    const held = await rows();
    expect(held).toHaveLength(2);
    expect(held[1]).toMatchObject({ status: 'Pending', textHash: 'hash-1' });
    expect(held[1].text).toContain('edit 1');
    expect(held[1].meta).toMatchObject({ ruledBefore: { holdId: 1, status: 'Dismissed' } });
    // Text nobody ruled on drops the note again.
    await scan(edited(3));
    expect((await rows())[1].meta).not.toHaveProperty('ruledBefore');
  });

  it('adds nothing for ruled text when no hold is pending', async () => {
    await scan(edited(1));
    await decideRow(1, 'Confirmed');
    await scan(edited(1));
    expect(await rows()).toHaveLength(1);
  });

  const claimAt = (age: string) =>
    db.pg.exec(`UPDATE "TextScanHold" SET "meta" = "meta" ||
      jsonb_build_object('decisionClaim', jsonb_build_object('by', 7, 'at', now() - interval '${age}'))`);

  it('refuses to swap text under a decision, and fails so the retry rescan records it', async () => {
    await scan(edited(1));
    await claimAt('0 minutes');
    await expect(scan(edited(2))).rejects.toThrow(CsamHoldBusyError);
    expect(await rows()).toMatchObject([{ id: 1, textHash: 'hash-1', status: 'Pending' }]);
    // The claim is released (decision failed or finished); the retried detection then lands.
    await db.pg.exec(`UPDATE "TextScanHold" SET "meta" = "meta" - 'decisionClaim'`);
    await scan(edited(2));
    expect(await rows()).toMatchObject([{ id: 1, textHash: 'hash-2', status: 'Pending' }]);
  });

  it('does not act on the entity when a claim blocks the hold, so the retry redoes both', async () => {
    await scan(edited(1));
    await claimAt('0 minutes');
    await expect(
      getModerationAdapter('Model')!.applyTextScan!(args(edited(2)) as never)
    ).rejects.toThrow(CsamHoldBusyError);
    expect(applyModelPoiMinor).not.toHaveBeenCalled();
  });

  it('keeps honouring a claim well past the five minutes a decision waits before reclaiming it', async () => {
    await scan(edited(1));
    await claimAt('10 minutes');
    await expect(scan(edited(2))).rejects.toThrow(CsamHoldBusyError);
    expect(await rows()).toMatchObject([{ textHash: 'hash-1' }]);
  });

  it('does not fail a rescan of the text the pending hold already has while it is claimed', async () => {
    await scan(edited(1));
    await claimAt('0 minutes');
    await expect(scan(edited(1))).resolves.toBeUndefined();
  });

  it('takes the text over from a claim whose holder is long gone', async () => {
    await scan(edited(1));
    await claimAt('40 minutes');
    await scan(edited(2));
    const [held] = await rows();
    expect(held).toMatchObject({ textHash: 'hash-2' });
    expect(held.meta).not.toHaveProperty('decisionClaim');
  });

  it('keeps a claim that lands between reading the pending hold and replacing its text', async () => {
    await scan(edited(1));
    // A decision's claim does not take the entity lock: land one right after the pending read.
    const run = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values) => {
        const result = await run(strings, ...values);
        if (strings.join('').includes('AS "claimed"')) await claimAt('0 minutes');
        return result;
      }
    );
    await expect(scan(edited(2))).rejects.toThrow(CsamHoldBusyError);
    const [held] = await rows();
    expect(held).toMatchObject({ id: 1, textHash: 'hash-1', status: 'Pending' });
    expect(held.meta).toHaveProperty('decisionClaim.by', 7);
  });

  it('takes the per-entity lock before it looks for rulings', async () => {
    await scan(edited(1));
    const lock = dbMock.dbWrite.$executeRaw.mock.calls.findIndex(([strings]) =>
      String(strings).includes('pg_advisory_xact_lock')
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[lock]).toBeLessThan(
      dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]
    );
  });

  it('ignores a superseded hold when deciding whether text was ruled on', async () => {
    await scan(edited(1));
    await db.pg.exec(`UPDATE "TextScanHold" SET "status" = 'Dismissed',
      "meta" = '{"decision":"superseded","superseded":true}'::jsonb`);
    await scan(edited(1));
    const held = await rows();
    expect(held).toHaveLength(2);
    expect(held[1].meta).not.toHaveProperty('kind');
  });

  it('cannot hold two pending rows for one entity, whatever races', async () => {
    await expect(
      db.pg
        .exec(`INSERT INTO "TextScanHold" ("entityType","entityId","label","textHash","text","reason","updatedAt")
        VALUES ('Model', 1, 'csam', 'a', 't', 'r', now()), ('Model', 1, 'csam', 'b', 't', 'r', now())`)
    ).rejects.toThrow();
  });
});

describe('chat holds over one conversation', () => {
  const chatWindow = (entityId: number, messageIds: number[], chatId = 4) => {
    const base = args();
    return {
      entityType: 'ChatMessage' as const,
      ...base,
      entityId,
      textHash: `hash-${entityId}`,
      subject: { ...base.subject, meta: { chatId, messageIds } },
    };
  };

  it('adds nothing while a pending hold already holds every message of the window', async () => {
    await applyCsamHold(chatWindow(80, [70, 77, 80]));
    await applyCsamHold(chatWindow(81, [77, 80]));
    expect((await rows()).map((row) => row.entityId)).toEqual([80]);
  });

  it('holds a later message that the pending hold never saw', async () => {
    await applyCsamHold(chatWindow(77, [70, 77]));
    await applyCsamHold(chatWindow(80, [77, 80]));
    expect((await rows()).map((row) => row.entityId)).toEqual([77, 80]);
  });

  it('adds nothing when the last decided hold already saw every message', async () => {
    await applyCsamHold(chatWindow(80, [80, 77, 70]));
    await setStatus(1, 'Dismissed');
    await applyCsamHold(chatWindow(81, [80, 77]));
    expect((await rows()).map((row) => row.entityId)).toEqual([80]);
  });

  it('holds again once a new message reaches a decided conversation', async () => {
    await applyCsamHold(chatWindow(77, [77, 70]));
    await setStatus(1, 'Dismissed');
    await applyCsamHold(chatWindow(80, [80, 77]));
    await applyCsamHold(chatWindow(90, [90], 5));
    expect((await rows()).map((row) => row.entityId)).toEqual([77, 80, 90]);
  });
});

describe('applyCsamHold', () => {
  it('stores the scanned text, the csam prompt and the chat window', async () => {
    await applyCsamHold({ entityType: 'ChatMessage', ...args(), promptIds: { base: 1, csam: 9 } });
    expect((await rows())[0]).toMatchObject({
      text: expect.stringContaining('neutral text'),
      promptId: 9,
      contentAt: new Date('2026-10-01T00:00:00.000Z'),
      meta: { chatId: 4, messageIds: [77, 70] },
    });
  });

  it.each([undefined, 0, -1])('stores no author for user id %s', async (userId) => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      subject: { ...base.subject, userId },
    });
    expect((await rows())[0].userId).toBeNull();
  });

  // Postgres rejects both in text and in jsonb, so a stored one would fail every retry.
  const UNSTORABLE =
    /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];

  const unstorable = (row: HoldRow) =>
    [row.text, row.reason, ...strings(row.meta)].filter(
      (v): v is string => typeof v === 'string' && UNSTORABLE.test(v)
    );

  it('strips NUL from the text, the reason and every string in meta', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      outcome: { ...csamOnly, csam: { detected: true, reason: 'te\u0000st' } },
      subject: {
        ...base.subject,
        fields: [{ heading: 'Comment', text: 'neutral\u0000text' }],
        meta: { note: 'a\u0000b', nested: { list: ['c\u0000d', 4] } },
      },
    });
    expect((await rows())[0].text).toContain('neutraltext');
    expect((await rows())[0].reason).toBe('test');
    expect((await rows())[0].meta).toEqual({ note: 'ab', nested: { list: ['cd', 4] } });
    expect(unstorable((await rows())[0])).toEqual([]);
  });

  it('replaces lone surrogates in the text, the reason and nested meta strings', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      outcome: { ...csamOnly, csam: { detected: true, reason: 'low \uDC00 high' } },
      subject: {
        ...base.subject,
        fields: [{ heading: 'Comment', text: 'neutral \uD800 text' }],
        meta: { nested: { list: ['a\uDBFFb', 4], note: 'x\uDFFF' } },
      },
    });
    expect((await rows())[0].text).toContain('neutral \uFFFD text');
    expect((await rows())[0].reason).toBe('low \uFFFD high');
    expect((await rows())[0].meta).toEqual({ nested: { list: ['a\uFFFDb', 4], note: 'x\uFFFD' } });
    expect(unstorable((await rows())[0])).toEqual([]);
  });

  it('keeps a whole surrogate pair', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      subject: { ...base.subject, fields: [{ heading: 'Comment', text: 'smile \u{1F600}' }] },
    });
    expect((await rows())[0].text).toContain('smile \u{1F600}');
  });

  it('cuts the text at the cap without leaving half a surrogate pair', async () => {
    const base = args();
    const at = composeUserText({
      ...base.subject,
      fields: [{ heading: 'Comment', text: 'X' }],
    }).indexOf('X');
    const text = 'a'.repeat(CSAM_HOLD_TEXT_CHARS - 1 - at) + '\u{1F600}' + 'tail';
    const subject = { ...base.subject, fields: [{ heading: 'Comment', text }] };
    expect(composeUserText(subject).charCodeAt(CSAM_HOLD_TEXT_CHARS - 1)).toBe(0xd83d);
    await applyCsamHold({ entityType: 'Comment', ...base, subject });
    const stored = (await rows())[0].text as string;
    expect(stored.length).toBeLessThanOrEqual(CSAM_HOLD_TEXT_CHARS);
    expect(UNSTORABLE.test(stored)).toBe(false);
  });
});

describe('the one-pending-hold migration over existing duplicates', () => {
  it('keeps the newest pending hold per entity and closes the rest as superseded', async () => {
    const old = await PGlite.create();
    try {
      await old.exec(ENTITY_MODERATION_STUB);
      await old.exec(migrationSql(MIGRATIONS[0]));
      const insert = (entityType: string, entityId: number, textHash: string, status = 'Pending') =>
        `INSERT INTO "TextScanHold" ("entityType","entityId","label","textHash","status","text","reason","updatedAt")
         VALUES ('${entityType}', ${entityId}, 'csam', '${textHash}', '${status}', 't', 'r', now());`;
      await old.exec(
        [
          insert('Model', 1, 'a'),
          insert('Model', 1, 'b'),
          insert('Model', 1, 'c'),
          insert('Model', 2, 'a'),
          insert('Model', 1, 'z', 'Dismissed'),
          insert('ChatMessage', 5, 'a'),
          insert('ChatMessage', 5, 'b'),
        ].join('\n')
      );
      await old.exec(migrationSql(MIGRATIONS[1]));
      await old.exec(migrationSql(MIGRATIONS[1]));

      const { rows } = await old.query<{ id: number; status: string; meta: unknown }>(
        'SELECT "id","status","meta" FROM "TextScanHold" ORDER BY "id"'
      );
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        [1, 'Dismissed'],
        [2, 'Dismissed'],
        [3, 'Pending'],
        [4, 'Pending'],
        [5, 'Dismissed'],
        [6, 'Pending'],
        [7, 'Pending'],
      ]);
      expect(rows[0].meta).toMatchObject({
        decision: 'superseded',
        superseded: true,
        supersededBy: 3,
      });
      expect(rows[1].meta).toMatchObject({ decision: 'superseded', supersededBy: 3 });
      expect(rows[4].meta).toBeNull();
    } finally {
      await old.close();
    }
  });
});
