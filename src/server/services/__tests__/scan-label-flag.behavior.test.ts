import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockIsFlipt } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: mockIsFlipt,
}));
import {
  recordScanLabelFlag,
  SCAN_LABEL_MAX_ITEMS_PER_POST,
} from '~/server/services/scan-label-flag.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLog = loggingMock.logToAxiom;

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const IMAGE = 61;
const IMAGE_ROW = `SELECT ingestion, "needsReview", "blockedFor", "nsfwLevel", minor, poi FROM "Image" WHERE id = ${IMAGE}`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "postId" int,
      ingestion text,
      "needsReview" text,
      "blockedFor" text,
      "nsfwLevel" int,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false
    );
    -- "ScanLabelItem" and "ScanLabelFlag" exactly as the scan-label-queue migration creates them.
    CREATE TABLE IF NOT EXISTS "ScanLabelItem" (
      "id"             SERIAL PRIMARY KEY,
      "imageId"        INTEGER NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
      "lane"           TEXT NOT NULL DEFAULT 'flagged' CHECK ("lane" IN ('flagged', 'control')),
      "firstFlaggedAt" TIMESTAMPTZ(3) NOT NULL,
      "status"         TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'decided', 'void')),
      "voidReason"     TEXT,
      "votes"          SMALLINT NOT NULL DEFAULT 0 CHECK ("votes" BETWEEN 0 AND 3),
      "blockVotes"     SMALLINT NOT NULL DEFAULT 0 CHECK ("blockVotes" BETWEEN 0 AND "votes"),
      "outcome"        TEXT CHECK ("outcome" IN ('block', 'clear')),
      "unanimous"      BOOLEAN,
      "decidedAt"      TIMESTAMPTZ(3),
      "actionedAt"     TIMESTAMPTZ(3),
      "actionError"    TEXT,
      "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "ScanLabelItem_imageId_key" ON "ScanLabelItem" ("imageId");
    CREATE INDEX IF NOT EXISTS "ScanLabelItem_queue_idx"
      ON "ScanLabelItem" ("status", "votes" DESC, "firstFlaggedAt" DESC);

    CREATE TABLE IF NOT EXISTS "ScanLabelFlag" (
      "id"             SERIAL PRIMARY KEY,
      "itemId"         INTEGER NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
      "source"         TEXT NOT NULL CHECK ("source" IN ('orchestrator-scan', 'xguard-prompt', 'control-sample')),
      "flaggerVersion" TEXT NOT NULL,
      "reason"         TEXT,
      "workflowId"     TEXT NOT NULL,
      "flaggedAt"      TIMESTAMPTZ(3) NOT NULL,
      "snapshot"       JSONB,
      "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "ScanLabelFlag_workflowId_key" ON "ScanLabelFlag" ("workflowId");
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsFlipt.mockResolvedValue(true);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image" CASCADE;
    INSERT INTO "Image" (id, ingestion, "nsfwLevel") VALUES (${IMAGE}, 'Scanned', 16);
  `);
});

const flag = (over: Partial<Parameters<typeof recordScanLabelFlag>[0]> = {}) =>
  recordScanLabelFlag({
    imageId: IMAGE,
    source: 'orchestrator-scan',
    reason: 'refused',
    workflowId: 'wf-1',
    flaggedAt: new Date('2026-10-13T12:00:00Z'),
    snapshot: { nsfwLevel: 'x' },
    ...over,
  });

const items = async () =>
  (
    await holder.db.query<{ imageId: number; status: string; firstFlaggedAt: Date }>(
      `SELECT "imageId", status, "firstFlaggedAt" FROM "ScanLabelItem"`
    )
  ).rows;
const flags = async () =>
  (
    await holder.db.query<{
      source: string;
      flaggerVersion: string;
      workflowId: string;
      reason: string;
    }>(
      `SELECT source, "flaggerVersion", "workflowId", reason, snapshot FROM "ScanLabelFlag" ORDER BY id`
    )
  ).rows;

describe('recordScanLabelFlag', () => {
  it('opens a label item for the image and records the flag on it', async () => {
    await flag();

    expect(await items()).toEqual([
      { imageId: IMAGE, status: 'open', firstFlaggedAt: new Date('2026-10-13T12:00:00Z') },
    ]);
    expect(await flags()).toEqual([
      {
        source: 'orchestrator-scan',
        flaggerVersion: 'orchestrator@2026-10-12',
        workflowId: 'wf-1',
        reason: 'refused',
        snapshot: { nsfwLevel: 'x' },
      },
    ]);
  });

  it('leaves the image row exactly as it was', async () => {
    const before = (await holder.db.query(IMAGE_ROW)).rows;

    await flag();

    expect((await holder.db.query(IMAGE_ROW)).rows).toEqual(before);
  });

  it('records a redelivered workflow once', async () => {
    await flag();
    await flag();

    expect(await flags()).toHaveLength(1);
  });

  it('hangs a second flag on the same item and keeps the earliest flag time', async () => {
    await flag();
    await flag({
      workflowId: 'wf-2',
      source: 'xguard-prompt',
      reason: 'young',
      flaggedAt: new Date('2026-10-13T09:00:00Z'),
    });

    expect(await items()).toEqual([
      { imageId: IMAGE, status: 'open', firstFlaggedAt: new Date('2026-10-13T09:00:00Z') },
    ]);
    expect((await flags()).map((f) => f.flaggerVersion)).toEqual([
      'orchestrator@2026-10-12',
      'xguard-prompt@2026-10-13',
    ]);
  });

  it('keeps the earliest flag time when a later flag arrives', async () => {
    await flag();
    await flag({ workflowId: 'wf-2', flaggedAt: new Date('2026-10-14T12:00:00Z') });

    expect((await items())[0].firstFlaggedAt).toEqual(new Date('2026-10-13T12:00:00Z'));
  });

  it('does not reopen an item moderators already decided', async () => {
    await flag();
    await holder.db.exec(
      `UPDATE "ScanLabelItem" SET status = 'decided', votes = 3, outcome = 'clear'`
    );

    await flag({ workflowId: 'wf-2' });

    expect((await items())[0].status).toBe('decided');
    expect(await flags()).toHaveLength(2);
  });

  it('leaves a control-lane item in its lane', async () => {
    await holder.db.exec(
      `INSERT INTO "ScanLabelItem" ("imageId", lane, "firstFlaggedAt") VALUES (${IMAGE}, 'control', now())`
    );

    await flag();

    expect((await holder.db.query(`SELECT lane FROM "ScanLabelItem"`)).rows).toEqual([
      { lane: 'control' },
    ]);
    expect(await flags()).toHaveLength(1);
  });

  it('writes nothing while the flag is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await flag();

    expect(await items()).toEqual([]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  describe('per-post cap', () => {
    const POST = 900;
    const postImages = async (ids: number[], postId: number | null = POST) =>
      holder.db.exec(
        `INSERT INTO "Image" (id, "postId", ingestion) VALUES ${ids
          .map((id) => `(${id}, ${postId ?? 'NULL'}, 'Scanned')`)
          .join(', ')}`
      );
    const queued = async () => (await items()).map((i) => i.imageId).sort((a, b) => a - b);

    it('is three', () => {
      expect(SCAN_LABEL_MAX_ITEMS_PER_POST).toBe(3);
    });

    it("queues a post's first three flagged images and skips the rest", async () => {
      await postImages([101, 102, 103, 104, 105]);

      for (const imageId of [101, 102, 103, 104, 105])
        await flag({ imageId, workflowId: `wf-${imageId}` });

      expect(await queued()).toEqual([101, 102, 103]);
      expect(await flags()).toHaveLength(3);
    });

    it('still records a new flag on an image the post already has queued', async () => {
      await postImages([101, 102, 103, 104]);
      for (const imageId of [101, 102, 103]) await flag({ imageId, workflowId: `wf-${imageId}` });

      await flag({ imageId: 102, workflowId: 'wf-102-rescan', source: 'xguard-prompt' });
      await flag({ imageId: 104, workflowId: 'wf-104' });

      expect(await queued()).toEqual([101, 102, 103]);
      expect((await flags()).map((f) => f.workflowId)).toEqual([
        'wf-101',
        'wf-102',
        'wf-103',
        'wf-102-rescan',
      ]);
    });

    it('counts decided items toward the cap', async () => {
      await postImages([101, 102, 103, 104]);
      for (const imageId of [101, 102, 103]) await flag({ imageId, workflowId: `wf-${imageId}` });
      await holder.db.exec(
        `UPDATE "ScanLabelItem" SET status = 'decided', votes = 3, outcome = 'clear'`
      );

      await flag({ imageId: 104, workflowId: 'wf-104' });

      expect(await queued()).toEqual([101, 102, 103]);
    });

    it('does not count control-lane items toward the cap', async () => {
      await postImages([101, 102, 103, 104]);
      await holder.db.exec(
        `INSERT INTO "ScanLabelItem" ("imageId", lane, "firstFlaggedAt") VALUES (101, 'control', now())`
      );
      for (const imageId of [102, 103, 104]) await flag({ imageId, workflowId: `wf-${imageId}` });

      expect(await queued()).toEqual([101, 102, 103, 104]);
    });

    it('caps each post on its own', async () => {
      await postImages([101, 102, 103, 104]);
      await postImages([201, 202], 901);

      for (const imageId of [101, 102, 103, 104, 201, 202])
        await flag({ imageId, workflowId: `wf-${imageId}` });

      expect(await queued()).toEqual([101, 102, 103, 201, 202]);
    });

    it('does not cap images outside a post', async () => {
      await postImages([301, 302, 303, 304], null);

      for (const imageId of [301, 302, 303, 304])
        await flag({ imageId, workflowId: `wf-${imageId}` });

      expect(await queued()).toEqual([301, 302, 303, 304]);
    });

    // Parallel scan callbacks for one post must not all pass the count: the count runs after the
    // post's lock, in the same transaction, in a statement of its own.
    it('locks the post inside the transaction before the capped insert', async () => {
      await postImages([101]);
      const ops: { sql: string; values: unknown[]; via: 'tx' | 'dbWrite' }[] = [];
      const bridged = dbMock.dbWrite.$executeRaw.getMockImplementation()!;
      const record =
        (via: 'tx' | 'dbWrite') =>
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          ops.push({ sql: strings.join('?'), values, via });
          return bridged(strings, ...values);
        };
      dbMock.dbWrite.$executeRaw.mockImplementation(record('dbWrite') as never);
      dbMock.dbWrite.$transaction.mockImplementationOnce(
        async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: record('tx') })
      );

      await flag({ imageId: 101, workflowId: 'wf-101' });

      expect(ops.map((o) => o.via)).toEqual(['tx', 'tx']);
      expect(ops[0].sql).toContain('pg_advisory_xact_lock(?::int, "postId")');
      expect(ops[0].values).toEqual([0x5c1a0001, 101]);
      expect(ops[1].sql).toContain('INSERT INTO "ScanLabelItem"');
      expect(ops[1].sql).not.toContain('pg_advisory');
      expect(await queued()).toEqual([101]);
    });
  });

  it('logs and does not throw when the write fails', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('relation does not exist') as never);

    await expect(flag()).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-label-flag', type: 'error', imageId: IMAGE })
    );
  });
});
