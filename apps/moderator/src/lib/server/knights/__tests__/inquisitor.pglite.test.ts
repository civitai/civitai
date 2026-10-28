import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, setLevel } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  setLevel: vi.fn(),
}));

vi.mock('../../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../image-nsfw-level', () => ({ updateImageNsfwLevel: setLevel }));

const { getInquisitorQueue, ruleOnInquisitorItem } = await import('../inquisitor.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

const Q = 'knights.image.nsfwLevel';
const MOD = 7;

let db: PGlite;

const insertItem = (id: number, imageId: number, status: string, questionKey = Q, priority = 2) =>
  db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","priority","status","reason","createdAt")
     VALUES ($1,$2,$3,'scan-sample',$4,5,$5,$6,'blocked', now() + ($1::int * interval '1 second'))`,
    [id, questionKey, imageId, status === 'Inquisitor' ? 'Inquisitor' : 'Knight', priority, status]
  );

const insertVote = (
  itemId: number,
  playerId: number,
  answer: string,
  weight: number,
  verdict = 'pending'
) =>
  db.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","questionKey","imageId","stage","answer","weight","verdict")
     VALUES ($1,$2,$3,1,'Knight',$4,$5,$6)`,
    [itemId, playerId, Q, answer, weight, verdict]
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
    "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false
  );`);
  await db.exec(migration('20261210120000_knights_v2_queue'));
  await db.exec(migration('20261211120000_knights_v2_sources'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
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
      { answer: '8', label: 'X', votes: 2, weight: 2.5 },
      { answer: '2', label: 'PG-13', votes: 1, weight: 2 },
    ]);
  });

  it('serves higher-priority items first, then the oldest', async () => {
    await insertItem(1, 1, 'Inquisitor', Q, 2);
    await insertItem(2, 2, 'Inquisitor', Q, 1);
    await insertItem(3, 3, 'Inquisitor', Q, 2);

    expect((await getInquisitorQueue()).map((i) => i.id)).toEqual([2, 1, 3]);
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
});
