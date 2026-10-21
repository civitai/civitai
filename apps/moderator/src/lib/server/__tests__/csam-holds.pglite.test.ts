import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsamHoldQuery } from '../csam-holds.queries';
import { PREVIEW_COUNT_CAP } from '../../minor-flags/model-detail';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, callModEndpoint } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  callModEndpoint: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../user-actions.service', () => ({ callModEndpoint }));

const {
  countCsamHoldsByType,
  countPendingCsamHolds,
  decideCsamHold,
  getHoldCoverImages,
  listCsamHolds,
} = await import('../csam-holds.service');

const OLDEST_PENDING: CsamHoldQuery = {
  status: 'pending',
  sort: 'oldest',
  limit: 10,
  offset: 0,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '20261016150000_text_scan_hold',
  '20261112120000_text_scan_hold_one_pending',
].map((name) =>
  readFileSync(
    join(
      HERE,
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf-8'
  )
);

let db: PGlite;

type Seed = {
  id: number;
  entityType?: string;
  label?: string;
  status?: string;
  userId?: number | null;
  createdAt: string;
  meta?: unknown;
  decidedById?: number;
  decidedAt?: string;
  decisionNote?: string;
};

const seed = (rows: Seed[]) =>
  Promise.all(
    rows.map((r) =>
      db.query(
        `INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","status","userId",
           "text","reason","createdAt","updatedAt","meta","decidedById","decidedAt","decisionNote")
         VALUES ($1,$2,$3,$4,$5,$6::"TextScanHoldStatus",$7,'neutral text','neutral reason',$8,$8,$9::jsonb,
           $10,$11,$12)`,
        [
          r.id,
          r.entityType ?? 'Post',
          r.id * 10,
          r.label ?? 'csam',
          `h-${r.id}`,
          r.status ?? 'Pending',
          r.userId === undefined ? 10 : r.userId,
          r.createdAt,
          r.meta === undefined ? null : JSON.stringify(r.meta),
          r.decidedById ?? null,
          r.decidedAt ?? null,
          r.decisionNote ?? null,
        ]
      )
    )
  );

beforeEach(async () => {
  db = await freshPglite();
  for (const migration of MIGRATIONS) await db.exec(migration);
  await db.exec(`CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT)`);
  await db.query(`INSERT INTO "User" ("id","username") VALUES (10,'author'), (11,'Mod_Person')`);
  await db.exec(`
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "title" TEXT, "publishedAt" TIMESTAMP,
      "userId" INTEGER, "modelVersionId" INTEGER);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL,
      "userId" INTEGER);
    CREATE TABLE "ModelVersion" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "type" TEXT NOT NULL,
      "postId" INTEGER, "index" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
      "minor" BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false);
    INSERT INTO "Image" ("id","url","type","postId","index","nsfwLevel") VALUES
      (1, 'k-a', 'image', 10, 2, 4), (2, 'k-b', 'image', 10, 1, 1), (3, 'k-c', 'video', 10, 0, 1),
      (4, 'k-d', 'image', 10, 3, 1), (5, 'k-e', 'image', 10, 4, 1), (6, 'k-f', 'image', 10, 5, 1),
      (7, 'k-g', 'image', 60, 0, 1);
    UPDATE "Image" SET "minor" = true WHERE id = 2;
    UPDATE "Image" SET "acceptableMinor" = true WHERE id = 1;
    INSERT INTO "Post" VALUES (10, 'A post title', '2026-10-01'), (60, NULL, NULL);
    INSERT INTO "Model" VALUES (70, 'A model name', 'Published');
  `);
  await seed([
    { id: 1, createdAt: '2026-10-03' },
    { id: 2, createdAt: '2026-10-01', entityType: 'ChatMessage', meta: { chatId: 77 } },
    { id: 3, createdAt: '2026-10-02', userId: 404 },
    {
      id: 4,
      createdAt: '2026-09-01',
      status: 'Dismissed',
      decidedById: 11,
      decidedAt: '2026-09-05',
      decisionNote: 'fine',
      meta: { decision: 'dismiss' },
    },
    { id: 5, createdAt: '2026-09-02', label: 'scam' },
    { id: 6, createdAt: '2026-10-04', userId: null },
    {
      id: 7,
      createdAt: '2026-09-10',
      entityType: 'Model',
      status: 'Confirmed',
      decidedById: 11,
      decidedAt: '2026-09-11',
      meta: { decision: 'remove_ban' },
    },
  ]);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('listCsamHolds', () => {
  it('titles a held post or model with the content it points at, and leaves other types untitled', async () => {
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'all' });
    const byId = new Map(items.map((h) => [h.id, h]));
    expect(byId.get(1)?.title).toBe('A post title');
    expect(byId.get(7)?.title).toBe('A model name');
    // No row behind the id, an untitled post, and a chat message all fall back to null.
    expect(byId.get(3)?.title).toBeNull();
    expect(byId.get(6)?.title).toBeNull();
    expect(byId.get(2)?.title).toBeNull();
  });

  it('says whether the held content is still live: true, false, or unknown for types without a state', async () => {
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'all' });
    const byId = new Map(items.map((h) => [h.id, h]));
    expect(byId.get(1)?.live).toBe(true);
    expect(byId.get(7)?.live).toBe(true);
    expect(byId.get(6)?.live).toBe(false);
    expect(byId.get(3)?.live).toBe(false);
    expect(byId.get(2)?.live).toBeNull();
  });

  it('says a held model whose row is gone is not live', async () => {
    await seed([{ id: 8, createdAt: '2026-10-05', entityType: 'Model' }]);
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, search: { id: 80 } });
    expect(items.map((h) => [h.id, h.live])).toEqual([[8, false]]);
  });

  it('lists only pending csam holds, oldest first', async () => {
    const { items, hasMore } = await listCsamHolds(OLDEST_PENDING);
    expect(items.map((h) => h.id)).toEqual([2, 3, 1, 6]);
    expect(hasMore).toBe(false);
  });

  it('names the author, and leaves the name null when the account is gone', async () => {
    const { items } = await listCsamHolds(OLDEST_PENDING);
    const byId = new Map(items.map((h) => [h.id, h]));
    expect(byId.get(1)).toMatchObject({ userId: 10, username: 'author' });
    expect(byId.get(3)).toMatchObject({ userId: 404, username: null });
    expect(byId.get(6)).toMatchObject({ userId: null, username: null });
  });

  it('carries the chat id of a held chat message', async () => {
    const { items } = await listCsamHolds(OLDEST_PENDING);
    expect(items.find((h) => h.id === 2)?.chatId).toBe(77);
    expect(items.find((h) => h.id === 1)?.chatId).toBeNull();
  });

  it('pages, and says when more remain', async () => {
    const first = await listCsamHolds({ ...OLDEST_PENDING, limit: 2 });
    expect(first.items.map((h) => h.id)).toEqual([2, 3]);
    expect(first.hasMore).toBe(true);
    const second = await listCsamHolds({ ...OLDEST_PENDING, limit: 2, offset: 2 });
    expect(second.items.map((h) => h.id)).toEqual([1, 6]);
    expect(second.hasMore).toBe(false);
  });

  it('narrows to one entity type', async () => {
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, entityType: 'ChatMessage' });
    expect(items.map((h) => h.id)).toEqual([2]);
  });

  const idsFor = async (query: Partial<CsamHoldQuery>) =>
    (await listCsamHolds({ ...OLDEST_PENDING, ...query })).items.map((h) => h.id);

  it('filters by decision status', async () => {
    expect(await idsFor({ status: 'removed' })).toEqual([7]);
    expect(await idsFor({ status: 'dismissed' })).toEqual([4]);
    expect(await idsFor({ status: 'all' })).toEqual([4, 7, 2, 3, 1, 6]);
  });

  it('sorts newest first', async () => {
    expect(await idsFor({ sort: 'newest' })).toEqual([6, 1, 3, 2]);
  });

  it('searches a number as a content id or an author id', async () => {
    expect(await idsFor({ search: { id: 60 } })).toEqual([6]);
    expect(await idsFor({ search: { id: 404 } })).toEqual([3]);
    expect(await idsFor({ search: { id: 10 } })).toEqual([2, 1]);
    expect(await idsFor({ search: { id: 1 } })).toEqual([]);
  });

  it('searches a username by case-insensitive exact name or prefix', async () => {
    expect(await idsFor({ search: { username: 'AUTHOR' } })).toEqual([2, 1]);
    expect(await idsFor({ search: { username: 'auth' } })).toEqual([2, 1]);
    expect(await idsFor({ search: { username: 'thor' } })).toEqual([]);
  });

  it('takes a % in the search as a literal character', async () => {
    expect(await idsFor({ search: { username: '%' } })).toEqual([]);
  });

  it('names who decided, when, what and why', async () => {
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'dismissed' });
    expect(items[0]).toMatchObject({
      status: 'Dismissed',
      decidedByUsername: 'Mod_Person',
      decisionNote: 'fine',
      decision: 'dismiss',
    });
    expect(items[0].decidedAt).toBeInstanceOf(Date);
    const [pending] = (await listCsamHolds(OLDEST_PENDING)).items;
    expect(pending).toMatchObject({ decidedAt: null, decidedByUsername: null, decision: null });
  });
});

