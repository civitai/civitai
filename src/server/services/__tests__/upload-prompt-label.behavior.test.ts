import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockRequest, mockIsFlipt } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockIsFlipt: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mockRequest,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: mockIsFlipt,
}));

import { recordScanLabelFlag } from '~/server/services/scan-label-flag.service';
import { labelUploadPrompt } from '~/server/services/upload-prompt-scan.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, scans: 0 }));
const IMAGE = 71;
const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261022130000_scan_label_queue/migration.sql'
);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);`);
  await holder.db.exec(fs.readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.scans = 0;
  mockIsFlipt.mockResolvedValue(true);
  // Each scan is a new orchestrator workflow, so a second scan carries a second workflow id.
  mockRequest.mockImplementation(async () => ({
    id: `xg-${++holder.scans}`,
    steps: [
      {
        $type: 'xGuardModeration',
        output: { results: [{ label: 'young', score: 0.9, threshold: 0.5, triggered: true }] },
      },
    ],
  }));
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]);
  };
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).affectedRows ?? 0) as never
  );
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).rows) as never
  );
  await holder.db.exec(`
    TRUNCATE "Image" CASCADE;
    INSERT INTO "Image" (id) VALUES (${IMAGE});
  `);
});

const promptFlags = async () =>
  (
    await holder.db.query<{ workflowId: string }>(
      `SELECT "workflowId" FROM "ScanLabelFlag" WHERE source = 'xguard-prompt'`
    )
  ).rows;

const deliver = () => labelUploadPrompt({ imageId: IMAGE, userId: 2, prompt: 'a prompt' });

describe('a redelivered upload', () => {
  it('is scanned and labelled once', async () => {
    await deliver();
    await deliver();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(await promptFlags()).toEqual([{ workflowId: 'xg-1' }]);
  });

  it('still gets its prompt label when the image scan flagged it first', async () => {
    await recordScanLabelFlag({
      imageId: IMAGE,
      source: 'orchestrator-scan',
      reason: 'refused',
      workflowId: 'wf-1',
      flaggedAt: new Date(),
      snapshot: {},
    });

    await deliver();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(await promptFlags()).toHaveLength(1);
  });
});

describe('two deliveries that both got past the check', () => {
  const record = (workflowId: string, oncePerImage: boolean) =>
    recordScanLabelFlag({
      imageId: IMAGE,
      source: 'xguard-prompt',
      reason: 'young',
      workflowId,
      flaggedAt: new Date(),
      snapshot: {},
      oncePerImage,
    });

  it('record one prompt label for the image', async () => {
    await record('xg-1', true);
    await record('xg-2', true);

    expect(await promptFlags()).toEqual([{ workflowId: 'xg-1' }]);
  });

  it('record one per workflow when the once-per-image guard is off (control)', async () => {
    await record('xg-1', false);
    await record('xg-2', false);

    expect(await promptFlags()).toHaveLength(2);
  });
});
