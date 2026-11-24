import type { PGlite } from '@electric-sql/pglite';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { countOpenServableKnightItems, readWithoutJit } from '@civitai/db/knights';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { engage, lockImage } from '../../../test/seed';
import { PROGRESSION } from '../progression/config';
import { listJudgments } from '../progression/judgments';
import { settleFinalItems } from '../progression/progression';
import {
  castVote,
  applyPendingResolutions,
  closeModeratorRuledItems,
  closeUnservableItems,
  closeWithoutOutcome,
  enqueueItem,
  ensureVotePartitions,
  escalateExpired,
  getFeed as serveFeed,
  MAX_APPLY_ATTEMPTS,
  type MovedItem,
  type QueueDeps,
  bucketLevelSql,
  servableItems,
  STAGE_SCAN_FIRST_ROUND,
} from './queue.service';
import { itemBucket, levelBucket } from './feed';
import { creditLateJudgment } from './vote-record';

const Q = KNIGHTS_NSFW_LEVEL_QUESTION;
/** The starvation draw is random in production; these tests pin the ordinary path. */
const getFeed: typeof serveFeed = (db, userId, options = {}) =>
  serveFeed(db, userId, { random: () => 0.99, ...options });
const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
/** For `countOpenServableKnightItems`, which only the main app runs, as its role reads. */
let mainAppDb: Kysely<DB>;

/** Noon on the 10th, `n` months from the real month: inside the window the partition function accepts. */
const monthsFromNow = (n: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + n, 10, 12));
};

/** Drops the vote partition holding `at` when it has no votes, so a test can watch it be created. Returns its name. */
async function dropEmptyPartition(at: Date) {
  const name = `KnightsVote_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}`;
  await pg.exec(`DO $$ BEGIN
    IF to_regclass('"${name}"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${name}") THEN DROP TABLE "${name}"; END IF;
  END $$;`);
  return name;
}
let transactions: { open: () => number };
const APPLIED = { outcome: 'applied' } as const;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => APPLIED);
const depsAt = (now: Date): QueueDeps => ({ applyConsensus, now: () => now });
const deps = () => depsAt(NOW);
const afterMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function player(userId: number, rankType: string, exp = 0) {
  await pg.query(`INSERT INTO "NewOrderPlayer" ("userId","rankType","exp") VALUES ($1,$2,$3)`, [
    userId,
    rankType,
    exp,
  ]);
}

/** A player who has voted recently, which is what makes a rank count as served. Any vote will do. */
async function active(userId: number, rank: string, daysAgo = 0) {
  await player(userId, rank);
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
     VALUES ($1,$2,$3,$4,0,'Knight','4',1)`,
    [-userId, userId, new Date(NOW.getTime() - daysAgo * 86_400_000), Q]
  );
}

async function image(id: number, nsfwLevel = 4, publishedAt: string | null = '2020-01-01') {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [id, publishedAt]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,$3,$1)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}

async function item(
  imageId: number,
  o: {
    minRank?: string;
    priority?: number;
    question?: string;
    hidden?: boolean;
    expires?: Date;
    votesNeeded?: number;
  } = {}
) {
  return enqueueItem(
    db,
    {
      questionKey: o.question ?? Q,
      imageId,
      source: 'test',
      minRank: o.minRank ?? 'Knight',
      priority: o.priority,
      isHiddenCheck: o.hidden,
      votesNeeded: o.votesNeeded,
      expiresAt: o.expires ?? null,
    },
    NOW
  );
}

/**
 * Open priority-1 Knight items, one per level given (each on its own published image), all enqueued at the same instant,
 * which has milliseconds, so only the id orders them and a scan cursor must carry that instant exactly. Returns the item
 * ids in serving order.
 */
async function sameAgeStage(levels: number[], firstImage = 100_000) {
  const params = [`{${levels.join(',')}}`, firstImage];
  const rows = `unnest($1::int[]) WITH ORDINALITY AS t(level, n)`;
  await pg.query(
    `INSERT INTO "Post" ("id","publishedAt") SELECT $2::int + n, '2020-01-01'::timestamp FROM ${rows}`,
    params
  );
  await pg.query(
    `INSERT INTO "Image" ("id","url","nsfwLevel","postId")
     SELECT $2::int + n, 'key-' || ($2::int + n), level, $2::int + n FROM ${rows}`,
    params
  );
  const items = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","priority","createdAt","updatedAt")
     SELECT $3::text, $2::int + n, 'test', 'Knight', 5, 1, '2026-12-15 11:00:00.123'::timestamp, '2026-12-15 11:00:00.123'::timestamp
     FROM ${rows} ORDER BY n RETURNING id`,
    [...params, Q]
  );
  return items.rows.map((r) => r.id).sort((a, b) => a - b);
}

/**
 * `db`, recording the ids each read returns: `rounds` for the stage-scan rounds (the rows carrying a `createdAtKey`),
 * `fullReads` for the reads of served columns (rows carrying an `imageKey`). A read that returns no rows is not seen.
 * `onRound` runs after each round's rows come back and before the next round starts.
 */
function watchFeedReads(onRound?: (ids: number[]) => Promise<void>) {
  const rounds: number[][] = [];
  const fullReads: number[][] = [];
  const plugin: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      const rows = result.rows as Record<string, unknown>[];
      const ids = rows.map((r) => r.id as number);
      if (rows.some((r) => 'createdAtKey' in r)) {
        rounds.push(ids);
        await onRound?.(ids);
      } else if (rows.some((r) => 'imageKey' in r)) {
        fullReads.push(ids);
      }
      return result;
    },
  };
  return { db: db.withPlugin(plugin), rounds, fullReads };
}

const itemRow = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [id]))
    .rows[0];
const verdicts = async (id: number) =>
  (
    await pg.query<{ playerId: number; verdict: string; stage: string }>(
      `SELECT "playerId", verdict, stage FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [id]
    )
  ).rows;

beforeAll(async () => {
  ({ pg, db, mainAppDb, transactions } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options")
    VALUES ('knights.test.bool','bool','Is there a hat?','[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]')`);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  applyConsensus.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post","UserEngagement","KnightsPlayerDay" RESTART IDENTITY CASCADE`
  );
});

async function fiveKnights(first = 1) {
  for (let i = 0; i < 5; i++) await player(first + i, 'Knight');
}

async function vote(userId: number, itemId: number, answer: string, blockReason?: string) {
  return castVote(
    db,
    { userId, itemId, answer, blockReason: blockReason ?? (answer === '32' ? 'Other' : undefined) },
    deps()
  );
}

const reasons = async (id: number) =>
  (
    await pg.query<{ playerId: number; blockReason: string | null }>(
      `SELECT "playerId", "blockReason" FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [id]
    )
  ).rows;

describe('getFeed', () => {
  it('returns open Knight items the player has not voted, and never the rating', async () => {
    await player(1, 'Knight');
    await image(10, 8);
    await image(11, 8);
    const a = await item(10);
    const b = await item(11);
    await vote(1, a, '8');

    const feed = await getFeed(db, 1);
    expect(feed?.items.map((i) => i.id)).toEqual([b]);
    expect(JSON.stringify(feed)).not.toMatch(/"nsfwLevel"\s*:/);
  });

  it('keeps yes/no questions out of the rating feed and refuses a vote on one', async () => {
    await player(1, 'Knight');
    await image(10);
    const yesNo = await item(10, { question: 'knights.test.bool' });
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "audience" = 'players', "prompt" = 'Hat?' WHERE id = $1`,
      [yesNo]
    );

    expect(await getFeed(db, 1)).toBeNull();
    expect(await vote(1, yesNo, 'yes')).toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('puts escalated items first for Templars and keeps Knights off them', async () => {
    await player(1, 'Knight');
    await player(2, 'Templar');
    await image(10);
    await image(11);
    const knightItem = await item(10, { priority: 1 });
    const escalated = await item(11, { minRank: 'Templar', priority: 3 });

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([knightItem]);
    expect((await getFeed(db, 2))?.items.map((i) => i.id)).toEqual([escalated, knightItem]);
  });

  it('orders by priority then age, and skips hidden checks and Acolytes', async () => {
    await player(1, 'Knight');
    await player(2, 'Acolyte');
    for (const id of [10, 11, 12, 13]) await image(id);
    const low = await item(10, { priority: 3 });
    const high = await item(11, { priority: 1 });
    await item(12, { hidden: true });
    const mid = await item(13, { priority: 2 });

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([high, mid, low]);
    expect(await getFeed(db, 2)).toBeNull();
  });

  it('leaves out the items a player skipped, and only for that player', async () => {
    await player(1, 'Knight');
    await player(2, 'Knight');
    for (const id of [10, 11]) await image(id);
    const first = await item(10, { priority: 1 });
    const second = await item(11, { priority: 2 });

    expect((await getFeed(db, 1, { exclude: [first] }))?.items.map((i) => i.id)).toEqual([second]);
    expect(await getFeed(db, 1, { exclude: [first, second] })).toBeNull();
    expect((await getFeed(db, 2))?.items.map((i) => i.id)).toEqual([first, second]);
  });

  it('serves only as many items as asked for', async () => {
    await player(1, 'Knight');
    for (const id of [10, 11, 12]) await image(id);
    const first = await item(10, { priority: 1 });
    await item(11, { priority: 2 });
    await item(12, { priority: 3 });

    expect((await getFeed(db, 1, { limit: 1 }))?.items.map((i) => i.id)).toEqual([first]);
  });

  it('fills the stretch from the chosen question even when another question has more items', async () => {
    await player(1, 'Knight');
    for (let i = 0; i < 12; i++) await image(100 + i);
    for (let i = 0; i < 3; i++) await item(100 + i, { priority: 2 });
    for (let i = 3; i < 12; i++)
      await item(100 + i, { priority: 1, question: 'knights.test.bool' });
    for (let i = 0; i < 40; i++) {
      await image(200 + i);
      await item(200 + i, { priority: 2 });
    }
    const feed = await getFeed(db, 1);
    expect(feed?.question.key).toBe('knights.test.bool');
    expect(feed?.items.length).toBe(9);
  });

  it('serves nothing to Inquisitors, and the feed and castVote agree on every rank', async () => {
    await player(1, 'Inquisitor');
    await image(10);
    const id = await item(10);
    expect(await getFeed(db, 1)).toBeNull();
    expect(await vote(1, id, '4')).toMatchObject({ status: 'rejected', reason: 'not-eligible' });

    for (const [userId, rank] of [
      [2, 'Acolyte'],
      [3, 'Knight'],
      [4, 'Templar'],
      [5, 'Paladin'],
    ] as const) {
      await player(userId, rank);
      const servedItems = (await getFeed(db, userId))?.items.map((i) => i.id) ?? [];
      const outcome = await vote(userId, id, '999');
      expect(outcome.status === 'rejected' && outcome.reason !== 'not-eligible').toBe(
        servedItems.includes(id)
      );
    }
  });

  it('serves one question at a time', async () => {
    await player(1, 'Knight');
    await image(10);
    await image(11);
    const rating = await item(10, { priority: 2 });
    await item(11, { priority: 1, question: 'knights.test.bool' });

    const feed = await getFeed(db, 1);
    expect(feed?.question.key).toBe('knights.test.bool');
    expect(feed?.items.map((i) => i.id)).not.toContain(rating);
  });

  it('serves NSFW scan items (priority 2) while 40 or more priority-1 items are open', async () => {
    await player(1, 'Knight');
    for (let i = 0; i < 45; i++) {
      await image(100 + i, 1);
      await item(100 + i, { priority: 1 });
    }
    const nsfw: number[] = [];
    for (let i = 0; i < 5; i++) {
      await image(200 + i, 8);
      nsfw.push(await item(200 + i, { priority: 2 }));
    }

    const served = (await getFeed(db, 1))?.items.map((i) => i.id) ?? [];
    expect(served.filter((id) => nsfw.includes(id)).length).toBeGreaterThan(0);
  });

  it('serves a bucket whose first item sits behind a whole scan round of another bucket', async () => {
    await player(1, 'Knight');
    // One full first round of PG items ahead in serving order, so the X item is the first row of the second round. Every
    // item shares a priority and enqueue time, so only the id puts the X item after the round's last row.
    for (let n = 0; n < STAGE_SCAN_FIRST_ROUND; n++) {
      await image(1000 + n, 1);
      await item(1000 + n, { priority: 1 });
    }
    await image(5000, 8);
    const x = await item(5000, { priority: 1 });

    const served = (await getFeed(db, 1))?.items.map((i) => i.id) ?? [];
    expect(served).toContain(x);
  });

  it('scans a stage whose buckets cannot fill in doubling rounds, and fetches the full rows of the kept items only', async () => {
    await player(1, 'Knight');
    // 350 PG items then one X item: only the PG bucket can fill, so the scan reads the whole stage. 351 rows overshoot
    // the first two rounds (100, then 200), so the third round (400) is the partial one that ends the scan.
    const ids = await sameAgeStage([...Array<number>(350).fill(1), 8]);
    const x = ids[350];
    const watched = watchFeedReads();

    const served = (await getFeed(watched.db, 1))?.items.map((i) => i.id) ?? [];
    expect(served).toContain(x);
    expect(STAGE_SCAN_FIRST_ROUND).toBe(100);
    expect(watched.rounds.map((r) => r.length)).toEqual([100, 200, 51]);
    // Each round starts right after the last row of the one before: every row once, in serving order.
    expect(watched.rounds.flat()).toEqual(ids);
    // The served columns are read once, for the first 10 PG items and the X item, not for the 340 PG items left out.
    expect(watched.fullReads.map((r) => [...r].sort((a, b) => a - b))).toEqual([
      [...ids.slice(0, 10), x],
    ]);
  });

  it('continues the scan after the last row read even when that row is gone by the next round', async () => {
    await player(1, 'Knight');
    const ids = await sameAgeStage([...Array<number>(150).fill(1), 8]);
    const x = ids[150];
    const watched = watchFeedReads(async (round) => {
      if (round.length === STAGE_SCAN_FIRST_ROUND) {
        await pg.query(`DELETE FROM "KnightsQueueItem" WHERE id = $1`, [round[round.length - 1]]);
      }
    });

    const served = (await getFeed(watched.db, 1))?.items.map((i) => i.id) ?? [];
    expect(watched.rounds.map((r) => r.length)).toEqual([100, 51]);
    expect(watched.rounds[1][0]).toBe(ids[100]);
    expect(served).toContain(x);
  });

  // SET LOCAL must not outlive the transaction it ran in: a pooled connection would carry JIT off to every later read.
  it('turns JIT off only until the transaction that turned it off ends', async () => {
    const jit = async (executor: Kysely<DB>) =>
      (await sql<{ jit: string }>`SHOW jit`.execute(executor)).rows[0].jit;
    await sql`SET jit = on`.execute(db);
    expect(await readWithoutJit(db, (trx) => jit(trx))).toBe('off');
    expect(await jit(db)).toBe('on');
    await db.transaction().execute(async (trx) => {
      expect(await readWithoutJit(trx, (inner) => jit(inner))).toBe('off');
    });
    expect(await jit(db)).toBe('on');
  });

  // Its estimate would start parallel workers that take longer to start than the small read takes to run.
  it('turns parallel workers off for the read, only until its transaction ends', async () => {
    const workers = async (executor: Kysely<DB>) =>
      (
        await sql<{
          max_parallel_workers_per_gather: string;
        }>`SHOW max_parallel_workers_per_gather`.execute(executor)
      ).rows[0].max_parallel_workers_per_gather;
    await sql`SET max_parallel_workers_per_gather = 2`.execute(db);
    const before = await workers(db);
    expect(before).toBe('2');
    expect(await readWithoutJit(db, (trx) => workers(trx))).toBe('0');
    expect(await workers(db)).toBe(before);
    await db.transaction().execute(async (trx) => {
      expect(await readWithoutJit(trx, (inner) => workers(inner))).toBe('0');
    });
    expect(await workers(db)).toBe(before);
  });

  it('reads each level bucket by the same rule as itemBucket', async () => {
    // Raw JSON text, so jsonb keeps what a producer could write (a 4.0 keeps its scale).
    const predictions = [
      'null',
      '{"value":8}',
      '{"value":"16"}',
      '{"value":4.0}',
      '{"value":32}',
      '{"value":"4.0"}',
      '{"value":true}',
      '{"value":"X"}',
      '[8]',
      '"loose"',
      '{"other":2}',
    ];
    for (const [n, prediction] of predictions.entries()) {
      await image(300 + n, n % 2 ? 1 : 2);
      const id = await item(300 + n);
      await pg.query(`UPDATE "KnightsQueueItem" SET prediction = $1::jsonb WHERE id = $2`, [
        prediction,
        id,
      ]);
    }
    await image(399, 3);
    await item(399);

    const rows = await readWithoutJit(db, (trx) =>
      servableItems(trx)
        .select([bucketLevelSql.as('level'), 'i.prediction', 'img.nsfwLevel'])
        .execute()
    );
    expect(rows).toHaveLength(predictions.length + 1);
    for (const row of rows) {
      expect(levelBucket(Number(row.level))).toBe(itemBucket(row.prediction, row.nsfwLevel));
    }
  });

  it('reads only the five level buckets, so an item whose level has none is not served', async () => {
    await player(1, 'Knight');
    await image(10, 3);
    await image(11, 8);
    await item(10);
    const x = await item(11);

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([x]);
  });

  it('serves escalated items of every bucket first at a later stage, from one read', async () => {
    await player(1, 'Templar');
    const escalated: number[] = [];
    for (const [n, level] of [1, 2, 4, 8, 16, 4, 4].entries()) {
      await image(500 + n, level);
      escalated.push(await item(500 + n, { minRank: 'Templar', priority: 3 }));
    }
    await pg.query(`UPDATE "KnightsQueueItem" SET "escalatedAt" = $1`, [afterMinutes(-60)]);
    await image(600, 4);
    const normal = await item(600, { minRank: 'Templar', priority: 1 });

    const served = (await getFeed(db, 1, { limit: 10 }))?.items.map((i) => i.id) ?? [];
    expect(new Set(served.slice(0, escalated.length))).toEqual(new Set(escalated));
    expect(served).toContain(normal);
  });
});

