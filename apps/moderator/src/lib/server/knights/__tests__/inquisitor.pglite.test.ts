import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, replica, setLevel } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  replica: { allowed: false },
  setLevel: vi.fn(),
}));

vi.mock('../../db', () => ({
  get dbRead() {
    if (!replica.allowed) {
      throw new Error('the Inquisitor queue must read from the primary, not the replica');
    }
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../image-nsfw-level', () => ({ updateImageNsfwLevel: setLevel }));

const {
  countInquisitorQueue,
  countInquisitorQueueByFilter,
  getInquisitorQueue,
  ruleOnInquisitorItem,
  RULING_LEASE_MS,
} = await import('../inquisitor.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

const Q = 'knights.image.nsfwLevel';
const MOD = 7;

let db: PGlite;

const insertItem = (
  id: number,
  imageId: number,
  status: string,
  questionKey = Q,
  priority = 2,
  {
    reason = 'blocked',
    escalationReason = null,
  }: { reason?: string | null; escalationReason?: string | null } = {}
) =>
  db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","priority","status","reason","escalationReason","createdAt")
     VALUES ($1,$2,$3,'scan-sample',$4,5,$5,$6,$7,$8, now() + ($1::int * interval '1 second'))`,
    [
      id,
      questionKey,
      imageId,
      status === 'Inquisitor' ? 'Inquisitor' : 'Knight',
      priority,
      status,
      reason,
      escalationReason,
    ]
  );

const insertVote = (
  itemId: number,
  playerId: number,
  answer: string,
  weight: number,
  verdict = 'pending',
  blockReason: string | null = null,
  second = playerId,
  stage = 'Knight'
) =>
  db.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","questionKey","imageId","stage","answer","weight","verdict","blockReason","createdAt")
     VALUES ($1,$2,$3,1,$9,$4,$5,$6,$7, TIMESTAMP '2026-12-27 12:00:00' + ($8::int * interval '1 second'))`,
    [itemId, playerId, Q, answer, weight, verdict, blockReason, second, stage]
  );

const verdicts = async (itemId: number) =>
  (
    await db.query<{ playerId: number; verdict: string }>(
      `SELECT "playerId","verdict" FROM "KnightsVote" WHERE "itemId" = $1 ORDER BY "playerId"`,
      [itemId]
    )
  ).rows;

const item = async (id: number) =>
  (
    await db.query<{
      status: string;
      resolvedValue: string | null;
      resolvedBy: number | null;
      reason: string | null;
      appliedAt: string | null;
    }>(
      `SELECT "status","resolvedValue","resolvedBy","reason","appliedAt"::text FROM "KnightsQueueItem" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "Image" (
    "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false,
    "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT
  );`);
  await db.exec(migration('20261210120000_knights_v2_tables'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  replica.allowed = false;
  setLevel.mockResolvedValue(undefined);
  await db.exec(`DELETE FROM "KnightsVote"; DELETE FROM "KnightsQueueItem"; DELETE FROM "Image";`);
  await db.exec(
    `INSERT INTO "Image" ("id","url","name","type","nsfwLevel","nsfwLevelLocked") VALUES
      (1,'k1','a.png','image',4,false), (2,'k2','b.mp4','video',1,true), (3,'k3',NULL,'image',2,false)`
  );
});

describe('getInquisitorQueue', () => {
  it('lists only rating items waiting on the Inquisitors, each with its votes by answer', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertItem(2, 2, 'Open');
    await insertItem(3, 3, 'Resolved');
    await db.query(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('other.q','bool','Is it?','[]'::jsonb)`
    );
    await insertItem(4, 3, 'Inquisitor', 'other.q');
    await insertVote(1, 11, '8', 1);
    await insertVote(1, 12, '8', 1.5);
    await insertVote(1, 13, '2', 2);

    const queue = await getInquisitorQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 1,
      imageId: 1,
      imageKey: 'k1',
      currentLevel: 4,
      locked: false,
      reason: 'blocked',
      source: 'scan-sample',
      prompt: 'How should this image be rated?',
    });
    expect(queue[0].votes).toEqual([
      { answer: '8', label: 'X', votes: 2, weight: 2.5, stages: [{ stage: 'Knight', votes: 2 }] },
      { answer: '2', label: 'PG-13', votes: 1, weight: 2, stages: [{ stage: 'Knight', votes: 1 }] },
    ]);
  });

  it('breaks each answer down by the stage it was voted at, lowest stage first', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1, 'pending', null, 11, 'Paladin');
    await insertVote(1, 12, '8', 1, 'pending', null, 12, 'Knight');
    await insertVote(1, 13, '8', 1, 'pending', null, 13, 'Knight');
    await insertVote(1, 14, '2', 1, 'pending', null, 14, 'Templar');

    const [item] = await getInquisitorQueue();

    expect(item.votes.find((vote) => vote.answer === '8')?.stages).toEqual([
      { stage: 'Knight', votes: 2 },
      { stage: 'Paladin', votes: 1 },
    ]);
    expect(item.votes.find((vote) => vote.answer === '2')?.stages).toEqual([
      { stage: 'Templar', votes: 1 },
    ]);
  });

  it('serves higher-priority items first, then the oldest', async () => {
    await insertItem(1, 1, 'Inquisitor', Q, 2);
    await insertItem(2, 2, 'Inquisitor', Q, 1);
    await insertItem(3, 3, 'Inquisitor', Q, 2);

    expect((await getInquisitorQueue()).map((i) => i.id)).toEqual([2, 1, 3]);
  });
});

describe('Inquisitor queue filters', () => {
  const ID = { blocked: 1, pushedDown: 2, noConsensus: 3, writeBack: 4, neither: 5, notWaiting: 6 };

  beforeEach(async () => {
    await db.exec(`INSERT INTO "Image" ("id","url") VALUES (4,'k4'), (5,'k5'), (6,'k6')`);
    await insertItem(ID.blocked, 1, 'Inquisitor', Q, 2, {
      reason: null,
      escalationReason: 'blocked',
    });
    await insertItem(ID.pushedDown, 2, 'Inquisitor', Q, 2, {
      reason: null,
      escalationReason: 'pushed-down',
    });
    await insertItem(ID.noConsensus, 3, 'Inquisitor', Q, 2, {
      reason: null,
      escalationReason: 'no-consensus',
    });
    await insertItem(ID.writeBack, 4, 'Inquisitor', Q, 2, { reason: 'level-moved' });
    await insertItem(ID.neither, 5, 'Inquisitor', Q, 2, { reason: null });
    await insertItem(ID.notWaiting, 6, 'Open', Q, 2, { reason: null, escalationReason: 'blocked' });
  });

  it.each([
    ['all', [ID.blocked, ID.pushedDown, ID.noConsensus, ID.writeBack, ID.neither]],
    ['blocked', [ID.blocked]],
    ['pushed-down', [ID.pushedDown]],
    ['no-consensus', [ID.noConsensus]],
    ['write-back', [ID.writeBack]],
  ] as const)('lists exactly the %s items', async (filter, ids) => {
    expect((await getInquisitorQueue(filter)).map((i) => i.id)).toEqual(ids);
  });

  it('shows an item with neither reason under All only', async () => {
    for (const filter of ['blocked', 'pushed-down', 'no-consensus', 'write-back'] as const) {
      expect((await getInquisitorQueue(filter)).map((i) => i.id)).not.toContain(ID.neither);
    }
  });

  it('counts each filter from the same rows it lists, with All equal to the sidebar badge', async () => {
    replica.allowed = true;
    const counts = await countInquisitorQueueByFilter();

    expect(counts).toEqual({
      all: 5,
      blocked: 1,
      'pushed-down': 1,
      'no-consensus': 1,
      'write-back': 1,
    });
    expect(counts.all).toBe(await countInquisitorQueue());
    expect((await getInquisitorQueue()).map((i) => i.escalationReason)).toEqual([
      'blocked',
      'pushed-down',
      'no-consensus',
      null,
      null,
    ]);
  });
});

describe('getInquisitorQueue block reason', () => {
  it('shows the reason most Blocked votes gave, and nothing when none gave one', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertItem(2, 2, 'Inquisitor');
    await insertVote(1, 11, '32', 1, 'pending', 'Other');
    await insertVote(1, 12, '32', 1, 'pending', 'DepictsRealPerson');
    await insertVote(1, 13, '32', 1, 'pending', 'DepictsRealPerson');
    await insertVote(1, 14, '4', 1);
    await insertVote(2, 21, '32', 1);

    const [first, second] = await getInquisitorQueue();

    expect(first.blockReason).toEqual({
      reason: 'DepictsRealPerson',
      label: 'Depicts Real Person',
      count: 2,
      of: 3,
    });
    expect(second.blockReason).toBeNull();
  });
});

describe('getInquisitorQueue held votes', () => {
  it('counts only votes that carry weight, in the tallies and in the Blocked reason', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '4', 1);
    await insertVote(1, 12, '32', 1, 'pending', 'Other');
    await insertVote(1, 13, '32', 0, 'pending', 'DepictsRealPerson');
    await insertVote(1, 14, '32', 0, 'pending', 'DepictsRealPerson');
    await insertVote(1, 15, '8', 0);

    const [only] = await getInquisitorQueue();

    expect(only.votes.map((v) => [v.answer, v.votes])).toEqual([
      ['32', 1],
      ['4', 1],
    ]);
    expect(only.blockReason).toEqual({ reason: 'Other', label: 'Other', count: 1, of: 1 });
  });
});

describe('getInquisitorQueue block markers', () => {
  it('marks an image that is blocked or carries a block reason', async () => {
    await db.query(`UPDATE "Image" SET "ingestion"='Blocked', "blockedFor"='tos' WHERE id=1`);
    await db.query(`UPDATE "Image" SET "blockedFor"='csam' WHERE id=2`);
    await insertItem(1, 1, 'Inquisitor');
    await insertItem(2, 2, 'Inquisitor');
    await insertItem(3, 3, 'Inquisitor');

    const queue = await getInquisitorQueue();

    expect(queue.map((i) => [i.id, i.hasBlockMarker, i.blockedFor])).toEqual([
      [1, true, 'tos'],
      [2, true, 'csam'],
      [3, false, null],
    ]);
  });
});

describe('ruleOnInquisitorItem', () => {
  it('sets the image through the moderator path, closes the item and grades pending votes against the ruling', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1);
    await insertVote(1, 12, '2', 1);
    await insertVote(1, 13, '8', 1, 'inconclusive');

    expect(await ruleOnInquisitorItem(1, 8, MOD)).toEqual({ ok: true });

    expect(setLevel).toHaveBeenCalledWith({ id: 1, nsfwLevel: 8, userId: MOD });
    expect(await item(1)).toMatchObject({
      status: 'Closed',
      resolvedValue: '8',
      resolvedBy: MOD,
      reason: 'moderator-ruled',
    });
    expect((await item(1)).appliedAt).not.toBeNull();
    expect(await verdicts(1)).toEqual([
      { playerId: 11, verdict: 'correct' },
      { playerId: 12, verdict: 'failed' },
      { playerId: 13, verdict: 'inconclusive' },
    ]);
  });

  it('counts a Blocked ruling like any other level', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '32', 1);
    await insertVote(1, 12, '4', 1);

    expect(await ruleOnInquisitorItem(1, 32, MOD)).toEqual({ ok: true });

    expect(setLevel).toHaveBeenCalledWith({ id: 1, nsfwLevel: 32, userId: MOD });
    expect(await verdicts(1)).toEqual([
      { playerId: 11, verdict: 'correct' },
      { playerId: 12, verdict: 'failed' },
    ]);
  });

  it.each([['Open'], ['Resolved'], ['Closed']])('refuses an item that is %s', async (status) => {
    await insertItem(1, 1, status);
    await insertVote(1, 11, '8', 1);

    const outcome = await ruleOnInquisitorItem(1, 8, MOD);

    expect(outcome.ok).toBe(false);
    expect(setLevel).not.toHaveBeenCalled();
    expect((await item(1)).status).toBe(status);
    expect((await verdicts(1))[0].verdict).toBe('pending');
  });

  it('refuses a level that is not a rating, and a second ruling on the same item', async () => {
    await insertItem(1, 1, 'Inquisitor');

    expect((await ruleOnInquisitorItem(1, 3, MOD)).ok).toBe(false);
    expect(setLevel).not.toHaveBeenCalled();

    expect(await ruleOnInquisitorItem(1, 4, MOD)).toEqual({ ok: true });
    expect((await ruleOnInquisitorItem(1, 8, MOD)).ok).toBe(false);
    expect(setLevel).toHaveBeenCalledTimes(1);
  });

  it('leaves the item with the Inquisitors and votes pending when the rating cannot be set', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1);
    setLevel.mockRejectedValue(new Error('Image not found'));

    await expect(ruleOnInquisitorItem(1, 8, MOD)).rejects.toThrow('Image not found');

    expect((await item(1)).status).toBe('Inquisitor');
    expect((await verdicts(1))[0].verdict).toBe('pending');
  });

  it('refuses a second moderator while the first ruling is still being applied, before any rating write', async () => {
    await insertItem(1, 1, 'Inquisitor');
    let finish: () => void = () => undefined;
    setLevel.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));

    const first = ruleOnInquisitorItem(1, 8, MOD);
    await vi.waitFor(() => expect(setLevel).toHaveBeenCalledTimes(1));
    const second = await ruleOnInquisitorItem(1, 2, MOD + 1);

    expect(second).toEqual({ ok: false, error: expect.stringContaining('Another moderator') });
    expect(setLevel).toHaveBeenCalledTimes(1);

    finish();
    expect(await first).toEqual({ ok: true });
    expect(await item(1)).toMatchObject({ status: 'Closed', resolvedValue: '8', resolvedBy: MOD });
  });

  it('lets a ruling retry once the claim of a ruling that never finished has lapsed', async () => {
    await insertItem(1, 1, 'Ruling');
    const claimedAt = new Date('2030-01-01T00:00:00Z');
    await db.query(
      `UPDATE "KnightsQueueItem" SET "resolvedBy" = 99, "nextAttemptAt" = $1::timestamp WHERE id = 1`,
      [new Date(claimedAt.getTime() + RULING_LEASE_MS).toISOString()]
    );

    expect((await ruleOnInquisitorItem(1, 4, MOD, claimedAt)).ok).toBe(false);
    expect(setLevel).not.toHaveBeenCalled();

    const later = new Date(claimedAt.getTime() + RULING_LEASE_MS + 1);
    expect(await ruleOnInquisitorItem(1, 4, MOD, later)).toEqual({ ok: true });
    expect(await item(1)).toMatchObject({ status: 'Closed', resolvedBy: MOD });
  });

  it('closes for the claim holder even after its lease lapsed, while nobody else has re-claimed', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1);
    const claimedAt = new Date('2030-01-01T00:00:00Z');
    setLevel.mockImplementationOnce(async () => {
      await db.query(`UPDATE "KnightsQueueItem" SET "nextAttemptAt" = $1::timestamp WHERE id = 1`, [
        new Date(claimedAt.getTime() - 1).toISOString(),
      ]);
    });

    expect(await ruleOnInquisitorItem(1, 8, MOD, claimedAt)).toEqual({ ok: true });

    expect(await item(1)).toMatchObject({ status: 'Closed', resolvedBy: MOD });
    expect((await verdicts(1))[0].verdict).toBe('correct');
  });

  it('tells the first moderator the rating was applied when a lapsed claim was re-claimed meanwhile', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1);
    const finish: Array<() => void> = [];
    const hang = () => new Promise<void>((resolve) => finish.push(resolve));
    setLevel.mockImplementationOnce(hang).mockImplementationOnce(hang);
    const claimedAt = new Date('2030-01-01T00:00:00Z');

    const first = ruleOnInquisitorItem(1, 8, MOD, claimedAt);
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    const second = ruleOnInquisitorItem(
      1,
      2,
      MOD + 1,
      new Date(claimedAt.getTime() + RULING_LEASE_MS + 1)
    );
    await vi.waitFor(() => expect(finish).toHaveLength(2));

    finish[0]();
    expect(await first).toEqual({
      ok: false,
      error: expect.stringContaining('now being decided by another moderator'),
    });
    expect(await item(1)).toMatchObject({ status: 'Ruling', resolvedBy: MOD + 1 });

    finish[1]();
    expect(await second).toEqual({ ok: true });
    expect(await item(1)).toMatchObject({ status: 'Closed', resolvedValue: '2' });
  });

  it('releases the claim when the rating cannot be set, so another moderator can rule', async () => {
    await insertItem(1, 1, 'Inquisitor');
    setLevel.mockRejectedValueOnce(new Error('Image not found'));

    await expect(ruleOnInquisitorItem(1, 8, MOD)).rejects.toThrow('Image not found');

    expect(await item(1)).toMatchObject({ status: 'Inquisitor', resolvedBy: null });
    expect(await ruleOnInquisitorItem(1, 8, MOD + 1)).toEqual({ ok: true });
  });

  it('says the rating was applied when the item cannot be closed, and the same level can be ruled again', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '8', 1);
    await db.exec(`
      CREATE FUNCTION refuse_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'close failed'; END $$;
      CREATE TRIGGER refuse_close BEFORE UPDATE ON "KnightsQueueItem"
        FOR EACH ROW WHEN (NEW."status" = 'Closed') EXECUTE FUNCTION refuse_close();
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await ruleOnInquisitorItem(1, 8, MOD);

      expect(outcome).toEqual({
        ok: false,
        error: expect.stringContaining('The rating was applied but the item was not closed'),
      });
      expect(setLevel).toHaveBeenCalledTimes(1);
      expect(await item(1)).toMatchObject({ status: 'Inquisitor' });
      expect((await verdicts(1))[0].verdict).toBe('pending');
    } finally {
      await db.exec(
        `DROP TRIGGER refuse_close ON "KnightsQueueItem"; DROP FUNCTION refuse_close();`
      );
    }

    expect(await ruleOnInquisitorItem(1, 8, MOD)).toEqual({ ok: true });
    expect(setLevel).toHaveBeenCalledTimes(2);
    expect((await verdicts(1))[0].verdict).toBe('correct');
  });

  it('refuses a rating below Blocked on a block-marked image and leaves it with the Inquisitors', async () => {
    await db.query(`UPDATE "Image" SET "blockedFor"='tos' WHERE id=1`);
    await insertItem(1, 1, 'Inquisitor');

    const outcome = await ruleOnInquisitorItem(1, 4, MOD);

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('blocked') });
    expect(setLevel).not.toHaveBeenCalled();
    expect(await item(1)).toMatchObject({ status: 'Inquisitor', resolvedBy: null });

    expect(await ruleOnInquisitorItem(1, 32, MOD)).toEqual({ ok: true });
    expect(setLevel).toHaveBeenCalledWith({ id: 1, nsfwLevel: 32, userId: MOD });
    expect(await item(1)).toMatchObject({ status: 'Closed', resolvedValue: '32' });
  });

  it.each([
    ['ingestion is Blocked', `"ingestion"='Blocked'`],
    ['it carries a block reason', `"blockedFor"='tos'`],
  ])('closes a Blocked ruling on a block-marked image whose %s', async (_name, assignment) => {
    await db.query(`UPDATE "Image" SET ${assignment} WHERE id=1`);
    await insertItem(1, 1, 'Inquisitor');
    await insertVote(1, 11, '32', 1);

    expect(await ruleOnInquisitorItem(1, 32, MOD)).toEqual({ ok: true });

    expect((await verdicts(1))[0].verdict).toBe('correct');
  });
});

describe('countInquisitorQueue', () => {
  beforeEach(() => {
    replica.allowed = true;
  });

  it('counts exactly what the page lists', async () => {
    await insertItem(1, 1, 'Inquisitor');
    await insertItem(2, 2, 'Inquisitor');
    await insertItem(3, 3, 'Open');
    await db.query(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('other.q','bool','Is it?','[]'::jsonb)
       ON CONFLICT DO NOTHING`
    );
    await insertItem(4, 3, 'Inquisitor', 'other.q');
    // Image 99 does not exist: the inner join drops it from page and count alike.
    await insertItem(5, 99, 'Inquisitor');

    expect(await countInquisitorQueue()).toBe(2);
    expect(await countInquisitorQueue()).toBe((await getInquisitorQueue()).length);
  });

  it('is zero when nothing waits', async () => {
    expect(await countInquisitorQueue()).toBe(0);
  });
});
