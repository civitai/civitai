import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseKnightsSourcesConfig } from '@civitai/shared/new-order';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  knightsSampleDraw,
  runKnightsPublishSampling,
  sampleNewlyLivePostsForKnights,
  type PublishSampleCursor,
} from '~/server/services/knights/sampling';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const NOW = new Date('2026-12-11T10:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
/** As Postgres stores a `timestamp` column: the UTC wall clock. */
const ts = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').replace('Z', '') : null;

let pg: PGlite;
const db = pgliteKysely(() => pg);

const config = (fields: Record<string, unknown>) =>
  parseKnightsSourcesConfig(JSON.stringify({ enabled: true, ...fields }));

async function post(id: number, publishedAt: Date | null) {
  await pg.query(`INSERT INTO "Post" (id, "publishedAt") VALUES ($1, $2)`, [id, ts(publishedAt)]);
}

async function images(
  postId: number,
  ids: number[],
  fields: { nsfwLevel?: number; type?: string; ingestion?: string } = {}
) {
  for (const id of ids)
    await pg.query(
      `INSERT INTO "Image" (id, "postId", "nsfwLevel", type, ingestion) VALUES ($1, $2, $3, $4, $5)`,
      [id, postId, fields.nsfwLevel ?? 1, fields.type ?? 'image', fields.ingestion ?? 'Scanned']
    );
}

const queued = async () =>
  (
    await pg.query<{ imageId: number; source: string; priority: number; status: string }>(
      `SELECT "imageId", source, priority, status FROM "KnightsQueueItem" ORDER BY "imageId"`
    )
  ).rows;

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TABLE "Post" (id integer PRIMARY KEY, "publishedAt" timestamp, availability text NOT NULL DEFAULT 'Public');
     CREATE TABLE "Image" (
       id integer PRIMARY KEY, "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false,
       type text NOT NULL DEFAULT 'image', "nsfwLevel" integer NOT NULL DEFAULT 1,
       ingestion text NOT NULL DEFAULT 'Scanned', "blockedFor" text, "postId" integer,
       poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
       "userId" integer NOT NULL DEFAULT 1
     );`
  );
  await pg.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261210120000_knights_v2_tables/migration.sql'
      ),
      'utf8'
    )
  );
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM "KnightsQueueItem"; DELETE FROM "Image"; DELETE FROM "Post";`);
});

describe('knightsSampleDraw', () => {
  it('gives each image one fixed draw in [0, 1), spread over the range', () => {
    const draws = range(1, 1000).map(knightsSampleDraw);
    expect(range(1, 1000).map(knightsSampleDraw)).toEqual(draws);
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    const below = draws.filter((d) => d < 0.3).length;
    expect(below).toBeGreaterThan(200);
    expect(below).toBeLessThan(400);
  });
});

