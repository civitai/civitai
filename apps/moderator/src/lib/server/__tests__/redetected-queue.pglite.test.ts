import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs the re-detected queue SQL on real Postgres: a predicate that compiles can still select the wrong rows. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));

const { getRedetectedModels } = await import('../minor-hash.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published',
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE, "meta" JSONB
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending'
);
`;

const grant = { at: '2026-09-01T00:00:00Z', by: 5, textHash: 'old', via: 'moderator' };
const redetected = (at: string) => ({ workflowId: 'wf', reason: 'r', textHash: 'new', at });

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  await pg.exec(`INSERT INTO "User" VALUES (1, 'owner'), (2, 'other'), (5, 'mod')`);
});
afterEach(async () => {
  await pg.close();
});

const seedModel = (id: number, userId: number, textScanFlags: unknown) =>
  pg.query(`INSERT INTO "Model" (id, name, "userId", meta) VALUES ($1, $2, $3, $4)`, [
    id,
    `model ${id}`,
    userId,
    JSON.stringify(textScanFlags === null ? {} : { textScanFlags }),
  ]);

describe('getRedetectedModels', () => {
  beforeEach(async () => {
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
    // Cleared and quiet, a plain open flag, and a model with no scan data: none are waiting.
    await seedModel(3, 1, { minor: { appealGranted: grant } });
    await seedModel(4, 1, { minor: { workflowId: 'wf', reason: 'r' } });
    await seedModel(5, 1, null);
  });

  it('lists a row per waiting label, oldest detection first', async () => {
    const { items, hasMore } = await getRedetectedModels({ limit: 10 });
    expect(items.map((r) => [r.modelId, r.label])).toEqual([
      [2, 'minor'],
      [1, 'minor'],
      [2, 'poi'],
    ]);
    expect(hasMore).toBe(false);
  });

  it('carries the prior clear with the moderator who made it', async () => {
    const [row] = (await getRedetectedModels({ limit: 10 })).items;
    expect(row.granted).toMatchObject({ via: 'moderator', by: 5 });
    expect(row.grantedByUsername).toBe('mod');
    expect(row.redetected).toMatchObject({ textHash: 'new', reason: 'r' });
  });

  it('flags the models whose owner also has an open appeal', async () => {
    await pg.exec(`INSERT INTO "Appeal" VALUES
      (1, 'Model', 1, 'Pending'), (2, 'Model', 2, 'Approved')`);
    const { items } = await getRedetectedModels({ limit: 10 });
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.hasPendingAppeal]))).toEqual({
      1: true,
      2: false,
    });
  });

  it('pages and reports whether more remain', async () => {
    const first = await getRedetectedModels({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await getRedetectedModels({ limit: 2, offset: 2 });
    expect(second.items.map((r) => [r.modelId, r.label])).toEqual([[2, 'poi']]);
    expect(second.hasMore).toBe(false);
  });

  it('searches by model, user and username', async () => {
    expect(
      (await getRedetectedModels({ limit: 10, search: { modelOrUserId: 1 } })).items
    ).toHaveLength(1);
    expect(
      (await getRedetectedModels({ limit: 10, search: { username: 'OTHER' } })).items
    ).toHaveLength(2);
    expect((await getRedetectedModels({ limit: 10, search: { modelOrUserId: 3 } })).items).toEqual(
      []
    );
  });
});
