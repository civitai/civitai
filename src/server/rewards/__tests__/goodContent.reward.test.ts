import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({ insert: vi.fn(async () => undefined) }));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: unknown[]) => h.insert(...(args as [])),
    // The cap lookup: nothing awarded yet today.
    $query: vi.fn(async () => []),
  },
}));

import type { PrismaClient } from '@prisma/client';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { goodContentReward } from '~/server/rewards/passive/goodContent.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';

const SCHEMA = `
  CREATE TABLE "ImageReaction" (id serial PRIMARY KEY, "imageId" int, "userId" int, reaction text);
  CREATE TABLE "ArticleReaction" (id serial PRIMARY KEY, "articleId" int, "userId" int, reaction text);
  CREATE TABLE "CommentV3Reaction" (id serial PRIMARY KEY, "commentId" int, "userId" int, reaction text);
`;

const OWNER = 1;
let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await harness?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  paid = [];
  vi.stubGlobal('fetch', buzzApi);
  invalidateRewardConfigCache();
  await harness.pg.exec(
    'TRUNCATE "ImageReaction", "ArticleReaction", "CommentV3Reaction" RESTART IDENTITY'
  );
});

/** A pending row as `process-rewards` reads it back from buzzEvents. */
const pending = (entityType: string, forId: number, byUserId: number): BuzzEventLog => ({
  type: `goodContent:${entityType}`,
  forId,
  toUserId: OWNER,
  byUserId,
  awardAmount: 2,
  multiplier: 1,
  status: 'pending',
  version: 1,
  transactionDetails: '{}',
});

/** The externalTransactionId of each transaction sent to the buzz service. */
let paid: string[] = [];
const buzzApi = vi.fn(async (_url: string, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body)) as { externalTransactionId: string }[];
  paid.push(...sent.map((t) => t.externalTransactionId));
  return Response.json({ transactions: sent.map((_, i) => ({ id: i })), conflicts: [] });
});

const run = (toProcess: BuzzEventLog[], db: PrismaClient = harness.prisma) =>
  goodContentReward.process({
    db,
    ch: {} as never,
    lastUpdate: new Date(0),
    toProcess,
  });

describe('the good content reward', () => {
  it('pays only for reactions still present when the job runs', async () => {
    await harness.pg.exec(`
      INSERT INTO "ImageReaction" ("imageId", "userId", reaction) VALUES (10, 2, 'Like'), (11, 3, 'Heart');
      INSERT INTO "ArticleReaction" ("articleId", "userId", reaction) VALUES (20, 2, 'Like');
      INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction) VALUES (30, 2, 'Like');
    `);

    await run([
      pending('image', 10, 2),
      // Removed. Its entity and its reactor each have another reaction, so only an exact
      // (entity, reactor) match can tell it apart.
      pending('image', 11, 2),
      pending('image', 10, 3),
      pending('article', 20, 2),
      pending('article', 21, 2),
      pending('comment', 30, 2),
      pending('comment', 31, 2),
    ]);

    // type:forId-toUserId-byUserId
    expect(paid.sort()).toEqual([
      'goodContent:article:20-1-2',
      'goodContent:comment:30-1-2',
      'goodContent:image:10-1-2',
    ]);
  });

  it('leaves the events pending and pays nothing when the reaction read fails', async () => {
    const failing = Promise.reject(new Error('connection lost'));
    failing.catch(() => undefined);
    const db = { imageReaction: { findMany: () => failing } } as unknown as PrismaClient;
    const events = [pending('image', 10, 2)];

    await expect(run(events, db)).rejects.toThrow('connection lost');

    // No buzzEvents write either: the row stays pending, and the job re-reads its window.
    expect(h.insert).not.toHaveBeenCalled();
    expect(buzzApi).not.toHaveBeenCalled();
    expect(events[0].status).toBe('pending');
  });
});