describe('castVote rejections', () => {
  it('rejects Acolytes, repeat votes, unknown answers and too-low ranks', async () => {
    await player(1, 'Acolyte');
    await player(2, 'Knight');
    await image(10);
    await image(11);
    const high = await item(10);
    const escalated = await item(11, { minRank: 'Templar' });

    expect(await vote(1, high, '4')).toMatchObject({ status: 'rejected', reason: 'not-eligible' });
    expect(await vote(2, high, '999')).toMatchObject({ status: 'rejected', reason: 'bad-answer' });
    expect(await vote(2, escalated, '4')).toMatchObject({
      status: 'rejected',
      reason: 'not-eligible',
    });
    expect(await vote(2, high, '4')).toMatchObject({ status: 'recorded' });
    expect(await vote(2, high, '8')).toMatchObject({ status: 'rejected', reason: 'already-voted' });
  });
});

describe('castVote block reasons', () => {
  const rejected = { status: 'rejected', reason: 'bad-block-reason' };

  it('refuses a Blocked vote with no reason or one that is not on the list, and writes nothing', async () => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10);

    expect(await castVote(db, { userId: 1, itemId: id, answer: '32' }, deps())).toMatchObject(
      rejected
    );
    expect(
      await castVote(db, { userId: 1, itemId: id, answer: '32', blockReason: '' }, deps())
    ).toMatchObject(rejected);
    expect(await vote(1, id, '32', 'Whatever')).toMatchObject(rejected);
    expect(await reasons(id)).toEqual([]);
  });

  it('refuses a reason on any other rating', async () => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10);

    expect(await vote(1, id, '8', 'Other')).toMatchObject(rejected);
    expect(await reasons(id)).toEqual([]);
  });

  it('stores the reason on a Blocked vote and none on another rating', async () => {
    await player(1, 'Knight');
    await player(2, 'Knight');
    await image(10);
    const id = await item(10);

    expect(await vote(1, id, '32', 'DepictsRealPerson')).toMatchObject({ status: 'recorded' });
    expect(await vote(2, id, '8')).toMatchObject({ status: 'recorded' });

    expect(await reasons(id)).toEqual([
      { playerId: 1, blockReason: 'DepictsRealPerson' },
      { playerId: 2, blockReason: null },
    ]);
  });

  it('refuses a reason on a question that is not the rating', async () => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10, { question: 'knights.test.bool' });

    expect(await vote(1, id, 'yes', 'Other')).toMatchObject(rejected);
  });
});

describe('castVote eligibility matches the feed', () => {
  it.each([
    [
      'a hidden check',
      (id: number) =>
        pg.query(`UPDATE "KnightsQueueItem" SET "isHiddenCheck"=true WHERE id=$1`, [id]),
    ],
    [
      'an inactive question',
      () => pg.query(`UPDATE "KnightsQuestion" SET active=false WHERE key='knights.test.bool'`),
    ],
    ['a non-image', () => pg.query(`UPDATE "Image" SET type='video' WHERE id=10`)],
  ])('refuses a vote on %s', async (_label, hide) => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10, { question: 'knights.test.bool' });
    await hide(id);
    try {
      expect(await getFeed(db, 1)).toBeNull();
      expect(await vote(1, id, 'yes')).toMatchObject({ status: 'rejected', reason: 'unavailable' });
      expect(await verdicts(id)).toEqual([]);
    } finally {
      await pg.query(`UPDATE "KnightsQuestion" SET active=true WHERE key='knights.test.bool'`);
    }
  });
});

describe('question defaults', () => {
  it('takes the question rank and vote count unless the item sets its own', async () => {
    await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","minRank","votesToResolve")
      VALUES ('knights.test.defaults','bool','Hat?','[{"value":"yes","label":"Yes"}]','Templar',2)`);
    await image(10);
    await image(11);
    const inherited = await enqueueItem(
      db,
      { questionKey: 'knights.test.defaults', imageId: 10, source: 'test' },
      NOW
    );
    const overridden = await enqueueItem(
      db,
      {
        questionKey: 'knights.test.defaults',
        imageId: 11,
        source: 'test',
        minRank: 'Knight',
        votesNeeded: 3,
      },
      NOW
    );
    expect(await itemRow(inherited)).toMatchObject({ minRank: 'Templar', votesNeeded: 2 });
    expect(await itemRow(overridden)).toMatchObject({ minRank: 'Knight', votesNeeded: 3 });
    expect((await itemRow(inherited)).expiresAt).toEqual(new Date('2026-12-18T12:00:00Z'));

    await player(1, 'Templar');
    await player(2, 'Templar');
    await vote(1, inherited, 'yes');
    expect((await vote(2, inherited, 'yes')).status).toBe('resolved');
  });
});

describe('resolution', () => {
  it('resolves at four agreeing votes, grades every vote and applies the rating once', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    const votesBefore = await counterValue('knights_votes_total', { kind: 'rating' });
    const resolvedBefore = await counterValue('knights_items_resolved_total', { stage: 'Knight' });

    for (const u of [1, 2, 3]) expect((await vote(u, id, '4')).status).toBe('recorded');
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await vote(4, id, '4')).status).toBe('resolved');
    expect(await counterValue('knights_votes_total', { kind: 'rating' })).toBe(votesBefore + 4);
    expect(await counterValue('knights_items_resolved_total', { stage: 'Knight' })).toBe(
      resolvedBefore + 1
    );

    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect(applyConsensus).toHaveBeenCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '4',
      actorId: 4,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
    expect((await verdicts(id)).every((v) => v.verdict === 'correct')).toBe(true);

    expect(await vote(1, id, '4')).toMatchObject({ status: 'rejected' });
    expect(applyConsensus).toHaveBeenCalledTimes(1);
  });

  it('marks dissenters failed', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');
    await vote(4, id, '8');
    await vote(5, id, '4');
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual([
      'correct',
      'correct',
      'correct',
      'failed',
      'correct',
    ]);
  });

  it('keeps a split open until ten votes, then escalates to Templars with votes still pending', async () => {
    await fiveKnights(1);
    await fiveKnights(6);
    await active(90, 'Templar');
    await image(10, 4);
    const id = await item(10);
    const answers = ['1', '2', '4', '8', '16', '1', '2', '4', '8', '16'];
    for (let i = 0; i < 9; i++) expect((await vote(i + 1, id, answers[i])).status).toBe('recorded');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });
    const before = await counterValue('knights_escalations_total', { reason: 'next-stage' });

    expect((await vote(10, id, answers[9])).status).toBe('escalated');
    expect(await counterValue('knights_escalations_total', { reason: 'next-stage' })).toBe(
      before + 1
    );
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
    expect((await itemRow(id)).expiresAt).toEqual(new Date('2026-12-18T12:00:00Z'));
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('grades the Knight votes by the Templar outcome', async () => {
    await fiveKnights(1);
    await fiveKnights(6);
    for (let u = 20; u < 25; u++) await active(u, 'Templar');
    await image(10, 4);
    const id = await item(10);
    const answers = ['1', '2', '4', '8', '16', '1', '2', '4', '8', '16'];
    for (let i = 0; i < 10; i++) await vote(i + 1, id, answers[i]);

    for (let u = 20; u < 22; u++) await vote(u, id, '4');
    expect((await vote(22, id, '4')).status).toBe('resolved');

    const graded = await verdicts(id);
    expect(graded.filter((v) => v.verdict === 'correct').length).toBe(2 + 3);
    expect(graded.filter((v) => v.verdict === 'failed').length).toBe(8);
    expect(applyConsensus).toHaveBeenCalledTimes(1);
  });

  it('re-rates a Paladin split instead of handing it to the Inquisitors', async () => {
    for (let u = 20; u < 24; u++) await player(u, 'Paladin');
    await image(10, 4);
    const id = await item(10, { minRank: 'Paladin' });
    const answers = ['1', '2', '4', '8'];
    const before = await counterValue('knights_escalations_total', {
      reason: 'no-consensus-rerate',
    });
    for (let i = 0; i < 4; i++) await vote(20 + i, id, answers[i]);
    expect(await counterValue('knights_escalations_total', { reason: 'no-consensus-rerate' })).toBe(
      before + 1
    );

    // Four answers, one vote each: the highest of them.
    expect(await itemRow(id)).toMatchObject({
      status: 'Resolved',
      minRank: 'Paladin',
      resolvedValue: '8',
      reason: 'no-consensus-rerate',
      escalationReason: null,
    });
    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect((await verdicts(id)).every((v) => v.verdict === 'inconclusive')).toBe(true);
  });

  it('sends a rating more than one level below the current one to the Inquisitors', async () => {
    await fiveKnights();
    await image(10, 16);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '4');

    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      resolvedValue: null,
      questionKey: Q,
      escalationReason: 'pushed-down',
      meta: { escalatedFromLevel: 16 },
    });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
  });

  it('allows a one-level down-rating', async () => {
    await fiveKnights();
    await image(10, 8);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '4');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved' });
  });

  it('keeps a Blocked consensus away from the image and hands it to the Inquisitors', async () => {
    await fiveKnights();
    await image(10, 16);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '32');

    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      resolvedValue: null,
      questionKey: Q,
      escalationReason: 'blocked',
    });
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('commits the vote when the rating cannot be written back, and a retry applies it once', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');

    applyConsensus.mockRejectedValueOnce(new Error('main app down'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    expect((await vote(4, id, '4')).status).toBe('resolved');
    expect(await itemRow(id)).toMatchObject({
      status: 'Resolved',
      resolvedValue: '4',
      resolvedBy: 4,
      appliedAt: null,
    });
    const graded = await verdicts(id);
    expect(graded.map((v) => v.verdict)).toEqual(Array(4).fill('correct'));

    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 0,
    });
    expect(await applyPendingResolutions(db, depsAt(afterMinutes(6)))).toEqual({
      applied: 1,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).toHaveBeenCalledTimes(2);
    expect(applyConsensus).toHaveBeenLastCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '4',
      actorId: 4,
    });
    expect((await itemRow(id)).appliedAt).toEqual(afterMinutes(6));
    expect(await verdicts(id)).toEqual(graded);

    expect(await applyPendingResolutions(db, depsAt(afterMinutes(60)))).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).toHaveBeenCalledTimes(2);
  });

  it('does not hold a transaction open while the rating is written back', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');

    let openDuringCall: number | undefined;
    applyConsensus.mockImplementationOnce(async () => {
      openDuringCall = transactions.open();
      return APPLIED;
    });
    await vote(4, id, '4');
    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect(openDuringCall).toBe(0);
  });

  it('accepts the vote when settling it throws after the commit, and the job applies it later', async () => {
    await fiveKnights();
    await image(10, 4);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');

    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(NOW)
      .mockImplementationOnce(() => {
        throw new Error('db hiccup while settling');
      });
    const result = await castVote(
      db,
      { userId: 4, itemId: id, answer: '4' },
      { applyConsensus, now }
    );

    expect(result.status).toBe('resolved');
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', appliedAt: null });
    expect((await verdicts(id)).every((v) => v.verdict === 'correct')).toBe(true);

    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 1,
      failed: 0,
      rerouted: 0,
    });
    expect((await itemRow(id)).appliedAt).toEqual(NOW);
  });

  it('weights votes by rank and smites', async () => {
    await player(1, 'Knight');
    await player(2, 'Templar');
    await player(3, 'Knight');
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (3),(3)`);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId","cleansedAt") VALUES (3, now())`);
    await image(10);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');
    const weights = (
      await pg.query<{ weight: number }>(`SELECT weight FROM "KnightsVote" ORDER BY "playerId"`)
    ).rows.map((r) => r.weight);
    expect(weights).toEqual([0.68, 1.18, 0.35]);
  });
});