describe('re-detected holds', () => {
  it('carries the text hash the decision must echo back', async () => {
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'all' });
    expect(items.find((h) => h.id === 1)?.textHash).toBe('h-1');
  });

  it('marks a re-detection and names the ruling it follows, even when that hold is gone from the list', async () => {
    await seed([
      {
        id: 8,
        createdAt: '2026-10-06',
        meta: { kind: 'redetected', priorHoldId: 4, contentAt: '2026-10-05T00:00:00.000Z' },
      },
    ]);
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'pending' });
    expect(items.find((h) => h.id === 8)).toMatchObject({
      redetected: true,
      priorHoldId: 4,
      priorStatus: 'Dismissed',
      priorDecidedByUsername: 'Mod_Person',
    });
    expect(items.find((h) => h.id === 8)?.priorDecidedAt).toBeInstanceOf(Date);
    expect(items.find((h) => h.id === 1)).toMatchObject({
      redetected: false,
      priorHoldId: null,
      priorStatus: null,
      priorDecidedByUsername: null,
    });
  });

  it('survives a prior id that points nowhere or is not a number', async () => {
    await seed([
      { id: 8, createdAt: '2026-10-06', meta: { kind: 'redetected', priorHoldId: 999 } },
      { id: 9, createdAt: '2026-10-07', meta: { kind: 'redetected', priorHoldId: 'x' } },
    ]);
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'pending' });
    expect(items.find((h) => h.id === 8)).toMatchObject({ redetected: true, priorStatus: null });
    expect(items.find((h) => h.id === 9)).toMatchObject({ redetected: false, priorHoldId: null });
  });

  it('reads a hold the migration superseded as decided by nobody', async () => {
    await seed([
      {
        id: 8,
        createdAt: '2026-10-06',
        status: 'Dismissed',
        decidedAt: '2026-10-07',
        meta: { decision: 'superseded', superseded: true, supersededBy: 1 },
      },
    ]);
    const { items } = await listCsamHolds({ ...OLDEST_PENDING, status: 'dismissed' });
    expect(items.find((h) => h.id === 8)).toMatchObject({
      decision: 'superseded',
      decidedByUsername: null,
    });
  });
});

