import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { isFlipt } from '~/server/flipt/client';

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

const spread = () => {
  let k = 0;
  return () => (((k++ * 0.618034) % 1) + 1) % 1;
};
const everyone = async () => true;

const startingAt = (ids: number[], lo: number, hi: number) => {
  let k = 0;
  return () => (ids[k++ % ids.length] - lo + 0.5) / (hi - lo);
};

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
    await image(12, { createdAt: hoursAgo(0.3) }); // a low id created in the settle hour
    await image(13, { userId: 99 });
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (99)`);
    await image(14);
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 14}]')`);
    await image(15);
    await queued(15);
    // Post 100 is at the writer's cap.
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
    // Post 400 already gave a control sample.
    for (const id of [33, 34]) await image(id, { postId: 400 });
    await queued(33, { lane: 'control', status: 'decided', createdAt: hoursAgo(40) });
    await image(39, { createdAt: hoursAgo(1.2) }); // settled
    await image(40, { createdAt: hoursAgo(0.5) }); // still settling

    // Draws span ids [2, 41), from the window's first image to the newest; one starts at each.
    const everyId = Array.from({ length: 39 }, (_, k) => 2 + k);
    const result = await feedScanLabelControlSample({
      now: NOW,
      rng: startingAt(everyId, 2, 41),
      inRollout: async (id) => id !== 23,
    });

    const sampled = (await controlImages()).filter((id) => id !== 33);
    const fromPost200 = sampled.filter((id) => id === 25 || id === 26);
    expect(fromPost200).toHaveLength(1);
    expect(sampled.filter((id) => id !== 25 && id !== 26)).toEqual([2, 4, 6, 8, 27, 39]);
    expect(result).toMatchObject({ added: 7 });
  });

  it('takes the first draws, in draw order, when more images qualify than it needs', async () => {
    for (let id = 1; id <= 20; id++) await image(id);
    await image(21, { createdAt: hoursAgo(0.5) });
    const draws = [20, 3, 17, 5, 11, 8, 14, 2, 19, 6, 13, 9];
    await feedScanLabelControlSample({
      now: NOW,
      rng: startingAt(draws, 1, 22),
      inRollout: everyone,
    });
    expect(await controlImages()).toEqual(draws.slice(0, 10).sort((a, b) => a - b));
  });

  it('does not spend a slot on an image already queued', async () => {
    for (let id = 2; id <= 5; id++) await image(id);
    await queued(2);
    // One slot left: 29 open control items on settling images. Draws span ids [2, 230).
    for (let id = 201; id <= 229; id++) {
      await image(id, { createdAt: hoursAgo(0.5) });
      await queued(id, { lane: 'control', createdAt: hoursAgo(30) });
    }
    expect(
      await feedScanLabelControlSample({
        now: NOW,
        rng: startingAt([2, 4], 2, 230),
        inRollout: everyone,
      })
    ).toMatchObject({ added: 1 });
    // The draw at 2 walks on to 3 rather than taking the queued image.
    expect((await controlImages()).filter((id) => id < 200)).toEqual([3]);
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
        flaggerVersion: 'control-sample@2026-10-17',
        workflowId: 'control-sample:2',
        snapshot: { nsfwLevel: 4 },
      },
    ]);
    expect(CONTROL_SAMPLE_VERSION).toBe('control-sample@2026-10-17');
  });

  it('asks the queue writer’s flag about each image by default', async () => {
    await image(2);
    vi.mocked(isFlipt).mockResolvedValueOnce(true);
    expect(await feedScanLabelControlSample({ now: NOW, rng: spread() })).toMatchObject({
      added: 1,
    });
    expect(isFlipt).toHaveBeenCalledWith('scan-label-queue-writer', '2');
  });

  it('leaves an image the writer queued meanwhile in its flagged item', async () => {
    await image(2);
    await image(4);
    const result = await feedScanLabelControlSample({
      now: NOW,
      rng: spread(),
      inRollout: async (id) => {
        if (id === 2) await queued(2);
        return true;
      },
    });
    expect(result).toMatchObject({ added: 1 });
    const { rows } = await holder.db.query(
      `SELECT i."imageId", i.lane, array_agg(f.source) FILTER (WHERE f.source IS NOT NULL) AS sources
       FROM "ScanLabelItem" i LEFT JOIN "ScanLabelFlag" f ON f."itemId" = i.id
       GROUP BY i."imageId", i.lane ORDER BY i."imageId"`
    );
    expect(rows).toEqual([
      { imageId: 2, lane: 'flagged', sources: null },
      { imageId: 4, lane: 'control', sources: ['control-sample'] },
    ]);
  });

  it('does not add an image that stopped qualifying after it was chosen', async () => {
    await image(2);
    await image(4);
    const result = await feedScanLabelControlSample({
      now: NOW,
      rng: spread(),
      inRollout: async (id) => {
        if (id === 2) await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'X' WHERE id = 2`);
        return true;
      },
    });
    expect(result).toMatchObject({ added: 1 });
    expect(await controlImages()).toEqual([4]);
  });

  it('bounds createdAt only in the insert, never in the candidate walk', async () => {
    await image(2);
    vi.mocked(dbMock.dbWrite.$queryRaw).mockClear();
    vi.mocked(dbMock.dbWrite.$executeRaw).mockClear();
    await feedScanLabelControlSample({ now: NOW, rng: spread(), inRollout: everyone });
    const text = (calls: unknown[][]) =>
      calls.map(
        ([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).text
      );
    const walk = text(vi.mocked(dbMock.dbWrite.$queryRaw).mock.calls).filter((t) =>
      t.includes('CROSS JOIN LATERAL')
    );
    const [insert] = text(vi.mocked(dbMock.dbWrite.$executeRaw).mock.calls);
    expect(walk).toHaveLength(1);
    expect(walk[0]).not.toContain('"createdAt"');
    expect(insert).toContain('img."createdAt" >=');
    expect(await controlImages()).toEqual([2]);
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
  let nextId = 201;
  beforeEach(async () => {
    nextId = 201;
    for (let id = 1; id <= 59; id++) await image(id);
  });
  const feed = () => feedScanLabelControlSample({ now: NOW, rng: spread(), inRollout: everyone });
  /** Control items on settling images (ids 201+), so they never collide with a sample. */
  async function controlItems(n: number, opts: { status: string; createdAt: Date }) {
    for (let k = 0; k < n; k++) {
      const id = nextId++;
      await image(id, { createdAt: hoursAgo(0.5) });
      await queued(id, { lane: 'control', ...opts });
    }
  }

  it('adds at most ten a run, and tops the open lane up to thirty, no further', async () => {
    const added = [];
    for (let run = 0; run < 4; run++) added.push((await feed()).added);
    expect(added).toEqual([10, 10, 10, 0]);
  });

  it('fills only the gap to thirty open', async () => {
    await controlItems(25, { status: 'open', createdAt: hoursAgo(30) });
    expect((await feed()).added).toBe(5);
  });

  it('counts every control item of the last 24 hours against sixty, whatever its status', async () => {
    await controlItems(20, { status: 'open', createdAt: hoursAgo(23) });
    await controlItems(20, { status: 'void', createdAt: hoursAgo(23) });
    await controlItems(15, { status: 'decided', createdAt: hoursAgo(23) });
    expect((await feed()).added).toBe(5);
    await holder.db.exec(`UPDATE "ScanLabelItem" SET status = 'decided'`);
    expect((await feed()).added).toBe(0);
  });

  it('does not count control items older than a day against the daily cap', async () => {
    await controlItems(60, { status: 'decided', createdAt: hoursAgo(25) });
    expect((await feed()).added).toBe(10);
  });
});