describe('writing a settled rating back', () => {
  async function settledItem(imageId = 10, level = 4) {
    await fiveKnights();
    await image(imageId, level);
    const id = await item(imageId);
    applyConsensus.mockRejectedValueOnce(new Error('main app down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '4');
    return id;
  }
  const pendingRun = (minutes: number) =>
    applyPendingResolutions(db, depsAt(afterMinutes(minutes)));

  it('records the level the image had when the players settled', async () => {
    const id = await settledItem(10, 8);
    expect(await itemRow(id)).toMatchObject({ resolvedFromLevel: 8, applyAttempts: 1 });
  });

  it('backs off after a failure and does not retry before the wait is over', async () => {
    const id = await settledItem();
    expect((await itemRow(id)).nextAttemptAt).toEqual(afterMinutes(5));

    applyConsensus.mockClear();
    expect(await pendingRun(4)).toEqual({ applied: 0, failed: 0, rerouted: 0 });
    expect(applyConsensus).not.toHaveBeenCalled();

    applyConsensus.mockRejectedValueOnce(new Error('still down'));
    expect(await pendingRun(5)).toEqual({ applied: 0, failed: 1, rerouted: 0 });
    expect((await itemRow(id)).nextAttemptAt).toEqual(afterMinutes(15));
    expect((await itemRow(id)).applyAttempts).toBe(2);
  });

  it('hands the item to the Inquisitors once the attempts run out', async () => {
    const id = await settledItem();
    applyConsensus.mockRejectedValue(new Error('main app down'));
    let minutes = 0;
    for (let attempt = 2; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
      minutes += 24 * 60;
      expect(await pendingRun(minutes)).toMatchObject({ failed: 1 });
    }
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved' });

    minutes += 24 * 60;
    const before = await counterValue('knights_escalations_total', {
      reason: 'attempts-exhausted',
    });
    expect(await pendingRun(minutes)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
    expect(await counterValue('knights_escalations_total', { reason: 'attempts-exhausted' })).toBe(
      before + 1
    );
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      reason: 'attempts-exhausted',
      escalationReason: null,
      resolvedValue: null,
      appliedAt: null,
    });
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
    applyConsensus.mockResolvedValue(APPLIED);
    expect(await pendingRun(minutes + 24 * 60)).toEqual({ applied: 0, failed: 0, rerouted: 0 });
  });

  it('does not let stuck rows starve newer ones', async () => {
    const stuck = await settledItem(10);
    applyConsensus.mockRejectedValue(new Error('main app down'));
    await pendingRun(5);
    expect((await itemRow(stuck)).applyAttempts).toBe(2);

    await fiveKnights(11);
    const fresh: number[] = [];
    for (const imageId of [20, 21]) {
      await image(imageId);
      const id = await item(imageId);
      for (const u of [11, 12, 13, 14, 15]) await vote(u, id, '4');
      fresh.push(id);
    }

    applyConsensus.mockReset();
    applyConsensus.mockResolvedValue(APPLIED);
    expect(await applyPendingResolutions(db, depsAt(afterMinutes(16)), { limit: 2 })).toEqual({
      applied: 2,
      failed: 0,
      rerouted: 0,
    });
    for (const id of fresh) expect((await itemRow(id)).appliedAt).not.toBeNull();
    expect((await itemRow(stuck)).appliedAt).toBeNull();
  });

  it('stops starting tries once its time budget is spent', async () => {
    const id = await settledItem();
    applyConsensus.mockClear();
    expect(await applyPendingResolutions(db, depsAt(afterMinutes(10)), { budgetMs: 0 })).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await itemRow(id)).applyAttempts).toBe(1);
  });

  it('lets only one run claim an item at a time', async () => {
    const id = await settledItem();
    let release: () => void = () => undefined;
    applyConsensus.mockReset();
    applyConsensus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(APPLIED);
        })
    );
    const first = pendingRun(10);
    await vi.waitFor(() => expect(applyConsensus).toHaveBeenCalledTimes(1));
    expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 0 });
    release();
    expect(await first).toEqual({ applied: 1, failed: 0, rerouted: 0 });
    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect((await itemRow(id)).appliedAt).not.toBeNull();
  });

  describe('when the image is no longer the one the players judged', () => {
    it('sends a blocked image to the Inquisitors without calling the main app', async () => {
      const id = await settledItem();
      await pg.query(`UPDATE "Image" SET "blockedFor"='tos' WHERE id=10`);
      applyConsensus.mockClear();

      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(applyConsensus).not.toHaveBeenCalled();
      expect(await itemRow(id)).toMatchObject({
        status: 'Inquisitor',
        reason: 'blocked',
        resolvedValue: null,
      });
      expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
      expect(await pendingRun(600)).toEqual({ applied: 0, failed: 0, rerouted: 0 });
    });

    it('closes against a moderator ruling and grades the votes by it', async () => {
      const id = await settledItem();
      await lockImage(pg, 10, { reason: 'Moderator review', level: 8 });
      applyConsensus.mockClear();

      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(applyConsensus).not.toHaveBeenCalled();
      expect(await itemRow(id)).toMatchObject({ status: 'Closed', reason: 'moderator-ruled' });
      expect((await verdicts(id)).every((v) => v.verdict === 'failed')).toBe(true);
    });

    it('settles on the moderator level, so a voter graded wrong sees that level as the verdict', async () => {
      await fiveKnights();
      await image(10, 2);
      const id = await item(10);
      applyConsensus.mockRejectedValueOnce(new Error('main app down'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const [u, answer] of [
        [1, '2'],
        [2, '2'],
        [3, '2'],
        [4, '1'],
        [5, '2'],
      ] as const) {
        await vote(u, id, answer);
      }
      expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '2' });
      await lockImage(pg, 10, { reason: 'Moderator review', level: 1 });

      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(await itemRow(id)).toMatchObject({
        status: 'Closed',
        reason: 'moderator-ruled',
        resolvedValue: '1',
      });
      expect((await verdicts(id)).map((v) => v.verdict)).toEqual([
        'failed',
        'failed',
        'failed',
        'correct',
        'failed',
      ]);
      const [wrong] = (await listJudgments(db, 1, { page: 1 })).judgments;
      expect(wrong).toMatchObject({ answerLabel: 'PG-13', status: 'wrong', verdictLabel: 'PG' });
      const [right] = (await listJudgments(db, 4, { page: 1 })).judgments;
      expect(right).toMatchObject({ answerLabel: 'PG', status: 'correct' });
    });

    it('grades the votes that match the moderator as correct', async () => {
      const id = await settledItem();
      await lockImage(pg, 10, { reason: 'Moderator review', level: 4 });
      await pendingRun(10);
      expect((await verdicts(id)).every((v) => v.verdict === 'correct')).toBe(true);
    });

    it('does not call the main app for an image another level now', async () => {
      const id = await settledItem(10, 4);
      await pg.query(`UPDATE "Image" SET "nsfwLevel"=16 WHERE id=10`);
      applyConsensus.mockClear();

      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(applyConsensus).not.toHaveBeenCalled();
      expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', reason: 'level-moved' });
    });

    it('counts an image already at the settled level and Knights-locked as written, without calling the main app', async () => {
      const id = await settledItem();
      await lockImage(pg, 10, { reason: 'Knights Vote', level: 4 });
      applyConsensus.mockClear();
      expect(await pendingRun(10)).toEqual({ applied: 1, failed: 0, rerouted: 0 });
      expect(applyConsensus).not.toHaveBeenCalled();
      expect((await itemRow(id)).appliedAt).not.toBeNull();
    });

    it('treats a retry after a write that landed but timed out as applied, not as a moved level', async () => {
      await fiveKnights();
      await image(10, 8);
      const id = await item(10);
      applyConsensus.mockImplementationOnce(async () => {
        await lockImage(pg, 10, { reason: 'Knights Vote', level: 4 });
        throw new Error('timed out after the main app wrote');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const u of [1, 2, 3, 4]) await vote(u, id, '4');
      expect(await itemRow(id)).toMatchObject({ status: 'Resolved', appliedAt: null });

      applyConsensus.mockClear();
      expect(await pendingRun(6)).toEqual({ applied: 1, failed: 0, rerouted: 0 });
      expect(applyConsensus).not.toHaveBeenCalled();
      expect(await itemRow(id)).toMatchObject({ status: 'Resolved', appliedAt: afterMinutes(6) });
      expect((await verdicts(id)).every((v) => v.verdict === 'correct')).toBe(true);
    });

    it('hands a moderator-locked image with no usable level to the Inquisitors as moderator-locked', async () => {
      const id = await settledItem();
      await lockImage(pg, 10, { reason: 'Moderator review', level: 0 });
      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', reason: 'moderator-locked' });
    });

    it('does the same when the main app reports a lock without a level', async () => {
      const id = await settledItem();
      applyConsensus.mockResolvedValue({
        outcome: 'skipped',
        reason: 'locked',
        currentLevel: null,
      });
      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', reason: 'moderator-locked' });
    });

    it('closes an item whose image is gone, with the votes inconclusive', async () => {
      const id = await settledItem();
      await pg.query(`DELETE FROM "Image" WHERE id=10`);
      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(await itemRow(id)).toMatchObject({ status: 'Closed', reason: 'missing' });
      expect((await verdicts(id)).every((v) => v.verdict === 'inconclusive')).toBe(true);
    });

    it.each([
      ['blocked', { kind: 'Inquisitor', reason: 'blocked' }],
      ['missing', { kind: 'Closed', reason: 'missing' }],
      ['locked', { kind: 'Closed', reason: 'moderator-ruled' }],
    ] as const)('treats the main app refusing as %s as final', async (reason, expected) => {
      const id = await settledItem();
      applyConsensus.mockResolvedValue({ outcome: 'skipped', reason, currentLevel: 8 });

      expect(await pendingRun(10)).toEqual({ applied: 0, failed: 0, rerouted: 1 });
      expect(await itemRow(id)).toMatchObject({ status: expected.kind, reason: expected.reason });
      expect(await pendingRun(600)).toEqual({ applied: 0, failed: 0, rerouted: 0 });
      expect(applyConsensus).toHaveBeenCalledTimes(2);
    });

    it('takes a refusal on the first try off the retry path at once', async () => {
      await fiveKnights();
      await image(10, 4);
      const id = await item(10);
      applyConsensus.mockResolvedValue({ outcome: 'skipped', reason: 'locked', currentLevel: 8 });
      for (const u of [1, 2, 3, 4]) await vote(u, id, '4');

      expect(await itemRow(id)).toMatchObject({ status: 'Closed', reason: 'moderator-ruled' });
      expect((await verdicts(id)).every((v) => v.verdict === 'failed')).toBe(true);
    });
  });
});

