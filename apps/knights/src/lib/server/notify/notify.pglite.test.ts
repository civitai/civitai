import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { enqueueItem, ensureVotePartitions } from '../queue/queue.service';
import { typeOf, type NotifyKind } from './config';
import { BatchRejected, sendNotifications, type NotificationBatch } from './notify.service';

const Q = 'knights.image.nsfwLevel';
const TODAY = '2026-12-17';
const at = (hour: number) => new Date(`${TODAY}T${String(hour).padStart(2, '0')}:30:00Z`);

let pg: PGlite;
let db: Kysely<DB>;
let imageId = 5000;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: at(12), monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post","KnightsPlayer","KnightsPlayerDay","KnightsNotificationSend","UserNotificationSettings" RESTART IDENTITY`
  );
});

/** A settings row means the player turned that type off. */
const optOut = (userId: number, ...kinds: NotifyKind[]) =>
  Promise.all(
    kinds.map((kind) =>
      pg.query(`INSERT INTO "UserNotificationSettings" ("userId","type") VALUES ($1,$2)`, [
        userId,
        typeOf(kind),
      ])
    )
  );

const seedStreak = (
  userId: number,
  { streak = 3, lastWatchDay = '2026-12-16', shields = 0 } = {}
) =>
  pg.query(
    `INSERT INTO "KnightsPlayer" ("playerId","streak","lastWatchDay","shields","shieldWeek") VALUES ($1,$2,$3,$4,'2026-12-14')`,
    [userId, streak, lastWatchDay, shields]
  );

async function enqueueImage() {
  const id = ++imageId;
  await seedImage(pg, id);
  await enqueueItem(db, { questionKey: Q, imageId: id, source: 'test', expiresAt: null }, at(1));
}

