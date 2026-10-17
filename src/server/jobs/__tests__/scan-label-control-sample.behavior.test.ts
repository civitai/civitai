import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: vi.fn(async () => {
    throw new Error('the tests pass inRollout');
  }),
}));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const { feedScanLabelControlSample, CONTROL_SAMPLE_VERSION } = await import(
  '~/server/jobs/scan-label-control-sample'
);

const MIGRATIONS = [
  '20261022130000_scan_label_queue',
  '20261104120000_scan_label_control_lane_idx',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
);

const NOW = new Date('2026-10-17T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL DEFAULT 7,
      "url" text NOT NULL DEFAULT 'u',
      "postId" integer,
      "createdAt" timestamptz(3) NOT NULL,
      "ingestion" text NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "blockedFor" text,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "nsfwLevel" integer NOT NULL DEFAULT 1
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "ScanLabelItem", "Image", "CsamReport" CASCADE`);
});

/** Image `id` in post `id` (unless given), created `60 - id` hours before NOW, so ids follow time. */
async function image(id: number, over: Record<string, unknown> = {}) {
  const row = { id, postId: id, createdAt: hoursAgo(60 - id), ...over };
  const cols = Object.keys(row);
  await holder.db.query(
    `INSERT INTO "Image" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row)
  );
}

async function queued(
  imageId: number,
  { lane = 'flagged', status = 'open', createdAt = NOW } = {}
) {
  await holder.db.query(
    `INSERT INTO "ScanLabelItem" ("imageId", "lane", "status", "firstFlaggedAt", "createdAt")
     VALUES ($1, $2, $3, $4, $4)`,
    [imageId, lane, status, createdAt]
  );
}

const controlImages = async () =>
  (
    await holder.db.query<{ imageId: number }>(
      `SELECT "imageId" FROM "ScanLabelItem" WHERE lane = 'control' ORDER BY "imageId"`
    )
  ).rows.map((r) => r.imageId);

/** Evenly spaced draws, so every id in the window is some draw's start. */
const spread = () => {
  let k = 0;
  return () => (((k++ * 0.618034) % 1) + 1) % 1;
};
const everyone = async () => true;

describe('feedScanLabelControlSample exclusions', () => {
  it('samples only recent, settled uploads that passed and are not queued', async () => {
    await image(1, { createdAt: hoursAgo(80) }); // before the window
    await image(2);
    await image(3, { ingestion: 'Blocked' });
    await image(4);
    await image(5, { blockedFor: 'Something' });
    await image(6);
    await image(7, { tosViolation: true });
    await image(8);
    await image(9, { needsReview: 'minor' });
    await image(11, { nsfwLevel: 32 });
    await image(13, { userId: 99 });
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (99)`);
    await image(14);
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 14}]')`);
    await image(15);
    await queued(15);
    // Post 100 is at the writer's cap, so its unqueued image may have been flagged and skipped.
    for (const id of [17, 18, 19, 20]) await image(id, { postId: 100 });
    for (const id of [18, 19, 20]) await queued(id);
    await image(21, { postId: null });
    await image(23); // outside the writer's rollout
    // Post 200: two passed images, of which one is taken.
    await image(25, { postId: 200 });
    await image(26, { postId: 200 });
    // Post 300 is below the cap.
    for (const id of [27, 28, 29]) await image(id, { postId: 300 });
    for (const id of [28, 29]) await queued(id);
    await image(30, { createdAt: hoursAgo(0.5) }); // still settling

    const result = await feedScanLabelControlSample({
      now: NOW,
      rng: spread(),
      inRollout: async (id) => id !== 23,
    });

    const sampled = await controlImages();
    const fromPost200 = sampled.filter((id) => id === 25 || id === 26);
    expect(fromPost200).toHaveLength(1);
    expect(sampled.filter((id) => id !== 25 && id !== 26)).toEqual([2, 4, 6, 8, 27]);
    expect(result).toMatchObject({ added: 6 });
  });

  it('records each sample with a control flag', async () => {
    await image(2, { nsfwLevel: 4 });
    await feedScanLabelControlSample({ now: NOW, rng: spread(), inRollout: everyone });
    const { rows } = await holder.db.query(
      `SELECT i.lane, i.status, i."firstFlaggedAt", f.source, f."flaggerVersion", f."workflowId", f.snapshot
       FROM "ScanLabelItem" i JOIN "ScanLabelFlag" f ON f."itemId" = i.id`
    );
    expect(rows).toEqual([
      {
        lane: 'control',
        status: 'open',
        firstFlaggedAt: NOW,
        source: 'control-sample',
        flaggerVersion: CONTROL_SAMPLE_VERSION,
        workflowId: 'control-sample:2',
        snapshot: { nsfwLevel: 4 },
      },
    ]);
  });

  it('adds nothing when no upload is in the window', async () => {
    await image(1, { createdAt: hoursAgo(80) });
    await image(2, { createdAt: hoursAgo(0.5) });
    expect(
      await feedScanLabelControlSample({ now: NOW, rng: spread(), inRollout: everyone })
    ).toMatchObject({ added: 0 });
    expect(await controlImages()).toEqual([]);
  });
});

describe('feedScanLabelControlSample caps', () => {
  beforeEach(async () => {
    for (let id = 1; id <= 59; id++) await image(id);
  });
  const feed = () => feedScanLabelControlSample({ now: NOW, rng: spread(), inRollout: everyone });

  it('adds at most ten a run, and tops the open lane up to thirty, no further', async () => {
    const added = [];
    for (let run = 0; run < 4; run++) added.push((await feed()).added);
    expect(added).toEqual([10, 10, 10, 0]);
  });

  it('fills only the gap to thirty open', async () => {
    for (let id = 201; id <= 225; id++) {
      await image(id, { createdAt: hoursAgo(0.5) }); // settling, so never sampled
      await queued(id, { lane: 'control', createdAt: hoursAgo(30) });
    }
    expect((await feed()).added).toBe(5);
  });

  it('adds no more than sixty in 24 hours, however many are decided', async () => {
    for (let id = 201; id <= 255; id++) {
      await image(id, { createdAt: hoursAgo(0.5) }); // settling, so never sampled
      await queued(id, { lane: 'control', status: 'decided', createdAt: hoursAgo(23) });
    }
    // 55 added in the last day: room for five.
    expect((await feed()).added).toBe(5);
    await holder.db.exec(`UPDATE "ScanLabelItem" SET status = 'decided'`);
    expect((await feed()).added).toBe(0);
  });

  it('does not count control items older than a day against the daily cap', async () => {
    for (let id = 201; id <= 260; id++) {
      await image(id, { createdAt: hoursAgo(0.5) }); // settling, so never sampled
      await queued(id, { lane: 'control', status: 'decided', createdAt: hoursAgo(25) });
    }
    expect((await feed()).added).toBe(10);
  });
});