describe('what the feed serves', () => {
  it.each([
    [
      'an unscanned image (level 0)',
      () => pg.query(`UPDATE "Image" SET "nsfwLevel"=0 WHERE id=10`),
    ],
    ['a Blocked level', () => pg.query(`UPDATE "Image" SET "nsfwLevel"=32 WHERE id=10`)],
    ['a block reason', () => pg.query(`UPDATE "Image" SET "blockedFor"='tos' WHERE id=10`)],
    ['Blocked ingestion', () => pg.query(`UPDATE "Image" SET "ingestion"='Blocked' WHERE id=10`)],
    ['an unpublished post', () => pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id=10`)],
    [
      'a post scheduled for later',
      () => pg.query(`UPDATE "Post" SET "publishedAt"='2099-01-01' WHERE id=10`),
    ],
    ['an image with no post', () => pg.query(`UPDATE "Image" SET "postId"=NULL WHERE id=10`)],
    ['a Private post', () => pg.query(`UPDATE "Post" SET availability='Private' WHERE id=10`)],
    [
      'an image held for review',
      () => pg.query(`UPDATE "Image" SET "needsReview"='minor' WHERE id=10`),
    ],
    [
      'an acceptable-minor image',
      () => pg.query(`UPDATE "Image" SET "acceptableMinor"=true WHERE id=10`),
    ],
    // These go to the moderators' own queues.
    [
      'an image flagged as a real person',
      () => pg.query(`UPDATE "Image" SET "poi"=true WHERE id=10`),
    ],
    ['an image flagged as a minor', () => pg.query(`UPDATE "Image" SET "minor"=true WHERE id=10`)],
  ])('hides %s and refuses a vote on it', async (_label, hide) => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10);
    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([id]);

    await hide();
    expect(await getFeed(db, 1)).toBeNull();
    expect(await vote(1, id, '4')).toMatchObject({ status: 'rejected', reason: 'unavailable' });
    expect(await verdicts(id)).toEqual([]);
  });
});

describe('vote weight', () => {
  it('lowers a vote by each active smite, and still counts the vote below the reset limit', async () => {
    await player(1, 'Knight');
    await player(2, 'Knight');
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (2),(2)`);
    await image(10);
    const id = await item(10);

    expect(await vote(1, id, '4')).toMatchObject({ status: 'recorded' });
    expect(await vote(2, id, '4')).toMatchObject({ status: 'recorded' });

    const weights = (
      await pg.query<{ playerId: number; weight: number }>(
        `SELECT "playerId", weight FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
        [id]
      )
    ).rows;
    expect(weights[1].weight).toBeGreaterThan(0);
    expect(weights[1].weight).toBeLessThan(weights[0].weight);
  });

  it('refuses a vote from a player whose smites call for a career reset, however many they have', async () => {
    await player(1, 'Knight');
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId") SELECT 1 FROM generate_series(1,6)`
    );
    await image(10);
    const id = await item(10);

    expect(await vote(1, id, '4')).toMatchObject({ status: 'rejected', reason: 'reset-pending' });
    expect(await verdicts(id)).toEqual([]);
  });
});

describe('enqueueItem ranks', () => {
  it.each(['Acolyte', 'Inquisitor', 'Archon', ''])(
    'refuses an item waiting at %j',
    async (rank) => {
      await image(10);
      await expect(
        enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test', minRank: rank }, NOW)
      ).rejects.toThrow(/rank/);
    }
  );

  it.each(['Knight', 'Templar', 'Paladin'])('accepts %s', async (rank) => {
    await image(10);
    await expect(
      enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test', minRank: rank }, NOW)
    ).resolves.toEqual(expect.any(Number));
  });

  it('refuses a question whose own rank is not one an item can wait at', async () => {
    await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","minRank")
      VALUES ('knights.test.bad','bool','Hat?','[{"value":"yes","label":"Yes"}]','Acolyte')`);
    await image(10);
    await expect(
      enqueueItem(db, { questionKey: 'knights.test.bad', imageId: 10, source: 'test' }, NOW)
    ).rejects.toThrow(/rank/);
  });
});

describe('escalateExpired', () => {
  it('moves expired open items up one rank and never deletes them', async () => {
    await image(10);
    await image(11);
    await image(12);
    const stale = await item(10, { expires: new Date('2026-12-15T11:00:00Z') });
    const stalePaladin = await item(11, {
      minRank: 'Paladin',
      expires: new Date('2026-12-15T11:00:00Z'),
    });
    const fresh = await item(12, { expires: new Date('2026-12-16T11:00:00Z') });
    await player(1, 'Knight');
    await player(2, 'Templar');
    await player(3, 'Paladin');
    await vote(1, stale, '4');
    await vote(3, stalePaladin, '4');

    const res = await escalateExpired(db, { now: NOW });
    expect(res).toEqual({ escalated: 1, toInquisitor: 0, extended: 0, expired: 1, rerated: 0 });
    expect(await itemRow(stale)).toMatchObject({ status: 'Open', minRank: 'Templar' });
    // One vote is below the Paladin quorum, so the end of the path closes it instead of re-rating.
    expect(await itemRow(stalePaladin)).toMatchObject({
      status: 'Closed',
      minRank: 'Paladin',
      reason: 'expired',
    });
    expect((await itemRow(stale)).escalationReason).toBeNull();
    expect(await itemRow(fresh)).toMatchObject({ status: 'Open', minRank: 'Knight' });
    expect(
      (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "KnightsQueueItem"`)).rows[0].n
    ).toBe(3);
  });

  const PAST = new Date('2026-12-15T11:00:00Z');
  const hoursAfter = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const imageLevel = async (id: number) =>
    (await pg.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Image" WHERE id=$1`, [id]))
      .rows[0].nsfwLevel;
  const voteRow = async (itemId: number, playerId: number) =>
    (
      await pg.query<{ verdict: string; gold: number; settledAt: Date | null }>(
        `SELECT verdict, gold, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId"=$2`,
        [itemId, playerId]
      )
    ).rows[0];
  const goldEarned = async (userId: number) =>
    (
      await pg.query<{ goldEarned: number }>(
        `SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
        [userId]
      )
    ).rows[0].goldEarned;
  /** A vote that counts for nothing at the item's stage: a held player's (weight 0), or one cast at an earlier stage. */
  async function uncountedVote(itemId: number, playerId: number, stage: string, weight: number) {
    await player(playerId, 'Knight');
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","gold")
       VALUES ($1,$2,$3,$4,10,$5,'4',$6,5)`,
      [itemId, playerId, NOW, Q, stage, weight]
    );
  }

  it('closes a zero-vote item as expired after its one extension, with no label, write-back or payout', async () => {
    await active(2, 'Knight');
    await image(10, 8);
    const id = await item(10, { expires: hoursAfter(72) });
    await uncountedVote(id, 3, 'Knight', 0);
    const before = await counterValue('knights_escalations_total', { reason: 'expired' });

    expect(await escalateExpired(db, { now: hoursAfter(72) })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 1,
      expired: 0,
      rerated: 0,
    });
    expect(await escalateExpired(db, { now: hoursAfter(144) })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });

    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'expired',
      minRank: 'Knight',
      escalationReason: null,
      resolvedValue: null,
    });
    expect(await counterValue('knights_escalations_total', { reason: 'expired' })).toBe(before + 1);
    // The escalation only grades the leftover vote; the tick's settle step pays it (nothing), one item at a time.
    expect(await voteRow(id, 3)).toMatchObject({ verdict: 'inconclusive', settledAt: null });
    expect(await settleFinalItems(db, { now: hoursAfter(144) })).toMatchObject({
      items: 1,
      votes: 1,
      failed: 0,
    });
    expect(await voteRow(id, 3)).toMatchObject({ verdict: 'inconclusive', gold: 0 });
    expect((await voteRow(id, 3)).settledAt).not.toBeNull();
    expect(await goldEarned(3)).toBe(0);
    expect(await applyPendingResolutions(db, depsAt(hoursAfter(144)))).toMatchObject({
      applied: 0,
    });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await imageLevel(10)).toBe(8);
  });

  it('expires a zero-vote item at a higher stage even when an earlier stage voted on it', async () => {
    await active(2, 'Templar');
    await image(10);
    const id = await item(10, { minRank: 'Templar', expires: hoursAfter(72) });
    await uncountedVote(id, 1, 'Knight', 1);

    expect(await escalateExpired(db, { now: hoursAfter(72) })).toMatchObject({
      extended: 1,
      expired: 0,
      rerated: 0,
    });
    expect(await escalateExpired(db, { now: hoursAfter(144) })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'expired',
      minRank: 'Templar',
    });
    expect(await voteRow(id, 1)).toMatchObject({ verdict: 'inconclusive', settledAt: null });
  });

  it('expires a zero-vote item in the same tick that escalates a voted one', async () => {
    await active(1, 'Knight');
    await active(2, 'Templar');
    await image(10);
    await image(11);
    const voted = await item(10, { expires: PAST });
    const idle = await item(11, { expires: PAST });
    await vote(1, voted, '4');
    await pg.query(`UPDATE "KnightsQueueItem" SET "createdAt" = $1 WHERE id = $2`, [
      hoursAfter(-150),
      idle,
    ]);

    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 1,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(voted)).toMatchObject({ status: 'Open', minRank: 'Templar' });
    expect(await itemRow(idle)).toMatchObject({ status: 'Closed', reason: 'expired' });
  });
});