/** A vote cast on the 15th and settled correct yesterday, so it is news and nobody has played since. */
const seedSettledVote = (playerId: number, settledAt = '2026-12-16 10:00:00') =>
  pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
     VALUES ($1,$2,'2026-12-15 10:00:00',$3,1,'Knight','4',1,'correct',$4,0,0)`,
    [playerId * 100, playerId, Q, settledAt]
  );

const everyone = async (ids: number[]) => ids;

function runner({ blocked = [] as number[] } = {}) {
  const batches: NotificationBatch[] = [];
  const send = vi.fn(async (batch: NotificationBatch) => {
    batches.push(batch);
  });
  const accessible = async (ids: number[]) => ids.filter((id) => !blocked.includes(id));
  const run = (now: Date) => sendNotifications(db, { now, send, accessible });
  const received = () => {
    const out = new Map<number, NotifyKind[]>();
    for (const b of batches)
      for (const id of b.userIds) out.set(id, [...(out.get(id) ?? []), b.kind]);
    return out;
  };
  return { run, received, send };
}

describe('sendNotifications', () => {
  it('tells a player their votes settled', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    const { run, received } = runner();

    await run(at(12));

    expect(received().get(1)).toEqual(['verdicts']);
  });

  it('sends nothing about verdicts once the player has voted again', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES (7,1,'2026-12-17 08:00:00',$1,1,'Knight','4',1)`,
      [Q]
    );
    const { run, received } = runner();

    await run(at(12));

    expect(received().size).toBe(0);
  });

  it('sends a streak warning from 21:00 UTC and nothing else that day', async () => {
    await seedPlayer(pg, 1);
    await seedStreak(1);
    await enqueueImage();
    const { run, received } = runner();

    await run(at(12));
    expect(received().size).toBe(0);

    await run(at(21));
    await run(at(22));

    expect(received().get(1)).toEqual(['streak']);
  });

  it('does not warn when a shield would cover the missed day', async () => {
    await seedPlayer(pg, 1);
    await seedStreak(1, { shields: 1 });
    const { run, received } = runner();

    await run(at(21));

    expect(received().size).toBe(0);
  });

  it("does not warn once today's Watch is done or the streak is already lost", async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await seedStreak(1, { lastWatchDay: TODAY });
    await seedStreak(2, { lastWatchDay: '2026-12-10' });
    const { run, received } = runner();

    await run(at(21));

    expect(received().size).toBe(0);
  });

  it('does not warn a streak a career reset has ended', async () => {
    await seedPlayer(pg, 1, 'Knight', { startAt: '2026-12-17 03:00:00' });
    await seedStreak(1);
    const { run, received } = runner();

    await run(at(21));

    expect(received().size).toBe(0);
  });

  it('tells a player about waiting images only when their rank can judge them', async () => {
    await seedPlayer(pg, 1, 'Knight');
    await seedPlayer(pg, 2, 'Acolyte');
    await enqueueImage();
    const { run, received } = runner();

    await run(at(12));

    expect([...received().keys()]).toEqual([1]);
  });

  it('is silent when the queue holds only images the player already voted on', async () => {
    await seedPlayer(pg, 1);
    await enqueueImage();
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       SELECT id,1,'2026-12-17 08:00:00',$1,"imageId",'Knight','4',1 FROM "KnightsQueueItem"`,
      [Q]
    );
    const { run, received } = runner();

    await run(at(12));

    expect(received().size).toBe(0);
  });

  it('picks the best type: verdicts over the streak warning over new images', async () => {
    for (const id of [1, 2, 3]) {
      await seedPlayer(pg, id);
    }
    await seedStreak(1);
    await seedStreak(2);
    await seedSettledVote(1);
    await enqueueImage();
    const { run, received } = runner();

    await run(at(21));

    expect(received().get(1)).toEqual(['verdicts']);
    expect(received().get(2)).toEqual(['streak']);
    expect(received().get(3)).toEqual(['new-images']);
  });

  it('skips a type the player turned off and falls back to the next best', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    await optOut(1, 'verdicts');
    await enqueueImage();
    const { run, received } = runner();

    await run(at(12));

    expect(received().get(1)).toEqual(['new-images']);
  });

  it('sends nothing to a player who turned every type off', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    await optOut(1, 'verdicts', 'streak', 'new-images');
    await enqueueImage();
    const { run, received } = runner();

    await run(at(21));

    expect(received().size).toBe(0);
  });

  it('sends nothing to a user who never joined the game', async () => {
    await seedSettledVote(1);
    await seedStreak(1);
    await enqueueImage();
    const { run, received } = runner();

    await run(at(21));

    expect(received().size).toBe(0);
  });

  it('sends at most once a day however often it runs', async () => {
    await seedPlayer(pg, 1);
    await enqueueImage();
    const { run, received, send } = runner();

    await run(at(9));
    await run(at(9));
    await seedSettledVote(1, '2026-12-17 10:00:00');
    await run(at(20));

    expect(received().get(1)).toEqual(['new-images']);
    expect(send).toHaveBeenCalledTimes(1);

    await run(new Date('2026-12-18T09:30:00Z'));
    expect(received().get(1)).toEqual(['new-images', 'verdicts']);
  });

  it('does not repeat verdicts the next day when nothing new settled', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    await enqueueImage();
    const { run, received } = runner();

    await run(at(12));
    await run(new Date('2026-12-18T09:30:00Z'));

    expect(received().get(1)).toEqual(['verdicts', 'new-images']);
  });

  it('announces verdicts again the next day when the first send was never confirmed', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(1);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timedOut = vi.fn().mockRejectedValue(new Error('timeout'));

    await sendNotifications(db, { now: at(12), send: timedOut, accessible: everyone });
    const { run, received } = runner();
    await run(at(13));
    expect(received().size).toBe(0);

    await run(new Date('2026-12-18T09:30:00Z'));
    expect(received().get(1)).toEqual(['verdicts']);
  });

  it('stops sending after the first batch whose outcome is unknown', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await seedSettledVote(1);
    await optOut(2, 'verdicts');
    await enqueueImage();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timedOut = vi.fn().mockRejectedValue(new Error('timeout'));

    const first = await sendNotifications(db, {
      now: at(12),
      send: timedOut,
      accessible: everyone,
    });

    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ halted: true, unconfirmed: 1 });

    const { run, received } = runner();
    await run(at(13));
    expect(received().get(2)).toEqual(['new-images']);
    expect(received().has(1)).toBe(false);
  });

  it('gives the day back when the notifications app refuses a batch, and retries it under the same key', async () => {
    await seedPlayer(pg, 1);
    await enqueueImage();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refusing = vi.fn().mockRejectedValue(new BatchRejected('bad request'));

    const first = await sendNotifications(db, { now: at(9), send: refusing, accessible: everyone });
    expect(first).toMatchObject({ failed: 1, unconfirmed: 0 });

    const { run, received, send } = runner();
    await run(at(10));
    expect(received().get(1)).toEqual(['new-images']);
    expect(send.mock.calls[0]![0].key).toBe(refusing.mock.calls[0]![0].key);
  });

  it('keeps the day when the outcome of a send is unknown, so a retry cannot double-send', async () => {
    await seedPlayer(pg, 1);
    await enqueueImage();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timedOut = vi.fn().mockRejectedValue(new Error('timeout'));

    const first = await sendNotifications(db, { now: at(9), send: timedOut, accessible: everyone });
    expect(first).toMatchObject({ failed: 0, unconfirmed: 1 });

    const { run, received } = runner();
    await run(at(10));
    expect(received().size).toBe(0);
  });

  it('notifies only players who can open the app', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await enqueueImage();
    const { run, received } = runner({ blocked: [2] });

    await run(at(12));

    expect([...received().keys()]).toEqual([1]);
  });
});
