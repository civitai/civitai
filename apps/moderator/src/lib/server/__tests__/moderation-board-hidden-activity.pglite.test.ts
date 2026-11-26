import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../cache', () => ({
  createCache: ({ fetch }: { fetch: (args: unknown) => unknown }) => ({ get: fetch }),
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => null }));

const { getRecentModActivity, getWorkingNow } = await import('../moderation-board.service');

/** The preserved-file review is a hidden page: the shared board must not show who works it. */

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "isModerator" BOOLEAN);
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
    );
    INSERT INTO "User" VALUES (5, 'reviewer', true), (6, 'other-mod', true);
    INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
      (5, 'preservedFile:served', 'preservedFile:0123456789abcdef', 1),
      (5, 'preservedFile:verdict-not', 'preservedFile:0123456789abcdef', 1),
      (6, 'heldMedia:view', 'image', 7);`);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});
afterAll(async () => db?.close());

describe('the moderation board', () => {
  it('leaves preserved-file rows out of recent activity', async () => {
    const rows = await getRecentModActivity();
    expect(rows.map((r) => r.moderator)).toEqual(['other-mod']);
  });

  it('does not list a moderator whose only activity is the preserved-file review', async () => {
    const rows = await getWorkingNow();
    expect(rows.map((r) => r.username)).toEqual(['other-mod']);
  });
});