describe('countCsamHoldsByType', () => {
  it('counts per entity type for one status', async () => {
    expect(await countCsamHoldsByType({ status: 'pending' })).toEqual({ Post: 3, ChatMessage: 1 });
    expect(await countCsamHoldsByType({ status: 'removed' })).toEqual({ Model: 1 });
    expect(await countCsamHoldsByType({ status: 'all' })).toEqual({
      Post: 4,
      ChatMessage: 1,
      Model: 1,
    });
  });

  it('follows the search', async () => {
    expect(
      await countCsamHoldsByType({ status: 'pending', search: { username: 'author' } })
    ).toEqual({ Post: 1, ChatMessage: 1 });
  });
});

describe('countPendingCsamHolds', () => {
  it('counts what the queue lists', async () => {
    expect(await countPendingCsamHolds()).toBe(4);
    expect(await countPendingCsamHolds('ChatMessage')).toBe(1);
  });
});

describe('decideCsamHold', () => {
  it('asks the main app to dismiss the hold', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { holdId: 3, status: 'Dismissed' } });
    expect(
      await decideCsamHold({ holdId: 3, textHash: 'h-3', decision: 'dismiss', note: 'fine' })
    ).toEqual({
      ok: true,
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'text-scan/csam-hold/resolve',
      { holdId: 3, textHash: 'h-3', decision: 'dismiss', note: 'fine' },
      expect.any(String)
    );
  });

  it.each(['remove', 'remove_strike', 'remove_ban', 'remove_ban_report'] as const)(
    'sends %s to the main app and expects the hold Confirmed',
    async (decision) => {
      callModEndpoint.mockResolvedValue({ ok: true, body: { holdId: 3, status: 'Confirmed' } });
      expect(await decideCsamHold({ holdId: 3, textHash: 'h-3', decision })).toEqual({ ok: true });
      expect(callModEndpoint).toHaveBeenCalledWith(
        'text-scan/csam-hold/resolve',
        { holdId: 3, textHash: 'h-3', decision },
        expect.any(String)
      );
    }
  );

  it('passes the main app refusal through', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Decide hold: already decided',
      status: 409,
    });
    expect(await decideCsamHold({ holdId: 3, textHash: 'h-3', decision: 'remove' })).toEqual({
      ok: false,
      error: 'Decide hold: already decided',
    });
  });

  it('passes a request that never left through as a plain failure', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Decide hold failed.',
      requestNeverSent: true,
    });
    expect(await decideCsamHold({ holdId: 3, textHash: 'h-3', decision: 'remove' })).toEqual({
      ok: false,
      error: 'Decide hold failed.',
    });
  });

  it('says the decision may have completed when the response was lost', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Decide hold failed.',
      requestNeverSent: false,
    });
    const result = await decideCsamHold({ holdId: 3, textHash: 'h-3', decision: 'remove_ban' });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/may already have completed.*reload/i);
  });

  it.each([
    ['a removal reported as dismissed', 'remove', 'Dismissed'],
    ['a dismissal reported as confirmed', 'dismiss', 'Confirmed'],
    ['a success with no status', 'remove', undefined],
  ] as const)('treats %s as a failure', async (_, decision, status) => {
    callModEndpoint.mockResolvedValue({ ok: true, body: status ? { status } : {} });
    expect(await decideCsamHold({ holdId: 3, textHash: 'h-3', decision })).toMatchObject({
      ok: false,
    });
  });
});

