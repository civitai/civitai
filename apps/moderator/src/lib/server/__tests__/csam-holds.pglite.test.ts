import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { countPendingCsamHolds, dismissCsamHold, listPendingCsamHolds } = await import(
  '../csam-holds.service'
);

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
};

const seed = (rows: Seed[]) =>
  Promise.all(
    rows.map((r) =>
      db.query(
        `INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","status","userId",
           "text","reason","createdAt","updatedAt","meta")
         VALUES ($1,$2,$3,$4,$5,$6::"TextScanHoldStatus",$7,'neutral text','neutral reason',$8,$8,$9::jsonb)`,
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
        ]
      )
    )
  );

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(MIGRATION);
  await db.exec(`CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT)`);
  await db.query(`INSERT INTO "User" ("id","username") VALUES (10,'author')`);
  await seed([
    { id: 1, createdAt: '2026-10-03' },
    { id: 2, createdAt: '2026-10-01', entityType: 'ChatMessage', meta: { chatId: 77 } },
    { id: 3, createdAt: '2026-10-02', userId: 404 },
    { id: 4, createdAt: '2026-09-01', status: 'Dismissed' },
    { id: 5, createdAt: '2026-09-02', label: 'scam' },
    { id: 6, createdAt: '2026-10-04', userId: null },
  ]);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('listPendingCsamHolds', () => {
  it('lists only pending csam holds, oldest first', async () => {
    const { items, hasMore } = await listPendingCsamHolds({ limit: 10, offset: 0 });
    expect(items.map((h) => h.id)).toEqual([2, 3, 1, 6]);
    expect(hasMore).toBe(false);
  });

  it('names the author, and leaves the name null when the account is gone', async () => {
    const { items } = await listPendingCsamHolds({ limit: 10, offset: 0 });
    const byId = new Map(items.map((h) => [h.id, h]));
    expect(byId.get(1)).toMatchObject({ userId: 10, username: 'author' });
    expect(byId.get(3)).toMatchObject({ userId: 404, username: null });
    expect(byId.get(6)).toMatchObject({ userId: null, username: null });
  });

  it('carries the chat id of a held chat message', async () => {
    const { items } = await listPendingCsamHolds({ limit: 10, offset: 0 });
    expect(items.find((h) => h.id === 2)?.chatId).toBe(77);
    expect(items.find((h) => h.id === 1)?.chatId).toBeNull();
  });

  it('pages, and says when more remain', async () => {
    const first = await listPendingCsamHolds({ limit: 2, offset: 0 });
    expect(first.items.map((h) => h.id)).toEqual([2, 3]);
    expect(first.hasMore).toBe(true);
    const second = await listPendingCsamHolds({ limit: 2, offset: 2 });
    expect(second.items.map((h) => h.id)).toEqual([1, 6]);
    expect(second.hasMore).toBe(false);
  });

  it('narrows to one entity type', async () => {
    const { items } = await listPendingCsamHolds({
      limit: 10,
      offset: 0,
      entityType: 'ChatMessage',
    });
    expect(items.map((h) => h.id)).toEqual([2]);
  });
});

describe('countPendingCsamHolds', () => {
  it('counts what the queue lists', async () => {
    expect(await countPendingCsamHolds()).toBe(4);
    expect(await countPendingCsamHolds('ChatMessage')).toBe(1);
  });
});

describe('dismissCsamHold', () => {
  it('asks the main app to dismiss the hold', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { holdId: 3, status: 'Dismissed' } });
    expect(await dismissCsamHold({ holdId: 3, note: 'fine' })).toEqual({ ok: true });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'text-scan/csam-hold/resolve',
      { holdId: 3, decision: 'dismiss', note: 'fine' },
      expect.any(String)
    );
  });

  it('passes the main app refusal through', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Dismiss hold: already decided',
      status: 409,
    });
    expect(await dismissCsamHold({ holdId: 3 })).toEqual({
      ok: false,
      error: 'Dismiss hold: already decided',
    });
  });

  it('passes a request that never left through as a plain failure', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Dismiss hold failed.',
      requestNeverSent: true,
    });
    expect(await dismissCsamHold({ holdId: 3 })).toEqual({
      ok: false,
      error: 'Dismiss hold failed.',
    });
  });

  it('says the dismissal may have completed when the response was lost', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Dismiss hold failed.',
      requestNeverSent: false,
    });
    const result = await dismissCsamHold({ holdId: 3 });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/may already have completed.*reload/i);
  });

  it('treats a success that did not dismiss the hold as a failure', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: {} });
    expect(await dismissCsamHold({ holdId: 3 })).toMatchObject({ ok: false });
  });
});