describe('sampleNewlyLivePostsForKnights', () => {
  const at = (publishedAt: Date, postId = 0): PublishSampleCursor => ({ publishedAt, postId });
  const run = (
    cursor: PublishSampleCursor | null,
    fields: Record<string, unknown> = {},
    { postLimit, now = NOW }: { postLimit?: number; now?: Date } = {}
  ) => sampleNewlyLivePostsForKnights(db, { cursor, now, config: config(fields), postLimit });
  const sweep = (since: Date, fields: Record<string, unknown> = {}, postLimit?: number) =>
    run(at(since), fields, { postLimit });

  it('queues the scanned still images of posts that went live since the last run, and nothing else', async () => {
    await post(1, minutesAgo(5)); // live in the window
    await images(1, [11, 12]);
    await images(1, [13], { type: 'video' });
    await images(1, [14], { nsfwLevel: 0, ingestion: 'Pending' }); // not scanned yet
    await images(1, [15], { nsfwLevel: 32 }); // Blocked
    await images(1, [16], { nsfwLevel: 8 }); // NSFW: priority 2
    await images(1, [17, 18, 19]);
    await pg.query(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 12`);
    await pg.query(`UPDATE "Image" SET poi = true WHERE id = 17`);
    await pg.query(`UPDATE "Image" SET minor = true WHERE id = 18`);
    await pg.query(`UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = 19`);
    await post(2, null); // draft
    await images(2, [21]);
    await post(3, new Date(NOW.getTime() + 60 * 60_000)); // scheduled for later
    await images(3, [31]);
    await post(4, minutesAgo(30)); // live before the last run's overlap
    await images(4, [41]);

    const result = await sweep(minutesAgo(10), { sfwRate: 1, nsfwRate: 1 });

    expect(await queued()).toEqual([
      { imageId: 11, source: 'scan-sample', priority: 1, status: 'Open' },
      { imageId: 16, source: 'scan-sample', priority: 2, status: 'Open' },
    ]);
    expect(result).toMatchObject({ posts: 1, enqueued: 2, capped: false });
    // Nothing more was due, so the next run starts where this window ended, a minute behind the clock.
    expect(result.cursor).toEqual(at(minutesAgo(1)));
  });

  it('skips the images of a Private post without spending queue room on them, and queues those of an Unsearchable one', async () => {
    await post(1, minutesAgo(5));
    await post(2, minutesAgo(5));
    await images(1, [11]);
    await images(2, [21]);
    await pg.query(`UPDATE "Post" SET availability = 'Private' WHERE id = 1`);
    await pg.query(`UPDATE "Post" SET availability = 'Unsearchable' WHERE id = 2`);

    // One slot of room: only 21 may take it.
    const result = await sweep(minutesAgo(10), { sfwRate: 1, nsfwRate: 1, maxOpen: 1 });

    expect(await queued()).toEqual([
      { imageId: 21, source: 'scan-sample', priority: 1, status: 'Open' },
    ]);
    expect(result).toMatchObject({ posts: 2, enqueued: 1, capped: false });
  });

  it('leaves a post published within the last minute to the next run', async () => {
    await post(1, new Date(NOW.getTime() - 20_000));
    await images(1, [11]);

    const first = await sweep(minutesAgo(10), { sfwRate: 1 });
    expect(await queued()).toEqual([]);

    const second = await run(
      first.cursor,
      { sfwRate: 1 },
      { now: new Date(NOW.getTime() + 60_000) }
    );
    expect(second.enqueued).toBe(1);
    expect((await queued()).map((i) => i.imageId)).toEqual([11]);
  });

  it('catches a post whose publishedAt lands behind the cursor, within the overlap it re-reads', async () => {
    const first = await sweep(minutesAgo(10), { sfwRate: 1 });
    expect(first.cursor).toEqual(at(minutesAgo(1)));
    // A scheduled publish stamps the scheduled time, and commits after the run that passed it.
    await post(1, minutesAgo(3));
    await images(1, [11]);
    // Behind the overlap: never seen.
    await post(2, minutesAgo(20));
    await images(2, [21]);

    const second = await run(first.cursor, { sfwRate: 1 });

    expect(second.enqueued).toBe(1);
    expect((await queued()).map((i) => i.imageId)).toEqual([11]);
  });

  it('drains a group of posts sharing one publish instant that is larger than the batch', async () => {
    const instant = minutesAgo(5);
    for (const id of [1, 2, 3, 4, 5]) {
      await post(id, instant);
      await images(id, [id * 10]);
    }

    let cursor: PublishSampleCursor | null = at(minutesAgo(10));
    const cursors: PublishSampleCursor[] = [];
    for (
      let runs = 0;
      runs < 10 && cursors.at(-1)?.publishedAt.getTime() !== minutesAgo(1).getTime();
      runs++
    ) {
      cursor = (await run(cursor, { sfwRate: 1 }, { postLimit: 2 })).cursor;
      cursors.push(cursor);
    }

    expect(cursors).toEqual([at(instant, 2), at(instant, 4), at(minutesAgo(1))]);
    expect((await queued()).map((i) => i.imageId)).toEqual([10, 20, 30, 40, 50]);
  });

  it('draws each image once: the same images are picked on every run, and only that share of each pool', async () => {
    await post(1, minutesAgo(5));
    await images(1, range(1000, 40));
    await images(1, range(2000, 40), { nsfwLevel: 16 });

    await sweep(minutesAgo(10), { sfwRate: 0, nsfwRate: 0.5 });
    const picked = (await queued()).map((i) => i.imageId);

    expect(picked.every((id) => id >= 2000)).toBe(true);
    expect(picked).toEqual(range(2000, 40).filter((id) => knightsSampleDraw(id) < 0.5));
    expect(picked.length).toBeGreaterThan(5);
    expect(picked.length).toBeLessThan(35);

    // An overlapping run (or the scan path) re-draws nothing: the misses stay out, the picks stay single.
    await pg.exec(`UPDATE "KnightsQueueItem" SET status = 'Closed'`);
    const again = await sweep(minutesAgo(20), { sfwRate: 0, nsfwRate: 0.5 });
    expect(again.enqueued).toBe(0);
    expect((await queued()).map((i) => i.imageId)).toEqual(picked);
  });

  it('never queues an image that already had a rating item, closed included, so a republished post is not asked again', async () => {
    const closedItem = (imageId: number) =>
      pg.query(
        `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status")
         VALUES ('knights.image.nsfwLevel', $1, 'scan-sample', 'Knight', 5, 'Closed')`,
        [imageId]
      );
    // Unpublished and republished: the old publishedAt comes back, outside every later window.
    await post(1, minutesAgo(60 * 24 * 3));
    await images(1, [11, 12]);
    await closedItem(11);
    // Gone live again with a fresh date: only the image never asked about is queued.
    await post(2, minutesAgo(5));
    await images(2, [21, 22]);
    await closedItem(21);

    const result = await sweep(minutesAgo(10), { sfwRate: 1 });

    expect(result).toMatchObject({ posts: 1, enqueued: 1 });
    expect((await queued()).map((i) => [i.imageId, i.status])).toEqual([
      [11, 'Closed'],
      [21, 'Closed'],
      [22, 'Open'],
    ]);
  });

  it('fills the queue only up to maxOpen servable Knight-stage items, counting again as it goes', async () => {
    await post(9, new Date('2020-01-01T00:00:00Z'));
    await images(9, [91, 92]);
    for (const imageId of [91, 92])
      await pg.query(
        `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded")
         VALUES ('knights.image.nsfwLevel', $1, 'test', 'Knight', 5)`,
        [imageId]
      );
    await post(1, minutesAgo(5));
    await images(1, [11, 12, 13, 14, 15]);

    const full = await sweep(minutesAgo(10), { sfwRate: 1, maxOpen: 2 });
    expect(full).toMatchObject({ capped: true, enqueued: 0 });
    expect((await queued()).map((i) => i.imageId)).toEqual([91, 92]);

    const room = await sweep(minutesAgo(10), { sfwRate: 1, maxOpen: 4 });
    expect(room).toMatchObject({ capped: true, enqueued: 2 });
    expect((await queued()).map((i) => i.imageId)).toEqual([11, 12, 91, 92]);
  });

  it('does nothing while the sources are off, and still moves past the window', async () => {
    await post(1, minutesAgo(5));
    await images(1, [11]);

    const result = await sampleNewlyLivePostsForKnights(db, {
      cursor: at(minutesAgo(10)),
      now: NOW,
      config: parseKnightsSourcesConfig(null),
    });

    expect(await queued()).toEqual([]);
    expect(result).toMatchObject({ posts: 0, enqueued: 0 });
    expect(result.cursor).toEqual(at(minutesAgo(1)));
  });

  it('reads a bounded batch of posts per run and resumes after the last one it read', async () => {
    for (const id of [1, 2, 3, 4, 5]) {
      await post(id, minutesAgo(10 - id));
      await images(id, [id * 10]);
    }

    const first = await sweep(minutesAgo(20), { sfwRate: 1 }, 2);
    expect(first.posts).toBe(2);
    expect((await queued()).map((i) => i.imageId)).toEqual([10, 20]);
    expect(first.cursor).toEqual(at(minutesAgo(8), 2));

    const second = await run(first.cursor, { sfwRate: 1 }, { postLimit: 2 });
    const third = await run(second.cursor, { sfwRate: 1 }, { postLimit: 2 });
    expect(second.cursor).toEqual(at(minutesAgo(6), 4));
    expect(third.cursor).toEqual(at(minutesAgo(1)));
    expect((await queued()).map((i) => i.imageId)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never reaches further back than six hours, with no cursor or an old one', async () => {
    await post(1, minutesAgo(60 * 7));
    await images(1, [11]);
    await post(2, minutesAgo(60 * 5));
    await images(2, [21]);

    await run(null, { sfwRate: 1 });
    await sweep(new Date(0), { sfwRate: 1 });

    expect((await queued()).map((i) => i.imageId)).toEqual([21]);
  });
});

describe('runKnightsPublishSampling', () => {
  const store = (initial: PublishSampleCursor | null) => {
    const saved: PublishSampleCursor[] = [];
    return {
      saved,
      loadCursor: async () => initial,
      saveCursor: async (cursor: PublishSampleCursor) => {
        saved.push(cursor);
      },
    };
  };
  const start = { publishedAt: minutesAgo(10), postId: 0 };

  it('keeps the cursor when the sources switch could not be read, so the window is retried', async () => {
    await post(1, minutesAgo(5));
    await images(1, [11]);
    const cursor = store(start);

    const result = await runKnightsPublishSampling(db, {
      now: NOW,
      readConfig: async () => null,
      ...cursor,
    });

    expect(result).toEqual({ skipped: 'config-unreadable' });
    expect(cursor.saved).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it('moves the cursor past the window when the sources are off, and samples from it when on', async () => {
    await post(1, minutesAgo(5));
    await images(1, [11]);
    const off = store(start);
    await runKnightsPublishSampling(db, {
      now: NOW,
      readConfig: async () => parseKnightsSourcesConfig(null),
      ...off,
    });
    expect(off.saved).toEqual([{ publishedAt: minutesAgo(1), postId: 0 }]);

    const on = store(start);
    await runKnightsPublishSampling(db, {
      now: NOW,
      readConfig: async () => config({ sfwRate: 1 }),
      ...on,
    });
    expect(on.saved).toEqual([{ publishedAt: minutesAgo(1), postId: 0 }]);
    expect((await queued()).map((i) => i.imageId)).toEqual([11]);
  });
});