describe('getHoldCoverImages', () => {
  const hold = (id: number, entityType: string, entityId: number) => ({ id, entityType, entityId });

  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (71, 'Owned', 'Published', 10), (72, 'Drafty', 'Draft', 10),
        (73, 'Bare', 'Published', 10);
      INSERT INTO "ModelVersion" VALUES (710, 71, 1), (711, 71, 0), (720, 72, 0), (721, 72, 1),
        (730, 73, 0);
      INSERT INTO "Post" VALUES
        (801, NULL, '2026-10-01', 10, 710), (802, NULL, '2026-10-01', 10, 711),
        (803, NULL, '2026-10-01', 11, 711),
        (804, NULL, NULL, 10, 720), (805, NULL, '2026-10-01', 10, 721),
        (806, NULL, '2026-10-01', 11, 730);
      INSERT INTO "Image" ("id","url","type","postId","index","nsfwLevel") VALUES
        (90, 'v-clip', 'video', 802, 0, 1), (91, 'm-first', 'image', 802, 1, 1),
        (92, 'm-later', 'image', 801, 0, 1), (93, 'm-review', 'image', 803, 0, 1),
        (94, 'u-draft', 'image', 804, 0, 1), (95, 'p-live', 'image', 805, 0, 1),
        (96, 'm-other-only', 'image', 806, 0, 1);
    `);
  });

  it('returns the first four images of a post in post order, videos included, with the true count', async () => {
    const covers = await getHoldCoverImages([hold(1, 'Post', 10), hold(2, 'Post', 60)]);
    const flags = { minor: false, acceptableMinor: false };
    expect(covers.get(1)).toEqual({
      images: [
        { id: 3, url: 'k-c', nsfwLevel: 1, type: 'video', ...flags },
        { id: 2, url: 'k-b', nsfwLevel: 1, type: 'image', minor: true, acceptableMinor: false },
        { id: 1, url: 'k-a', nsfwLevel: 4, type: 'image', minor: false, acceptableMinor: true },
        { id: 4, url: 'k-d', nsfwLevel: 1, type: 'image', ...flags },
      ],
      total: 6,
    });
    expect(covers.get(2)).toEqual({
      images: [{ id: 7, url: 'k-g', nsfwLevel: 1, type: 'image', ...flags }],
      total: 1,
    });
  });

  it("picks a model's owner media by version then post order, ignoring other users' posts", async () => {
    const covers = await getHoldCoverImages([hold(3, 'Model', 71)]);
    expect(covers.get(3)?.images.map((i) => [i.url, i.type])).toEqual([
      ['v-clip', 'video'],
      ['m-first', 'image'],
      ['m-later', 'image'],
    ]);
    expect(covers.get(3)?.total).toBe(3);
  });

  it('prefers a published post over an unpublished one', async () => {
    const covers = await getHoldCoverImages([hold(4, 'Model', 72)]);
    expect(covers.get(4)?.images.map((i) => i.url)).toEqual(['p-live', 'u-draft']);
    expect(covers.get(4)?.total).toBe(2);
  });

  it('has no entry for a post or model without images, or a type with none', async () => {
    const covers = await getHoldCoverImages([
      hold(5, 'Post', 30),
      hold(6, 'Model', 73),
      hold(7, 'ChatMessage', 1),
    ]);
    expect(covers.size).toBe(0);
  });

  it('gives every hold its own entry when two holds share an entity', async () => {
    const covers = await getHoldCoverImages([hold(1, 'Post', 10), hold(8, 'Post', 10)]);
    expect(covers.get(1)).toEqual(covers.get(8));
    expect(covers.get(8)?.total).toBe(6);
  });

  it('bounds a model with many images to four and a capped count', async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (74, 'Big', 'Published', 10), (75, 'Huge', 'Published', 10);
      INSERT INTO "ModelVersion" VALUES (740, 74, 0), (750, 75, 0);
      INSERT INTO "Post" VALUES (810, NULL, '2026-10-01', 10, 740), (811, NULL, '2026-10-01', 10, 750);
      INSERT INTO "Image" ("id","url","type","postId","index","nsfwLevel") SELECT 6000 + g, 'big-' || g, 'image', 810, g, 1 FROM generate_series(1, 6) g;
      INSERT INTO "Image" ("id","url","type","postId","index","nsfwLevel") SELECT 7000 + g, 'huge-' || g, 'image', 811, g, 1 FROM generate_series(1, 150) g;
    `);
    const covers = await getHoldCoverImages([hold(1, 'Model', 74), hold(2, 'Model', 75)]);
    expect(covers.get(1)?.images.map((i) => i.url)).toEqual(['big-1', 'big-2', 'big-3', 'big-4']);
    expect(covers.get(1)?.total).toBe(6);
    expect(covers.get(2)?.images).toHaveLength(4);
    expect(covers.get(2)?.total).toBe(PREVIEW_COUNT_CAP + 1);
  });

  it('bounds a post with many images the same way', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (812, NULL, '2026-10-01', 10, NULL);
      INSERT INTO "Image" ("id","url","type","postId","index","nsfwLevel") SELECT 8000 + g, 'post-' || g, 'image', 812, g, 1 FROM generate_series(1, 150) g;
    `);
    const covers = await getHoldCoverImages([hold(1, 'Post', 812)]);
    expect(covers.get(1)?.images.map((i) => i.url)).toEqual([
      'post-1',
      'post-2',
      'post-3',
      'post-4',
    ]);
    expect(covers.get(1)?.total).toBe(PREVIEW_COUNT_CAP + 1);
  });

  it('reads nothing for an empty page', async () => {
    expect((await getHoldCoverImages([])).size).toBe(0);
  });
});