describe('an expired item on a Private post', () => {
  const PAST = new Date('2026-12-15T11:00:00Z');
  const makePrivate = () => pg.query(`UPDATE "Post" SET availability='Private' WHERE id=10`);
  async function knightItem(answer: string) {
    await fiveKnights();
    await active(20, 'Templar');
    await image(10, 4);
    const id = await item(10, { expires: PAST });
    await vote(1, id, answer);
    await makePrivate();
    return id;
  }

  it('goes to the Inquisitors as blocked from a stage below the last, never to the next player stage', async () => {
    const id = await knightItem('32');
    expect((await escalateExpired(db, { now: NOW })).toInquisitor).toBe(1);
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      escalationReason: 'blocked',
    });
  });

  it('escalates the same Blocked votes on a Public post from a stage below the last, as before', async () => {
    await fiveKnights();
    await active(20, 'Templar');
    await image(10, 4);
    const id = await item(10, { expires: PAST });
    await vote(1, id, '32');
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({
      escalated: 1,
      toInquisitor: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });

  it('runs as any other item when the pick is not Blocked', async () => {
    const id = await knightItem('4');
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({
      escalated: 1,
      toInquisitor: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });

  // A month partition before the Knight votes, so a scan without ORDER BY returns the later stage first.
  const EARLIER_MONTH = new Date('2026-11-20T12:00:00Z');
  async function escalatedItem(
    stage: string,
    votes: [stage: string, answer: string, weight: number, castAt?: Date][]
  ) {
    await ensureVotePartitions(db, { now: EARLIER_MONTH, monthsAhead: 0 });
    await active(20, 'Templar');
    await active(30, 'Paladin');
    await image(10, 4);
    const id = await item(10, { expires: PAST });
    await pg.query(`UPDATE "KnightsQueueItem" SET "minRank"=$2, "escalatedAt"=$3 WHERE id=$1`, [
      id,
      stage,
      new Date(PAST.getTime() - 3_600_000),
    ]);
    for (const [i, [at, answer, weight, castAt]] of votes.entries()) {
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
         VALUES ($1,$2,$3,$4,10,$5,$6,$7)`,
        [id, 100 + i, castAt ?? PAST, Q, at, answer, weight]
      );
    }
    return id;
  }

  it('takes the Blocked plurality of the stage before when the current stage has no counted vote, and reports the move', async () => {
    const id = await escalatedItem('Templar', [['Knight', '32', 1]]);
    await makePrivate();
    const moved = vi.fn();
    expect(await escalateExpired(db, { now: NOW, moved })).toMatchObject({
      toInquisitor: 1,
      extended: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', escalationReason: 'blocked' });
    expect(moved).toHaveBeenCalledWith([{ id, status: 'Open', minRank: 'Templar' }]);
  });

  it('takes only the latest voted stage, over an earlier stage with another pick', async () => {
    const id = await escalatedItem('Paladin', [
      ['Templar', '32', 1, EARLIER_MONTH],
      ['Knight', '4', 1],
      ['Knight', '4', 1],
    ]);
    await makePrivate();
    expect((await escalateExpired(db, { now: NOW })).toInquisitor).toBe(1);
    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', escalationReason: 'blocked' });
  });

  it('does not route when a later stage picked a level over an earlier Blocked pick', async () => {
    const id = await escalatedItem('Paladin', [
      ['Templar', '4', 1, EARLIER_MONTH],
      ['Knight', '32', 1],
    ]);
    await makePrivate();
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ toInquisitor: 0, extended: 1 });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Paladin' });
  });

  it('does not route on earlier votes that carry no weight', async () => {
    const id = await escalatedItem('Templar', [['Knight', '32', 0]]);
    await makePrivate();
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ toInquisitor: 0, extended: 1 });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });

  it('skips a later stage whose votes carry no weight', async () => {
    const id = await escalatedItem('Paladin', [
      ['Knight', '32', 1],
      ['Templar', '4', 0],
    ]);
    await makePrivate();
    expect((await escalateExpired(db, { now: NOW })).toInquisitor).toBe(1);
    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', escalationReason: 'blocked' });
  });

  it('extends the same history on a Public post, as before', async () => {
    const id = await escalatedItem('Templar', [['Knight', '32', 1]]);
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ toInquisitor: 0, extended: 1 });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });
});

describe('escalation with empty ranks', () => {
  const PAST = new Date('2026-12-15T11:00:00Z');
  const TTL_END = new Date('2026-12-18T12:00:00Z');
  const hoursAfter = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

  /** A Knight item that one player has voted on, then lapsed. */
  async function votedAndLapsed() {
    await image(10);
    const id = await item(10, { expires: PAST });
    await active(1, 'Knight');
    expect((await vote(1, id, '4')).status).toBe('recorded');
    return id;
  }

  it('closes a voted item below the Knight quorum as expired when no Templar or Paladin plays', async () => {
    const id = await votedAndLapsed();
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      minRank: 'Knight',
      reason: 'expired',
      escalationReason: null,
    });
  });

  it('hands a voted item to the Templar stage when only Paladins play, as they can serve it', async () => {
    const id = await votedAndLapsed();
    await active(2, 'Paladin');
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 1,
      toInquisitor: 0,
      extended: 0,
      expired: 0,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar', votesNeeded: 3 });
  });

  it('goes to the Templars when only Templars play', async () => {
    const id = await votedAndLapsed();
    await active(2, 'Templar');
    await escalateExpired(db, { now: NOW });
    expect(await itemRow(id)).toMatchObject({ minRank: 'Templar', votesNeeded: 3 });
  });

  it('does not count a Paladin who is waiting on a career reset', async () => {
    const id = await votedAndLapsed();
    await active(2, 'Paladin');
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId") SELECT 2 FROM generate_series(1, 3)`
    );
    await escalateExpired(db, { now: NOW });
    expect(await itemRow(id)).toMatchObject({ status: 'Closed', minRank: 'Knight' });
  });

  it('does not count a Paladin who has not voted in the last 14 days', async () => {
    const id = await votedAndLapsed();
    await active(2, 'Paladin', 15);
    await escalateExpired(db, { now: NOW });
    expect(await itemRow(id)).toMatchObject({ status: 'Closed', minRank: 'Knight' });
  });

  it('counts a Paladin who voted 13 days ago', async () => {
    const id = await votedAndLapsed();
    await active(2, 'Paladin', 13);
    await escalateExpired(db, { now: NOW });
    expect(await itemRow(id)).toMatchObject({ minRank: 'Templar' });
  });

  it('re-rates a split item instead of asking the Inquisitors when no Templar or Paladin plays', async () => {
    // Earlier tests leave their own outcome on the shared mock.
    applyConsensus.mockImplementation(async () => APPLIED);
    for (let i = 1; i <= 10; i++) await player(i, 'Knight');
    await image(10);
    const id = await item(10);
    for (let i = 1; i <= 10; i++) await vote(i, id, i % 2 ? '4' : '8');
    expect(await itemRow(id)).toMatchObject({
      status: 'Resolved',
      minRank: 'Knight',
      resolvedValue: '8',
      reason: 'no-consensus-rerate',
    });
  });

  it('sends a split item to the Templar stage when a Paladin plays', async () => {
    for (let i = 1; i <= 10; i++) await player(i, 'Knight');
    await active(20, 'Paladin');
    await image(10);
    const id = await item(10);
    for (let i = 1; i <= 10; i++) await vote(i, id, i % 2 ? '4' : '8');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });

  it('extends an item nobody voted on instead of escalating it', async () => {
    await active(2, 'Templar');
    await image(10);
    const id = await item(10, { expires: PAST });
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 1,
      expired: 0,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Open',
      minRank: 'Knight',
      escalationReason: null,
      escalatedAt: null,
      expiresAt: TTL_END,
    });
    await player(1, 'Knight');
    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([id]);
  });

  it('extends a zero-vote item at a higher stage even if earlier stages had votes', async () => {
    await image(10);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    await active(2, 'Templar');
    await player(1, 'Knight');
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES ($1,1,$2,$3,10,'Knight','4',1)`,
      [id, NOW, Q]
    );
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ extended: 1, toInquisitor: 0 });
    expect(await itemRow(id)).toMatchObject({ minRank: 'Templar', expiresAt: TTL_END });
  });

  it('expires a zero-vote item whose stage nobody can serve instead of handing it to the Inquisitors', async () => {
    await active(1, 'Knight');
    await image(10);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'expired',
      minRank: 'Templar',
    });
  });

  it('extends a zero-vote item once, then expires it when the only server already voted', async () => {
    await image(10);
    const id = await item(10, { expires: PAST });
    await active(2, 'Paladin');
    expect((await vote(2, id, '4')).status).toBe('recorded');

    // The Paladin's vote moves it to the Templar stage, where only that Paladin could serve it.
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ escalated: 1 });
    expect(await itemRow(id)).toMatchObject({ minRank: 'Templar' });
    expect((await vote(2, id, '4')).status).toBe('rejected');

    expect(await escalateExpired(db, { now: hoursAfter(72) })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 1,
      expired: 0,
      rerated: 0,
    });
    // A second lapse at the same stage with no vote there closes it: its Knight-stage vote does not count.
    expect(await escalateExpired(db, { now: hoursAfter(144) })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'expired',
      minRank: 'Templar',
    });
  });
});

describe('closeModeratorRuledItems', () => {
  const exp = async (userId: number) =>
    (
      await pg.query<{ exp: number }>(`SELECT exp FROM "NewOrderPlayer" WHERE "userId"=$1`, [
        userId,
      ])
    ).rows[0].exp;
  const settled = async (id: number) =>
    (
      await pg.query<{ settledAt: Date | null }>(
        `SELECT "settledAt" FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
        [id]
      )
    ).rows.map((v) => v.settledAt !== null);
  const sweep = () => closeModeratorRuledItems(db, { now: NOW });

  it('closes an open item on a moderator-locked image against the moderator level, and pays its votes', async () => {
    await fiveKnights();
    await image(10, 2);
    const id = await item(10);
    await vote(1, id, '4');
    await vote(2, id, '8');
    await lockImage(pg, 10, { reason: 'Moderator review', level: 4 });
    const before = { right: await exp(1), wrong: await exp(2) };
    const moved = vi.fn();

    expect(await closeModeratorRuledItems(db, { now: NOW, moved })).toEqual({
      closed: 1,
      failed: 0,
    });
    expect(moved).toHaveBeenCalledWith([{ id, status: 'Open', minRank: 'Knight' }]);
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-ruled',
      resolvedValue: '4',
    });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['correct', 'failed']);
    expect(await settled(id)).toEqual([true, true]);
    expect(await exp(1)).toBe(before.right + PROGRESSION.correctXp);
    expect(await exp(2)).toBe(before.wrong);
    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 0 });
    expect(await vote(3, id, '4')).toEqual({ status: 'rejected', reason: 'not-open' });
    expect(await sweep()).toEqual({ closed: 0, failed: 0 });
  });

  it('leaves settled items, Knights-locked images, and locks with no level or a block alone', async () => {
    await fiveKnights();
    for (const imageId of [11, 12, 13, 14, 15, 16]) await image(imageId, 2);
    const closed = await item(11);
    await vote(1, closed, '2');
    await closeWithoutOutcome(db, closed, NOW);
    const resolved = await item(12);
    applyConsensus.mockResolvedValue(APPLIED);
    for (const u of [1, 2, 3, 4]) await vote(u, resolved, '2');
    const knightsLocked = await item(13);
    const noLevel = await item(14);
    const blocked = await item(15);
    const otherQuestion = await item(16, { question: 'knights.test.bool' });
    await lockImage(pg, 11, { reason: 'Moderator review', level: 4 });
    await lockImage(pg, 12, { reason: 'Moderator review', level: 8 });
    await lockImage(pg, 13, { reason: 'Knights Vote', level: 4 });
    await lockImage(pg, 14, { reason: 'Moderator review', level: 0 });
    await lockImage(pg, 15, { reason: 'Moderator review', level: 4 });
    await pg.query(`UPDATE "Image" SET "blockedFor"='tos' WHERE id=15`);
    await lockImage(pg, 16, { reason: 'Moderator review', level: 4 });
    const ids = [closed, resolved, knightsLocked, noLevel, blocked, otherQuestion];
    const snapshot = async () =>
      Promise.all(ids.map(async (id) => ({ item: await itemRow(id), votes: await verdicts(id) })));
    const before = await snapshot();
    expect(before.map((s) => s.item.status)).toEqual([
      'Closed',
      'Resolved',
      'Open',
      'Open',
      'Open',
      'Open',
    ]);

    expect(await sweep()).toEqual({ closed: 0, failed: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('closes an item waiting on the Inquisitors when a moderator rules on its image elsewhere, and pays its votes', async () => {
    await fiveKnights();
    await image(10, 16);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '1');
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      escalationReason: 'pushed-down',
    });
    await lockImage(pg, 10, { reason: 'Moderator review', level: 1 });
    const before = await exp(1);
    const moved = vi.fn();

    // Players were never served it, so the live queue must not be told an Open item left.
    expect(await closeModeratorRuledItems(db, { now: NOW, moved })).toEqual({
      closed: 1,
      failed: 0,
    });
    expect(moved).toHaveBeenCalledWith([{ id, status: 'Inquisitor', minRank: 'Inquisitor' }]);
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-ruled',
      resolvedValue: '1',
    });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual([
      'correct',
      'correct',
      'correct',
      'correct',
    ]);
    expect(await settled(id)).toEqual([true, true, true, true]);
    expect(await exp(1)).toBe(before + PROGRESSION.correctXp);
    expect(await sweep()).toEqual({ closed: 0, failed: 0 });
  });

  it('leaves a Blocked consensus waiting on the Inquisitors even when the image carries a moderator lock', async () => {
    await fiveKnights();
    await image(10, 2);
    await lockImage(pg, 10, { reason: 'Moderator review', level: 2 });
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '32');
    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor', escalationReason: 'blocked' });
    const before = { item: await itemRow(id), votes: await verdicts(id) };

    expect(await sweep()).toEqual({ closed: 0, failed: 0 });
    expect({ item: await itemRow(id), votes: await verdicts(id) }).toEqual(before);
  });

  it('leaves an Inquisitor item alone while a moderator is ruling on it', async () => {
    await fiveKnights();
    await image(10, 16);
    const id = await item(10);
    for (const u of [1, 2, 3, 4]) await vote(u, id, '1');
    await pg.query(`UPDATE "KnightsQueueItem" SET status='Ruling', "resolvedBy"=7 WHERE id=$1`, [
      id,
    ]);
    await lockImage(pg, 10, { reason: 'Moderator review', level: 1 });
    const before = { item: await itemRow(id), votes: await verdicts(id) };

    expect(await sweep()).toEqual({ closed: 0, failed: 0 });
    expect({ item: await itemRow(id), votes: await verdicts(id) }).toEqual(before);
  });
});

