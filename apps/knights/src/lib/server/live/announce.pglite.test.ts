import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { createQueueDb } from '../../../test/pglite-kysely';
import { castVote, enqueueItem, ensureVotePartitions } from '../queue/queue.service';
import { announceMoves, itemStages } from './announce';
import { liveKey } from './live-key';

const { sendTopic, sendToUser, signalsEnabled } = vi.hoisted(() => ({
  sendTopic: vi.fn(async (_topic: string, _target: string, _data: unknown) => {}),
  sendToUser: vi.fn(async (_userId: number, _target: string, _data: unknown) => {}),
  signalsEnabled: vi.fn(async () => true),
}));
vi.mock('./signals', () => ({ sendTopic, sendToUser, signalsEnabled }));
vi.mock('../smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('../player-status', () => ({
  getPlayerStatus: async () => ({ rank: 'Knight', level: 20, rating: { belowBar: false } }),
}));
vi.mock('../daily/daily.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daily/daily.service')>()),
  getDailyStatus: async () => ({ votes: 4 }),
}));

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  signalsEnabled.mockResolvedValue(true);
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE`
  );
  await pg.exec(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES (1,'Knight'),(2,'Knight'),(3,'Knight'),(4,'Knight')`
  );
  await pg.exec(`INSERT INTO "Post" ("id","publishedAt") VALUES (10,'2020-01-01')`);
  await pg.exec(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES (10,'key-10',4,10)`);
});

const enqueue = () =>
  enqueueItem(
    db,
    {
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
      imageId: 10,
      source: 'test',
      minRank: 'Knight',
      expiresAt: null,
    },
    NOW
  );

const vote = (userId: number, itemId: number) =>
  castVote(
    db,
    { userId, itemId, answer: '4' },
    { applyConsensus: vi.fn(async () => ({ outcome: 'applied' as const })), now: () => NOW }
  );

describe('announceMoves', () => {
  it('drops a settled item for its stage, without its id, and sends its voters their stats', async () => {
    const itemId = await enqueue();
    for (const userId of [1, 2, 3]) await vote(userId, itemId);
    const before = await itemStages(db, [itemId]);
    expect(await vote(4, itemId)).toMatchObject({ status: 'resolved' });

    await announceMoves(db, before);

    expect(sendTopic).toHaveBeenCalledExactlyOnceWith(
      'knights-queue:Knight',
      'knights-queue-drop',
      {
        drops: [{ k: liveKey('secret', itemId), to: null }],
      }
    );
    expect(JSON.stringify(sendTopic.mock.calls)).not.toContain(`"${itemId}"`);
    expect(sendToUser.mock.calls.map(([userId]) => userId).sort()).toEqual([1, 2, 3, 4]);
    expect(sendToUser).toHaveBeenCalledWith(
      1,
      'knights-player',
      expect.objectContaining({
        daily: expect.objectContaining({ votes: 4, goldPerVote: expect.any(Number) }),
      })
    );
  });

  it('names the stage an escalated item is open at, and sends no stats while it is still open', async () => {
    const itemId = await enqueue();
    const before = await itemStages(db, [itemId]);
    await pg.exec(`UPDATE "KnightsQueueItem" SET "minRank" = 'Templar' WHERE id = ${itemId}`);

    await announceMoves(db, before);

    expect(sendTopic).toHaveBeenCalledExactlyOnceWith(
      'knights-queue:Knight',
      'knights-queue-drop',
      {
        drops: [{ k: liveKey('secret', itemId), to: 'Templar' }],
      }
    );
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('sends nothing for an item still open at its stage, or when live updates are off', async () => {
    const itemId = await enqueue();
    const before = await itemStages(db, [itemId]);
    await vote(1, itemId);
    await announceMoves(db, before);

    signalsEnabled.mockResolvedValue(false);
    await pg.exec(`UPDATE "KnightsQueueItem" SET status = 'Closed' WHERE id = ${itemId}`);
    await announceMoves(db, before);

    expect(sendTopic).not.toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
