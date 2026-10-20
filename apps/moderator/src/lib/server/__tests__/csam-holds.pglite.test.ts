import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsamHoldQuery } from '../csam-holds.queries';
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

const { countCsamHoldsByType, countPendingCsamHolds, decideCsamHold, listCsamHolds } = await import(
  '../csam-holds.service'
);

const OLDEST_PENDING: CsamHoldQuery = {
  status: 'pending',
  sort: 'oldest',
  limit: 10,
  offset: 0,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(
    HERE,
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261016150000_text_scan_hold/migration.sql'
  ),
  'utf-8'
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
  await db.exec(MIGRATION);
  await db.exec(`CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT)`);
  await db.query(`INSERT INTO "User" ("id","username") VALUES (10,'author'), (11,'Mod_Person')`);
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
    expect(await decideCsamHold({ holdId: 3, decision: 'dismiss', note: 'fine' })).toEqual({
      ok: true,
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'text-scan/csam-hold/resolve',
      { holdId: 3, decision: 'dismiss', note: 'fine' },
      expect.any(String)
    );
  });

  it.each(['remove', 'remove_strike', 'remove_ban', 'remove_ban_report'] as const)(
    'sends %s to the main app and expects the hold Confirmed',
    async (decision) => {
      callModEndpoint.mockResolvedValue({ ok: true, body: { holdId: 3, status: 'Confirmed' } });
      expect(await decideCsamHold({ holdId: 3, decision })).toEqual({ ok: true });
      expect(callModEndpoint).toHaveBeenCalledWith(
        'text-scan/csam-hold/resolve',
        { holdId: 3, decision },
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
    expect(await decideCsamHold({ holdId: 3, decision: 'remove' })).toEqual({
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
    expect(await decideCsamHold({ holdId: 3, decision: 'remove' })).toEqual({
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
    const result = await decideCsamHold({ holdId: 3, decision: 'remove_ban' });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/may already have completed.*reload/i);
  });

  it.each([
    ['a removal reported as dismissed', 'remove', 'Dismissed'],
    ['a dismissal reported as confirmed', 'dismiss', 'Confirmed'],
    ['a success with no status', 'remove', undefined],
  ] as const)('treats %s as a failure', async (_, decision, status) => {
    callModEndpoint.mockResolvedValue({ ok: true, body: status ? { status } : {} });
    expect(await decideCsamHold({ holdId: 3, decision })).toMatchObject({ ok: false });
  });
});