describe('closeUnservableItems', () => {
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const sweep = (limit?: number) => closeUnservableItems(db, { now: NOW, limit });
  /** A scan sample (or `source`) queued at `createdAt` with its current window ending at `expiresAt`, on image `id` (post `id`, publishing at `publishedAt`). */
  async function queued(
    id: number,
    {
      publishedAt = at(-1000),
      createdAt = NOW,
      expiresAt = at(72) as Date | null,
      source = 'scan-sample',
    }: {
      publishedAt?: Date | null;
      createdAt?: Date;
      expiresAt?: Date | null;
      source?: string;
    } = {}
  ) {
    await image(id, 4, publishedAt === null ? null : publishedAt.toISOString());
    const itemId = await item(id, { expires: expiresAt ?? undefined });
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "createdAt"=$1, "expiresAt"=$2, source=$3 WHERE id=$4`,
      [createdAt, expiresAt, source, itemId]
    );
    return itemId;
  }
  async function countedVote(itemId: number, playerId: number, imageId: number) {
    await player(playerId, 'Knight');
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","gold")
       VALUES ($1,$2,$3,$4,$5,'Knight','8',1,5)`,
      [itemId, playerId, NOW, Q, imageId]
    );
  }
  const statusOf = async (ids: number[]) =>
    Promise.all(ids.map(async (id) => [(await itemRow(id)).status, (await itemRow(id)).reason]));

  it('closes items on a deleted image or post, and on a post publishing after the item would expire, with no outcome', async () => {
    await active(1, 'Knight');
    const servable = await queued(10);
    const imageGone = await queued(11);
    await pg.query(`DELETE FROM "Image" WHERE id=11`);
    const postGone = await queued(12);
    await pg.query(`UPDATE "Image" SET "postId"=NULL WHERE id=12`);
    const draft = await queued(13, { publishedAt: null });
    // Default window: the item can be open until 144h after it was queued.
    const publishesInTime = await queued(14, { publishedAt: at(100) });
    const publishesTooLate = await queued(15, { publishedAt: at(150) });
    // Already extended: the current window is the last one, so it closes at `expiresAt` (here 144.5h after queueing).
    const extended = { createdAt: at(-80), expiresAt: at(64.5) };
    const extendedInTime = await queued(16, { ...extended, publishedAt: at(64.25) });
    const extendedTooLate = await queued(17, { ...extended, publishedAt: at(64.75) });
    // A custom short first window can be extended twice: open until at most 216h after queueing.
    const shortWindow = await queued(18, { expiresAt: at(10), publishedAt: at(150) });
    // A vote on a gone image is left over: it becomes inconclusive and settles unpaid.
    await countedVote(imageGone, 3, 11);
    const before = {
      unservable: await counterValue('knights_escalations_total', { reason: 'unservable' }),
      late: await counterValue('knights_escalations_total', {
        reason: 'publishes-after-expiry',
      }),
    };

    expect(await sweep()).toEqual({
      unservable: 2,
      publishesAfterExpiry: 2,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });

    expect(
      await statusOf([
        servable,
        imageGone,
        postGone,
        draft,
        publishesInTime,
        publishesTooLate,
        extendedInTime,
        extendedTooLate,
        shortWindow,
      ])
    ).toEqual([
      ['Open', null],
      ['Closed', 'unservable'],
      ['Closed', 'unservable'],
      ['Open', null],
      ['Open', null],
      ['Closed', 'publishes-after-expiry'],
      ['Open', null],
      ['Closed', 'publishes-after-expiry'],
      ['Open', null],
    ]);
    expect(await itemRow(postGone)).toMatchObject({ resolvedValue: null, escalationReason: null });
    expect(await counterValue('knights_escalations_total', { reason: 'unservable' })).toBe(
      before.unservable + 2
    );
    expect(
      await counterValue('knights_escalations_total', { reason: 'publishes-after-expiry' })
    ).toBe(before.late + 2);
    expect(await verdicts(imageGone)).toEqual([
      { playerId: 3, verdict: 'inconclusive', stage: 'Knight' },
    ]);
    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 1, failed: 0 });
    expect(
      (await pg.query(`SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=3`)).rows[0]
    ).toEqual({ goldEarned: 0 });
    expect(await applyPendingResolutions(db, deps())).toMatchObject({ applied: 0 });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await sweep()).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
  });

  it('leaves hidden checks, yes/no items, voted, escalated and never-expiring items alone, but closes any stage on a gone image', async () => {
    await active(1, 'Knight');
    await image(20);
    const hidden = await item(20, { hidden: true });
    await image(21);
    const yesNo = await item(21, { question: 'knights.test.bool' });
    await pg.query(`UPDATE "KnightsQueueItem" SET audience='players' WHERE id=$1`, [yesNo]);
    await pg.query(`DELETE FROM "Image" WHERE id IN (20, 21)`);
    const voted = await queued(22, { publishedAt: at(150) });
    await countedVote(voted, 3, 22);
    const escalated = await queued(23, { publishedAt: at(150) });
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "minRank"='Templar', "escalatedAt"=$1 WHERE id=$2`,
      [NOW, escalated]
    );
    const neverExpires = await queued(24, { publishedAt: at(150), expiresAt: null });
    const escalatedGone = await queued(25);
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "minRank"='Templar', "escalatedAt"=$1 WHERE id=$2`,
      [NOW, escalatedGone]
    );
    await pg.query(`DELETE FROM "Image" WHERE id=25`);

    expect(await sweep()).toEqual({
      unservable: 1,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect(await statusOf([hidden, yesNo, voted, escalated, neverExpires, escalatedGone])).toEqual([
      ['Open', null],
      ['Open', null],
      ['Open', null],
      ['Open', null],
      ['Open', null],
      ['Closed', 'unservable'],
    ]);
  });

  it('closes at most the batch limit per call', async () => {
    const ids: number[] = [];
    for (const id of [31, 32, 33, 34, 35]) ids.push(await queued(id));
    await pg.query(`DELETE FROM "Image" WHERE id IN (31, 32, 33, 34, 35)`);

    expect(await sweep(3)).toEqual({
      unservable: 3,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect((await statusOf(ids)).filter(([status]) => status === 'Closed')).toHaveLength(3);
    expect(await sweep(3)).toEqual({
      unservable: 2,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect((await statusOf(ids)).every(([status]) => status === 'Closed')).toBe(true);
  });

  it('closes an item whose post is still a draft a day after queueing, at any stage, and leaves the other reasons as they were', async () => {
    await active(1, 'Knight');
    const day = { createdAt: at(-25) };
    const freshDraft = await queued(40, { publishedAt: null, createdAt: at(-23) });
    const staleDraft = await queued(41, { ...day, publishedAt: null });
    const published = await queued(42, day);
    // Scheduled: within the item's life it is left alone, past it it is `publishes-after-expiry`, never a draft.
    const scheduledInTime = await queued(43, { ...day, publishedAt: at(100) });
    const scheduledTooLate = await queued(44, { ...day, publishedAt: at(500) });
    // A deleted post is `unservable`, whatever it was before.
    const postGone = await queued(45, { ...day, publishedAt: null });
    await pg.query(`UPDATE "Image" SET "postId"=NULL WHERE id=45`);
    const escalatedDraft = await queued(46, { ...day, publishedAt: null });
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "minRank"='Templar', "escalatedAt"=$1 WHERE id=$2`,
      [at(-2), escalatedDraft]
    );
    // A vote cast before the post went back to a draft is left over: it becomes inconclusive and settles unpaid.
    const votedDraft = await queued(47, { ...day, publishedAt: null });
    await countedVote(votedDraft, 3, 47);
    const neverExpiresDraft = await queued(48, { ...day, publishedAt: null, expiresAt: null });
    // Only scan samples: an owner's rating on a day-old draft stays open.
    const ownerRatingDraft = await queued(49, {
      ...day,
      publishedAt: null,
      source: 'owner-rating',
    });
    const before = await counterValue('knights_escalations_total', {
      reason: 'unpublished-draft',
    });

    expect(await sweep()).toEqual({
      unservable: 1,
      publishesAfterExpiry: 1,
      unpublishedDrafts: 4,
      imageUnservable: 0,
    });

    expect(
      await statusOf([
        freshDraft,
        staleDraft,
        published,
        scheduledInTime,
        scheduledTooLate,
        postGone,
        escalatedDraft,
        votedDraft,
        neverExpiresDraft,
        ownerRatingDraft,
      ])
    ).toEqual([
      ['Open', null],
      ['Closed', 'unpublished-draft'],
      ['Open', null],
      ['Open', null],
      ['Closed', 'publishes-after-expiry'],
      ['Closed', 'unservable'],
      ['Closed', 'unpublished-draft'],
      ['Closed', 'unpublished-draft'],
      ['Closed', 'unpublished-draft'],
      ['Open', null],
    ]);
    expect(await itemRow(staleDraft)).toMatchObject({
      resolvedValue: null,
      escalationReason: null,
    });
    expect(await counterValue('knights_escalations_total', { reason: 'unpublished-draft' })).toBe(
      before + 4
    );
    expect(await verdicts(votedDraft)).toEqual([
      { playerId: 3, verdict: 'inconclusive', stage: 'Knight' },
    ]);
    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 1, failed: 0 });
    expect(
      (await pg.query(`SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=3`)).rows[0]
    ).toEqual({ goldEarned: 0 });
    expect(await applyPendingResolutions(db, deps())).toMatchObject({ applied: 0 });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await sweep()).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
  });

  it('leaves hidden checks and yes/no items on a day-old draft alone', async () => {
    await image(50, 4, null);
    const hidden = await item(50, { hidden: true });
    await image(51, 4, null);
    const yesNo = await item(51, { question: 'knights.test.bool' });
    await pg.query(`UPDATE "KnightsQueueItem" SET audience='players' WHERE id=$1`, [yesNo]);
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "createdAt"=$1, source='scan-sample' WHERE id IN ($2, $3)`,
      [at(-25), hidden, yesNo]
    );

    expect(await sweep()).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect(await statusOf([hidden, yesNo])).toEqual([
      ['Open', null],
      ['Open', null],
    ]);
  });

  it('closes an open item whose image became blocked, held, flagged or unrated on a live post, votes set aside, at the next tick', async () => {
    await fiveKnights();
    const exp = async (userId: number) =>
      (
        await pg.query<{ exp: number }>(`SELECT exp FROM "NewOrderPlayer" WHERE "userId"=$1`, [
          userId,
        ])
      ).rows[0].exp;
    const unservable: Record<string, string> = {
      70: `"nsfwLevel"=32`,
      71: `ingestion='Blocked'`,
      72: `"blockedFor"='tos'`,
      73: `"needsReview"='minor'`,
      74: `poi=true`,
      75: `minor=true`,
      76: `"acceptableMinor"=true`,
      77: `"nsfwLevel"=0`,
    };
    const ids: Record<string, number> = {};
    for (const imageId of Object.keys(unservable)) ids[imageId] = await queued(Number(imageId));
    expect((await vote(1, ids[70], '4')).status).toBe('recorded');
    const servable = await queued(78);
    // Drafts and scheduled posts are left to their own rules, whatever the image.
    const draft = await queued(79, { publishedAt: null });
    const scheduled = await queued(80, { publishedAt: at(100) });
    // A level a moderator locked is `closeModeratorRuledItems`' to close, against that level.
    const moderatorLocked = await queued(81);
    for (const [imageId, change] of Object.entries(unservable))
      await pg.query(`UPDATE "Image" SET ${change} WHERE id=$1`, [Number(imageId)]);
    await pg.query(`UPDATE "Image" SET "nsfwLevel"=32 WHERE id IN (79, 80)`);
    await pg.query(`UPDATE "Image" SET poi=true WHERE id=81`);
    await lockImage(pg, 81, { reason: 'Moderator review', level: 4 });
    const before = {
      exp: await exp(1),
      metric: await counterValue('knights_escalations_total', { reason: 'image-unservable' }),
    };
    const moved: MovedItem[] = [];

    expect(
      await closeUnservableItems(db, { now: NOW, moved: (items) => moved.push(...items) })
    ).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 8,
    });
    // Players holding one in their buffer are told it left.
    expect(moved.sort((a, b) => a.id - b.id)).toEqual(
      Object.values(ids)
        .sort((a, b) => a - b)
        .map((id) => ({ id, status: 'Open', minRank: 'Knight' }))
    );

    expect(await statusOf(Object.values(ids))).toEqual(
      Object.values(ids).map(() => ['Closed', 'image-unservable'])
    );
    expect(await statusOf([servable, draft, scheduled, moderatorLocked])).toEqual([
      ['Open', null],
      ['Open', null],
      ['Open', null],
      ['Open', null],
    ]);
    expect(await itemRow(ids[70])).toMatchObject({ resolvedValue: null, escalationReason: null });
    expect(await counterValue('knights_escalations_total', { reason: 'image-unservable' })).toBe(
      before.metric + 8
    );
    expect(await verdicts(ids[70])).toEqual([
      { playerId: 1, verdict: 'inconclusive', stage: 'Knight' },
    ]);
    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 1, failed: 0 });
    expect(
      (await pg.query(`SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=1`)).rows[0]
    ).toEqual({ goldEarned: 0 });
    // The XP the vote earned when cast stays.
    expect(before.exp).toBeGreaterThan(0);
    expect(await exp(1)).toBe(before.exp);
    expect(await applyPendingResolutions(db, deps())).toMatchObject({ applied: 0 });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await closeModeratorRuledItems(db, { now: NOW })).toEqual({ closed: 1, failed: 0 });
  });

  it('leaves an item whose image has not finished scanning open, and it is servable once the scan lands', async () => {
    const ownerRating = await queued(95, { source: 'owner-rating' });
    await pg.query(`UPDATE "Image" SET ingestion='Pending', "nsfwLevel"=0 WHERE id=95`);

    expect(await sweep()).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect(await statusOf([ownerRating])).toEqual([['Open', null]]);

    await pg.query(`UPDATE "Image" SET ingestion='Scanned', "nsfwLevel"=4 WHERE id=95`);
    expect((await sweep()).imageUnservable).toBe(0);
    expect(await statusOf([ownerRating])).toEqual([['Open', null]]);
    expect(await countOpenServableKnightItems(mainAppDb, 10)).toBe(1);
  });

  it('leaves open an item on a Private post: it is only hidden', async () => {
    const id = await queued(96);
    await pg.query(`UPDATE "Post" SET availability='Private' WHERE id=96`);

    expect(await sweep()).toEqual({
      unservable: 0,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });
    expect(await statusOf([id])).toEqual([['Open', null]]);
    expect(await countOpenServableKnightItems(mainAppDb, 10)).toBe(0);
  });

  it('closes an Inquisitor item whose image is gone, votes set aside, and leaves blocked images, held evidence and rulings in progress', async () => {
    const atInquisitors = async (
      imageId: number,
      { status = 'Inquisitor', leaseUntil = null as Date | null } = {}
    ) => {
      const id = await queued(imageId);
      await pg.query(
        `UPDATE "KnightsQueueItem" SET status=$1, "minRank"='Inquisitor', "escalationReason"='blocked', "nextAttemptAt"=$2 WHERE id=$3`,
        [status, leaseUntil, id]
      );
      return id;
    };
    const imageGone = await atInquisitors(90);
    await countedVote(imageGone, 3, 90);
    // An evidence hold keeps the image when its post is deleted: the moderators can still rule on it.
    const postGone = await atInquisitors(91);
    // Blocked escalations wait for a moderator by design.
    const blocked = await atInquisitors(92);
    await pg.query(`UPDATE "Image" SET "nsfwLevel"=32, ingestion='Blocked' WHERE id=92`);
    const midRuling = await atInquisitors(93, { status: 'Ruling', leaseUntil: at(0.1) });
    const lapsedRuling = await atInquisitors(94, { status: 'Ruling', leaseUntil: at(-0.1) });
    await pg.query(`DELETE FROM "Image" WHERE id IN (90, 93, 94)`);
    await pg.query(`UPDATE "Image" SET "postId"=NULL WHERE id=91`);
    const before = await counterValue('knights_escalations_total', { reason: 'unservable' });
    const moved: MovedItem[] = [];

    expect(
      await closeUnservableItems(db, { now: NOW, moved: (items) => moved.push(...items) })
    ).toEqual({
      unservable: 2,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 0,
      imageUnservable: 0,
    });

    expect(await statusOf([imageGone, postGone, blocked, midRuling, lapsedRuling])).toEqual([
      ['Closed', 'unservable'],
      ['Inquisitor', null],
      ['Inquisitor', null],
      ['Ruling', null],
      ['Closed', 'unservable'],
    ]);
    // Never in a player's buffer: nothing to announce.
    expect(moved).toEqual([]);
    expect(await counterValue('knights_escalations_total', { reason: 'unservable' })).toBe(
      before + 2
    );
    expect(await verdicts(imageGone)).toEqual([
      { playerId: 3, verdict: 'inconclusive', stage: 'Knight' },
    ]);
    expect(await settleFinalItems(db, { now: NOW })).toMatchObject({ votes: 1, failed: 0 });
    expect(
      (await pg.query(`SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=3`)).rows[0]
    ).toEqual({ goldEarned: 0 });
  });

  it('shares the batch limit between every reason, oldest item first', async () => {
    const day = { createdAt: at(-25) };
    const draft = await queued(61, { ...day, publishedAt: null });
    const gone = await queued(62, day);
    await pg.query(`DELETE FROM "Image" WHERE id=62`);
    const laterDraft = await queued(63, { ...day, publishedAt: null });
    const late = await queued(64, { ...day, publishedAt: at(500) });

    expect(await sweep(2)).toEqual({
      unservable: 1,
      publishesAfterExpiry: 0,
      unpublishedDrafts: 1,
      imageUnservable: 0,
    });
    expect(await statusOf([draft, gone, laterDraft, late])).toEqual([
      ['Closed', 'unpublished-draft'],
      ['Closed', 'unservable'],
      ['Open', null],
      ['Open', null],
    ]);
    expect(await sweep(2)).toEqual({
      unservable: 0,
      publishesAfterExpiry: 1,
      unpublishedDrafts: 1,
      imageUnservable: 0,
    });
  });
});

