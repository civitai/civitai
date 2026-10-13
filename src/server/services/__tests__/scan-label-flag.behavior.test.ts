import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockIsFlipt, mockLog } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockLog: vi.fn(async () => undefined),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLog }));

import { recordScanLabelFlag } from '~/server/services/scan-label-flag.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const IMAGE = 61;
const IMAGE_ROW = `SELECT ingestion, "needsReview", "blockedFor", "nsfwLevel", minor, poi FROM "Image" WHERE id = ${IMAGE}`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      ingestion text,
      "needsReview" text,
      "blockedFor" text,
      "nsfwLevel" int,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ScanLabelItem" (
      id serial PRIMARY KEY,
      "imageId" int NOT NULL UNIQUE REFERENCES "Image"(id) ON DELETE CASCADE,
      lane text NOT NULL,
      "firstFlaggedAt" timestamptz NOT NULL,
      status text NOT NULL,
      votes smallint NOT NULL DEFAULT 0,
      outcome text
    );
    CREATE TABLE "ScanLabelFlag" (
      id serial PRIMARY KEY,
      "itemId" int NOT NULL REFERENCES "ScanLabelItem"(id) ON DELETE CASCADE,
      source text NOT NULL,
      "flaggerVersion" text NOT NULL,
      reason text,
      "workflowId" text NOT NULL UNIQUE,
      "flaggedAt" timestamptz NOT NULL,
      snapshot jsonb NOT NULL
    );
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

  it('does not reopen an item moderators already decided', async () => {
    await flag();
    await holder.db.exec(
      `UPDATE "ScanLabelItem" SET status = 'decided', votes = 3, outcome = 'clear'`
    );

    await flag({ workflowId: 'wf-2' });

    expect((await items())[0].status).toBe('decided');
    expect(await flags()).toHaveLength(2);
  });

  it('writes nothing while the flag is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await flag();

    expect(await items()).toEqual([]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('logs and does not throw when the write fails', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('relation does not exist') as never);

    await expect(flag()).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-label-flag', type: 'error', imageId: IMAGE })
    );
  });
});
