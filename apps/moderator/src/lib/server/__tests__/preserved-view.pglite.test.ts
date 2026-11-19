import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** The preserved-file review's reads and writes against real SQL: one verdict per file, ever. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../access', () => ({ canAccess: () => true }));
vi.mock('../axiom', () => ({ logToAxiom: async () => {} }));

const { auditServe, preservedVerdicts, recordPreservedVerdict, servedTo } = await import(
  '../preserved-view'
);

const REVIEWER = 501;
let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "credential" TEXT
    );`);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.exec('TRUNCATE "ModActivity" RESTART IDENTITY');
});

const rows = async () =>
  (
    await db.query<{ activity: string; entityId: number; userId: number }>(
      'SELECT "activity", "entityId", "userId" FROM "ModActivity" ORDER BY "id"'
    )
  ).rows;

describe('verdicts', () => {
  it('records the first verdict for a file and refuses every later one', async () => {
    expect(await recordPreservedVerdict(REVIEWER, 1, 'apparent')).toBe('recorded');
    expect(await recordPreservedVerdict(REVIEWER, 1, 'not')).toBe('already');
    expect(await recordPreservedVerdict(REVIEWER, 1, 'apparent')).toBe('already');
    expect(await recordPreservedVerdict(REVIEWER, 2, 'not')).toBe('recorded');
    expect(await rows()).toEqual([
      { activity: 'preservedFile:verdict-apparent', entityId: 1, userId: REVIEWER },
      { activity: 'preservedFile:verdict-not', entityId: 2, userId: REVIEWER },
    ]);
    expect(await preservedVerdicts()).toEqual(
      new Map([
        [1, 'apparent'],
        [2, 'not'],
      ])
    );
  });

  it('counts only this feature\'s verdict rows', async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (1, 'preservedFile:verdict-not', 'image', 3),
        (1, 'preservedFile:served', 'preservedFile', 3);`);
    expect(await preservedVerdicts()).toEqual(new Map());
    expect(await recordPreservedVerdict(REVIEWER, 3, 'not')).toBe('recorded');
  });
});

describe('serves', () => {
  it('writes a served row that reads back, and counts it only for its reviewer', async () => {
    expect(await auditServe(REVIEWER, 2)).toBe(true);
    expect(await rows()).toEqual([
      { activity: 'preservedFile:served', entityId: 2, userId: REVIEWER },
    ]);
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (777, 'preservedFile:served', 'preservedFile', 1),
        (${REVIEWER}, 'preservedFile:served', 'image', 3);`);
    expect(await servedTo(REVIEWER)).toEqual(new Set([2]));
  });
});