describe('closeWithoutOutcome', () => {
  it('marks pending votes inconclusive and closes the item', async () => {
    await fiveKnights();
    await image(10);
    const id = await item(10);
    await vote(1, id, '4');
    await vote(2, id, '8');

    await closeWithoutOutcome(db, id, NOW);
    expect(await itemRow(id)).toMatchObject({ status: 'Closed', resolvedValue: null });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['inconclusive', 'inconclusive']);
  });
});

describe('vote partitions', () => {
  it('creates the month partition on demand when the job has not', async () => {
    // The owner's function creates a month near the real one only, so the vote is cast in one.
    const at = monthsFromNow(3);
    const name = await dropEmptyPartition(at);
    await player(1, 'Knight');
    await image(10);
    const id = await item(10);
    const res = await castVote(
      db,
      { userId: 1, itemId: id, answer: '4' },
      { applyConsensus, now: () => at }
    );
    expect(res.status).toBe('recorded');
    const found = await pg.query<{ found: boolean }>(
      `SELECT to_regclass('"${name}"') IS NOT NULL AS found`
    );
    expect(found.rows[0].found).toBe(true);
  });
});

describe('ensureVotePartitions', () => {
  it('creates missing month partitions ahead of time and can run twice', async () => {
    const count = async () =>
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = '"KnightsVote"'::regclass`
        )
      ).rows[0].n;
    const from = monthsFromNow(1);
    const names = await Promise.all([1, 2, 3].map((n) => dropEmptyPartition(monthsFromNow(n))));
    const missing = (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass(format('%I', name)) IS NULL`,
        [names]
      )
    ).rows[0].n;
    expect(missing).toBeGreaterThan(0);
    const before = await count();
    await ensureVotePartitions(db, { now: from, monthsAhead: 2 });
    await ensureVotePartitions(db, { now: from, monthsAhead: 2 });
    expect(await count()).toBe(before + missing);

    await player(1, 'Knight');
    await image(10);
    const id = await item(10);
    const res = await castVote(
      db,
      { userId: 1, itemId: id, answer: '4' },
      { applyConsensus, now: () => monthsFromNow(2) }
    );
    expect(res.status).toBe('recorded');
  });
});

describe('held players', () => {
  const PAST = new Date('2026-12-15T11:00:00Z');
  beforeEach(async () => {
    await pg.exec(`TRUNCATE "User"`);
    // Earlier tests leave their own outcome on the shared mock.
    applyConsensus.mockReset();
    applyConsensus.mockImplementation(async () => APPLIED);
  });
  const hold = (...userIds: number[]) =>
    pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId" = ANY($1)`, [
      userIds,
    ]);
  const weightOf = async (itemId: number, userId: number) =>
    (
      await pg.query<{ weight: number }>(
        `SELECT weight FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId"=$2`,
        [itemId, userId]
      )
    ).rows[0]?.weight;

  it('accepts a held vote and stores it with no weight', async () => {
    await player(1, 'Knight');
    await player(2, 'Knight');
    await hold(1);
    await pg.query(`INSERT INTO "User" ("id","bannedAt") VALUES (2, now())`);
    await image(10);
    const id = await item(10);

    expect(await vote(1, id, '4')).toMatchObject({ status: 'recorded' });
    expect(await vote(2, id, '4')).toMatchObject({ status: 'recorded' });
    expect(await weightOf(id, 1)).toBe(0);
    expect(await weightOf(id, 2)).toBe(0);
  });

  it('never resolves an item on held votes, however many agree', async () => {
    await fiveKnights();
    await hold(1, 2, 3, 4, 5);
    await image(10);
    const id = await item(10);
    for (const u of [1, 2, 3, 4, 5]) expect((await vote(u, id, '4')).status).toBe('recorded');
    expect(applyConsensus).not.toHaveBeenCalled();
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });

    await image(11);
    const one = await item(11, { votesNeeded: 1 });
    await player(6, 'Knight');
    await hold(6);
    expect((await vote(6, one, '4')).status).toBe('recorded');
    expect(await itemRow(one)).toMatchObject({ status: 'Open' });
  });

  it('does not count held votes toward the ten that hand a split up', async () => {
    for (let i = 1; i <= 10; i++) await player(i, 'Knight');
    await hold(5, 6, 7, 8, 9, 10);
    await image(10);
    const id = await item(10);
    for (let i = 1; i <= 10; i++) await vote(i, id, i % 2 ? '4' : '8');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });
  });

  it('resolves on the real votes alone, whatever the held votes say', async () => {
    await fiveKnights();
    await player(6, 'Knight');
    await player(7, 'Knight');
    await hold(6, 7);
    await image(10);
    const id = await item(10);
    for (const u of [1, 2, 3]) await vote(u, id, '4');
    expect((await vote(6, id, '8')).status).toBe('recorded');
    expect((await vote(7, id, '8')).status).toBe('recorded');
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await vote(4, id, '4')).status).toBe('resolved');
    expect(applyConsensus).toHaveBeenCalledWith(expect.objectContaining({ value: '4' }));
  });

  it('grades a held vote against the verdict and pays its XP', async () => {
    await fiveKnights();
    await player(6, 'Knight');
    await player(7, 'Knight');
    await hold(6, 7);
    await image(10);
    const id = await item(10);
    await vote(6, id, '4');
    await vote(7, id, '8');
    for (const u of [1, 2, 3, 4]) await vote(u, id, '4');

    const rows = (
      await pg.query<{ playerId: number; verdict: string; settledAt: Date | null }>(
        `SELECT "playerId", verdict, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId" > 5 ORDER BY "playerId"`,
        [id]
      )
    ).rows;
    expect(rows.map((r) => r.verdict)).toEqual(['correct', 'failed']);
    expect(rows.every((r) => r.settledAt !== null)).toBe(true);
    const exp = await pg.query<{ exp: number }>(
      `SELECT exp FROM "NewOrderPlayer" WHERE "userId"=6`
    );
    expect(exp.rows[0].exp).toBeGreaterThan(10);
  });

  it('extends an item whose only vote is held, as one nobody voted on', async () => {
    await active(2, 'Templar');
    await player(1, 'Knight');
    await hold(1);
    await image(10);
    const id = await item(10, { expires: PAST });
    expect((await vote(1, id, '4')).status).toBe('recorded');
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 1,
      expired: 0,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });
  });

  it('does not let a held player staff a rank, so an item skips to the next rank someone can serve', async () => {
    await active(1, 'Knight');
    await active(2, 'Paladin');
    await hold(2);
    await image(10);
    const id = await item(10, { expires: PAST });
    await vote(1, id, '4');

    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({ status: 'Closed', minRank: 'Knight' });

    await image(11);
    const other = await item(11, { expires: PAST });
    await pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = NULL WHERE "userId" = 2`);
    await vote(1, other, '4');
    await escalateExpired(db, { now: NOW });
    expect(await itemRow(other)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });
});

describe('no consensus at the end of the path', () => {
  beforeEach(() => {
    applyConsensus.mockImplementation(async () => APPLIED);
  });
  const PAST = new Date('2026-12-15T11:00:00Z');
  const rerateCount = () =>
    counterValue('knights_escalations_total', { reason: 'no-consensus-rerate' });
  const noConsensusCount = () =>
    counterValue('knights_escalations_total', { reason: 'no-consensus' });
  const ledger = async (itemId: number) =>
    (
      await pg.query<{
        playerId: number;
        verdict: string;
        gold: number;
        xp: number;
        settledAt: Date | null;
      }>(
        `SELECT "playerId", verdict, gold, xp, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
        [itemId]
      )
    ).rows;
  const inquisitorRows = async () =>
    (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "KnightsQueueItem" WHERE status = 'Inquisitor'`
      )
    ).rows[0].n;
  const goldEarned = async (userId: number) =>
    (
      await pg.query<{ goldEarned: number }>(
        `SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
        [userId]
      )
    ).rows[0].goldEarned;
  const hold = (userId: number) =>
    pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId" = $1`, [userId]);
  /** A counted vote cast at an earlier stage, which the re-rate sets aside with the rest. */
  async function earlierVote(itemId: number, playerId: number, stage: string, answer = '4') {
    await player(playerId, 'Knight');
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","gold")
       VALUES ($1,$2,$3,$4,10,$5,$6,1,5)`,
      [itemId, playerId, NOW, Q, stage, answer]
    );
  }

  it('re-rates a split at the last staffed stage to the highest most-voted level, pays XP only and never asks the Inquisitors', async () => {
    // Knights alone play, so the Knight stage is the end of the path.
    for (let u = 1; u <= 10; u++) await active(u, 'Knight');
    await image(10, 4);
    const id = await item(10);
    const [rerated, noConsensus] = [await rerateCount(), await noConsensusCount()];
    // One PG-13, four R, four X and one XXX: R and X tie, X is higher.
    const answers = ['2', '4', '8', '4', '8', '4', '8', '4', '8', '16'];
    for (let i = 0; i < 9; i++) expect((await vote(i + 1, id, answers[i])).status).toBe('recorded');
    expect((await vote(10, id, answers[9])).status).toBe('resolved');

    expect(await itemRow(id)).toMatchObject({
      status: 'Resolved',
      minRank: 'Knight',
      resolvedValue: '8',
      resolvedFromLevel: 4,
      reason: 'no-consensus-rerate',
      escalationReason: null,
    });
    expect((await itemRow(id)).appliedAt).not.toBeNull();
    // The latest voter who gave the level is the write-back's actor.
    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect(applyConsensus).toHaveBeenCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '8',
      actorId: 9,
    });
    const votes = await ledger(id);
    expect(votes).toHaveLength(10);
    for (const v of votes) {
      expect(v).toMatchObject({ verdict: 'inconclusive', gold: 0, xp: PROGRESSION.voteXp });
      expect(v.settledAt).not.toBeNull();
      expect(await goldEarned(v.playerId)).toBe(0);
    }
    expect(await inquisitorRows()).toBe(0);
    expect(await rerateCount()).toBe(rerated + 1);
    expect(await noConsensusCount()).toBe(noConsensus);

    // History keeps each player's own answer and never shows the level the image got.
    const [own] = (await listJudgments(db, 3, { page: 1 })).judgments;
    expect(own).toMatchObject({ status: 'inconclusive', verdictLabel: null, gold: 0 });
    const [other] = (await listJudgments(db, 1, { page: 1 })).judgments;
    expect(other).toMatchObject({ status: 'inconclusive', verdictLabel: null, gold: 0 });
    expect(other.answerLabel).not.toBe(own.answerLabel);
  });

  it('re-rates a lapsed stage that has its quorum, down as well, and the tick writes it back', async () => {
    for (let u = 1; u <= 3; u++) await active(u, 'Templar');
    await active(4, 'Templar');
    await hold(4);
    await image(10, 8);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    await earlierVote(id, 20, 'Knight', '8');
    // Three votes, two of them PG-13: the Templar quorum, without the unanimity that settles it.
    for (const [u, answer] of [
      [1, '2'],
      [2, '16'],
      [3, '2'],
      [4, '16'],
    ] as const) {
      expect((await vote(u, id, answer)).status).toBe('recorded');
    }

    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 0,
      rerated: 1,
    });
    // Two levels down: the pushed-down check guards a consensus, not a re-rate.
    expect(await itemRow(id)).toMatchObject({
      status: 'Resolved',
      minRank: 'Templar',
      resolvedValue: '2',
      resolvedBy: 3,
      resolvedFromLevel: 8,
      reason: 'no-consensus-rerate',
      appliedAt: null,
      escalationReason: null,
    });
    expect((await ledger(id)).map((v) => [v.playerId, v.verdict, v.settledAt])).toEqual([
      [1, 'inconclusive', null],
      [2, 'inconclusive', null],
      [3, 'inconclusive', null],
      [4, 'inconclusive', null],
      [20, 'inconclusive', null],
    ]);
    expect(applyConsensus).not.toHaveBeenCalled();

    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 1,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).toHaveBeenCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '2',
      actorId: 3,
    });
    expect((await itemRow(id)).appliedAt).not.toBeNull();
    for (const v of await ledger(id)) {
      expect(v).toMatchObject({ verdict: 'inconclusive', gold: 0 });
      expect(v.settledAt).not.toBeNull();
    }
    expect(await goldEarned(20)).toBe(0);
    expect(await inquisitorRows()).toBe(0);
  });

  it('sends a lapsed stage below its quorum whose pick is Blocked to the Inquisitors as blocked', async () => {
    for (let u = 1; u <= 2; u++) await active(u, 'Templar');
    await image(10, 4);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    // Two votes, tied: Blocked is the highest level, below the Templar quorum of three.
    await vote(1, id, '4');
    await vote(2, id, '32');

    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 1,
      extended: 0,
      expired: 0,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      escalationReason: 'blocked',
      reason: null,
      resolvedValue: null,
    });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['pending', 'pending']);
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('hands a re-rate whose image moved before the write-back to the Inquisitors with its votes pending again', async () => {
    for (let u = 1; u <= 3; u++) await active(u, 'Templar');
    await image(10, 8);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    for (const [u, answer] of [
      [1, '2'],
      [2, '4'],
      [3, '2'],
    ] as const) {
      await vote(u, id, answer);
    }
    expect(await escalateExpired(db, { now: NOW })).toMatchObject({ rerated: 1 });
    expect((await verdicts(id)).every((v) => v.verdict === 'inconclusive')).toBe(true);
    await pg.query(`UPDATE "Image" SET "nsfwLevel" = 16 WHERE id = 10`);

    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 1,
    });
    // The write-back tab: Inquisitor with a write-back reason and no escalation reason.
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      reason: 'level-moved',
      escalationReason: null,
      resolvedValue: null,
      appliedAt: null,
    });
    expect((await ledger(id)).map((v) => [v.verdict, v.settledAt])).toEqual([
      ['pending', null],
      ['pending', null],
      ['pending', null],
    ]);
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('still hands a non-rating question to the Inquisitors as no-consensus, split or lapsed, and writes nothing', async () => {
    for (let u = 1; u <= 4; u++) await active(u, 'Paladin');
    await image(10, 4);
    await image(11, 4);
    const split = await item(10, { minRank: 'Paladin', question: 'knights.test.bool' });
    const answers = ['yes', 'no', 'yes', 'no'];
    for (let i = 0; i < 3; i++) await vote(i + 1, split, answers[i]);
    expect((await vote(4, split, answers[3])).status).toBe('inquisitor');
    // One vote, below the Paladin quorum: a rating would close as expired.
    const lapsed = await item(11, {
      minRank: 'Paladin',
      question: 'knights.test.bool',
      expires: PAST,
    });
    await vote(1, lapsed, 'yes');
    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 1,
      extended: 0,
      expired: 0,
      rerated: 0,
    });

    for (const id of [split, lapsed]) {
      expect(await itemRow(id)).toMatchObject({
        status: 'Inquisitor',
        minRank: 'Inquisitor',
        escalationReason: 'no-consensus',
        reason: null,
        resolvedValue: null,
      });
      expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
    }
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('closes a lapsed stage below its quorum as expired, with no write-back', async () => {
    for (let u = 1; u <= 2; u++) await active(u, 'Templar');
    await image(10, 8);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    await vote(1, id, '2');
    await vote(2, id, '4');

    expect(await escalateExpired(db, { now: NOW })).toEqual({
      escalated: 0,
      toInquisitor: 0,
      extended: 0,
      expired: 1,
      rerated: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'expired',
      resolvedValue: null,
    });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['inconclusive', 'inconclusive']);
    await settleFinalItems(db, { now: NOW });
    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).not.toHaveBeenCalled();
    for (const v of await ledger(id)) expect(v).toMatchObject({ verdict: 'inconclusive', gold: 0 });
  });

  it('sends a Blocked pick to the Inquisitors as blocked', async () => {
    for (let u = 1; u <= 4; u++) await player(u, 'Paladin');
    await image(10, 4);
    const id = await item(10, { minRank: 'Paladin' });
    const answers = ['32', '4', '32', '8'];
    for (let i = 0; i < 3; i++) expect((await vote(i + 1, id, answers[i])).status).toBe('recorded');
    expect((await vote(4, id, answers[3])).status).toBe('inquisitor');

    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      escalationReason: 'blocked',
      resolvedValue: null,
    });
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
    expect(applyConsensus).not.toHaveBeenCalled();
  });

  it('grades the votes against a moderator who locked the image before the write-back', async () => {
    for (let u = 1; u <= 3; u++) await active(u, 'Templar');
    await image(10, 8);
    const id = await item(10, { minRank: 'Templar', expires: PAST });
    for (const [u, answer] of [
      [1, '2'],
      [2, '1'],
      [3, '2'],
    ] as const) {
      await vote(u, id, answer);
    }
    await escalateExpired(db, { now: NOW });
    await lockImage(pg, 10, { reason: 'Moderator rating review', level: 1 });

    expect(await applyPendingResolutions(db, deps())).toEqual({
      applied: 0,
      failed: 0,
      rerouted: 1,
    });
    expect(await itemRow(id)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-ruled',
      resolvedValue: '1',
    });
    expect((await verdicts(id)).map((v) => v.verdict)).toEqual(['failed', 'correct', 'failed']);
    expect(applyConsensus).not.toHaveBeenCalled();
  });
});

describe('countOpenServableKnightItems', () => {
  it('counts open Knight-stage rating items players can be served, up to the limit', async () => {
    for (const id of [21, 22, 23, 24, 25, 26]) {
      await image(id);
      await item(id);
    }
    await pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id=22`);
    await pg.query(`UPDATE "Image" SET "poi"=true WHERE id=23`);
    await pg.query(`UPDATE "Image" SET "needsReview"='minor' WHERE id=24`);
    await pg.query(`UPDATE "KnightsQueueItem" SET "minRank"='Templar' WHERE "imageId"=25`);

    expect(await countOpenServableKnightItems(mainAppDb, 100)).toBe(2);
    expect(await countOpenServableKnightItems(mainAppDb, 1)).toBe(1);
  });
});

describe('a player and their own image', () => {
  it('never serves a player an image they posted, and refuses their vote on it', async () => {
    await player(1, 'Knight');
    await player(2, 'Knight');
    await image(10);
    await image(11);
    await pg.query(`UPDATE "Image" SET "userId"=1 WHERE id=10`);
    const mine = await item(10);
    const other = await item(11);

    expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([other]);
    expect((await getFeed(db, 2))?.items.map((i) => i.id).sort()).toEqual([mine, other].sort());

    expect(await vote(1, mine, '4')).toEqual({ status: 'rejected', reason: 'own-image' });
    expect(await verdicts(mine)).toEqual([]);
    expect(await vote(2, mine, '4')).toMatchObject({ status: 'recorded' });
  });
});

describe('a creator the player hid or blocked', () => {
  async function creatorItems() {
    await player(1, 'Knight');
    await player(2, 'Knight');
    await image(10);
    await image(11);
    await pg.query(`UPDATE "Image" SET "userId"=50 WHERE id=10`);
    await pg.query(`UPDATE "Image" SET "userId"=51 WHERE id=11`);
    return { theirs: await item(10), other: await item(11) };
  }

  it.each(['Block', 'Hide'] as const)(
    'with a %s row, serves the creator to other players only and refuses the vote',
    async (type) => {
      const { theirs, other } = await creatorItems();
      await engage(pg, 1, 50, type);

      expect((await getFeed(db, 1))?.items.map((i) => i.id)).toEqual([other]);
      expect((await getFeed(db, 2))?.items.map((i) => i.id).sort()).toEqual([theirs, other].sort());

      expect(await vote(1, theirs, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
      expect(await verdicts(theirs)).toEqual([]);
      expect(await vote(2, theirs, '4')).toMatchObject({ status: 'recorded' });
    }
  );

  it('leaves the creator out of every scan round, the short per-row rounds and the long ones alike', async () => {
    await player(1, 'Knight');
    // 742 PG items, then two X items: only the PG bucket can fill, so the scan reads the whole stage in rounds of 100,
    // 200 and 400 (probed per row) and then 800 (the plain anti-join). The creator owns one item in each kind of round.
    const ids = await sameAgeStage([...Array<number>(740).fill(1), 8, 8]);
    const [early, late, x] = [ids[5], ids[740], ids[741]];
    await pg.query(
      `UPDATE "Image" SET "userId"=50 WHERE id IN (SELECT "imageId" FROM "KnightsQueueItem" WHERE id IN ($1,$2))`,
      [early, late]
    );
    await engage(pg, 1, 50, 'Hide');
    const watched = watchFeedReads();

    const served = (await getFeed(watched.db, 1))?.items.map((i) => i.id) ?? [];
    expect(served).toContain(x);
    expect(watched.rounds.map((r) => r.length)).toEqual([100, 200, 400, 40]);
    expect(watched.rounds.flat()).toEqual(ids.filter((id) => id !== early && id !== late));
  });

  it('changes nothing for a Follow row', async () => {
    const { theirs, other } = await creatorItems();
    await engage(pg, 1, 50, 'Follow');

    expect((await getFeed(db, 1))?.items.map((i) => i.id).sort()).toEqual([theirs, other].sort());
    expect(await vote(1, theirs, '4')).toMatchObject({ status: 'recorded' });
  });

  it('still serves the creator when it is the creator who blocked the player', async () => {
    const { theirs, other } = await creatorItems();
    await engage(pg, 50, 1, 'Block');

    expect((await getFeed(db, 1))?.items.map((i) => i.id).sort()).toEqual([theirs, other].sort());
    expect(await vote(1, theirs, '4')).toMatchObject({ status: 'recorded' });
  });

  it('gives no late Watch credit on a settled item of a hidden creator', async () => {
    const { theirs } = await creatorItems();
    await engage(pg, 1, 50, 'Block');
    await pg.query(`UPDATE "KnightsQueueItem" SET status='Closed', "updatedAt"=$2 WHERE id=$1`, [
      theirs,
      NOW,
    ]);
    const watchDays = async (userId: number) =>
      (await pg.query(`SELECT 1 FROM "KnightsPlayerDay" WHERE "playerId"=$1`, [userId])).rows;

    expect(await creditLateJudgment(db, { userId: 1, itemId: theirs, answer: '4', now: NOW })).toBe(
      false
    );
    expect(await verdicts(theirs)).toEqual([]);
    expect(await watchDays(1)).toEqual([]);

    expect(await creditLateJudgment(db, { userId: 2, itemId: theirs, answer: '4', now: NOW })).toBe(
      true
    );
    expect((await verdicts(theirs)).map((v) => v.playerId)).toEqual([2]);
  });
});
