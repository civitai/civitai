import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** The preserved-file review's reads and writes against real SQL. */

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
const readBack = vi.hoisted(() => ({ ok: true }));
vi.mock('../mod-activity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mod-activity')>();
  return {
    ...real,
    modActivityRowExists: async (id: number) => readBack.ok && real.modActivityRowExists(id),
  };
});

const { auditServe, deliveredTo, preservedVerdicts, recordDelivery, recordPreservedVerdict } =
  await import('../preserved-view');
const { insertModActivity, modActivityRowExists } = await import('../mod-activity');

const REVIEWER = 501;
const file = (n: number, hex: string) => ({
  n,
  key: `fixture/${n}.png`,
  size: 10,
  sha256: hex.repeat(64),
});
const A = file(1, 'a');
const B = file(2, 'b');
const ENTITY = `preservedFile:${'a'.repeat(16)}`;

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
  // Ids start past 1, so a read-back that ignored its argument would not find row 1 by luck.
  await db.exec('TRUNCATE "ModActivity" RESTART IDENTITY');
  await db.exec(
    `INSERT INTO "ModActivity" ("userId", "activity") SELECT 1, 'other' FROM generate_series(1, 5)`
  );
});

const rows = async () =>
  (
    await db.query<{ activity: string; entityType: string; entityId: number; userId: number }>(
      'SELECT "activity", "entityType", "entityId", "userId" FROM "ModActivity" WHERE "activity" <> \'other\' ORDER BY "id"'
    )
  ).rows;

describe('verdicts', () => {
  const TYPE_B = `preservedFile:${'b'.repeat(16)}`;

  it('records the first verdict for a file and refuses every later one', async () => {
    expect(await recordDelivery(A, REVIEWER)).toBe('delivered');
    expect(await recordDelivery(B, REVIEWER)).toBe('delivered');
    expect(await recordPreservedVerdict(A, REVIEWER, 'apparent')).toBe('recorded');
    expect(await recordPreservedVerdict(A, REVIEWER, 'not')).toBe('already');
    expect(await recordPreservedVerdict(A, REVIEWER, 'apparent')).toBe('already');
    expect(await recordPreservedVerdict(B, REVIEWER, 'not')).toBe('recorded');
    expect((await rows()).filter((r) => r.activity.includes('verdict'))).toEqual([
      {
        activity: 'preservedFile:verdict-apparent',
        entityType: ENTITY,
        entityId: 1,
        userId: REVIEWER,
      },
      { activity: 'preservedFile:verdict-not', entityType: TYPE_B, entityId: 2, userId: REVIEWER },
    ]);
    expect(await preservedVerdicts([A, B])).toEqual(
      new Map([
        [1, 'apparent'],
        [2, 'not'],
      ])
    );
  });

  it("stays with the file's bytes, wherever a manifest puts them", async () => {
    expect(await recordDelivery(A, REVIEWER)).toBe('delivered');
    expect(await recordPreservedVerdict(A, REVIEWER, 'apparent')).toBe('recorded');
    const moved = { ...A, n: 3 };
    expect(await preservedVerdicts([B, moved])).toEqual(new Map([[3, 'apparent']]));
    expect(await recordPreservedVerdict(moved, REVIEWER, 'not')).toBe('already');
    expect(await preservedVerdicts([{ ...B, n: 1 }])).toEqual(new Map());
  });

  it('counts a verdict only from someone the file was delivered to', async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (777, 'preservedFile:verdict-apparent', '${ENTITY}', 1),
        (777, 'preservedFile:delivered', '${TYPE_B}', 2),
        (778, 'preservedFile:served', '${ENTITY}', 1),
        (778, 'preservedFile:verdict-not', '${ENTITY}', 1);`);
    expect(await preservedVerdicts([A])).toEqual(new Map());
    expect(await recordDelivery(A, REVIEWER)).toBe('delivered');
    expect(await recordPreservedVerdict(A, REVIEWER, 'not')).toBe('recorded');
    expect(await preservedVerdicts([A])).toEqual(new Map([[1, 'not']]));
  });

  it('keeps the first verdict of a reviewer who is no longer listed', async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (777, 'preservedFile:delivered', '${ENTITY}', 1),
        (777, 'preservedFile:verdict-apparent', '${ENTITY}', 1),
        (${REVIEWER}, 'preservedFile:delivered', '${ENTITY}', 1),
        (${REVIEWER}, 'preservedFile:verdict-not', '${ENTITY}', 1);`);
    expect(await preservedVerdicts([A])).toEqual(new Map([[1, 'apparent']]));
    expect(await recordPreservedVerdict(A, REVIEWER, 'not')).toBe('already');
    expect(await recordDelivery(A, REVIEWER)).toBe('ruled');
  });

  it('does not count a verdict written before its author was delivered the file', async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (777, 'preservedFile:verdict-apparent', '${ENTITY}', 1),
        (777, 'preservedFile:delivered', '${ENTITY}', 1);`);
    expect(await preservedVerdicts([A])).toEqual(new Map());
  });

  it('writes no delivered row for a file with a verdict', async () => {
    expect(await recordDelivery(A, REVIEWER)).toBe('delivered');
    expect(await recordPreservedVerdict(A, REVIEWER, 'not')).toBe('recorded');
    expect(await recordDelivery(A, REVIEWER)).toBe('ruled');
    expect((await rows()).map((r) => r.activity)).toEqual([
      'preservedFile:delivered',
      'preservedFile:verdict-not',
    ]);
  });

  it("counts only this feature's verdict rows", async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (${REVIEWER}, 'preservedFile:delivered', 'image', 1),
        (${REVIEWER}, 'preservedFile:verdict-not', 'image', 1),
        (${REVIEWER}, 'preservedFile:served', '${ENTITY}', 1);`);
    expect(await preservedVerdicts([A])).toEqual(new Map());
  });
});

describe('serves', () => {
  it('reports a delivered row that could not be written as failed', async () => {
    await db.exec(`
      CREATE FUNCTION refuse_delivered() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refused'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_delivered BEFORE INSERT ON "ModActivity"
        FOR EACH ROW WHEN (NEW."activity" = 'preservedFile:delivered')
        EXECUTE FUNCTION refuse_delivered();`);
    try {
      expect(await recordDelivery(A, REVIEWER)).toBe('failed');
    } finally {
      await db.exec(
        'DROP TRIGGER refuse_delivered ON "ModActivity"; DROP FUNCTION refuse_delivered();'
      );
    }
    expect(await deliveredTo([A], REVIEWER)).toEqual(new Set());
  });

  it('reports a delivered row that does not read back as failed', async () => {
    readBack.ok = false;
    try {
      expect(await recordDelivery(A, REVIEWER)).toBe('failed');
    } finally {
      readBack.ok = true;
    }
  });

  it('writes rows that read back, and reports a missing id as missing', async () => {
    expect(await auditServe(B, REVIEWER)).toBe(true);
    expect(await recordDelivery(B, REVIEWER)).toBe('delivered');
    const typeB = `preservedFile:${'b'.repeat(16)}`;
    expect(await rows()).toEqual([
      { activity: 'preservedFile:served', entityType: typeB, entityId: 2, userId: REVIEWER },
      { activity: 'preservedFile:delivered', entityType: typeB, entityId: 2, userId: REVIEWER },
    ]);
    const id = await insertModActivity({ userId: 1, entityType: 'x', entityId: 1, activity: 'y' });
    expect(id).toBe(8);
    expect(await modActivityRowExists(id)).toBe(true);
    expect(await modActivityRowExists(999)).toBe(false);
  });

  it('counts a file as sent only on its delivered row, for this reviewer', async () => {
    const C = file(3, 'c');
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (${REVIEWER}, 'preservedFile:served', 'preservedFile:${'b'.repeat(16)}', 2),
        (${REVIEWER}, 'preservedFile:verdict-not', 'preservedFile:${'b'.repeat(16)}', 2),
        (777, 'preservedFile:delivered', 'preservedFile:${'c'.repeat(16)}', 3),
        (${REVIEWER}, 'preservedFile:delivered', 'image', 3),
        (${REVIEWER}, 'preservedFile:delivered', '${ENTITY}', 1);`);
    expect(await deliveredTo([A, B, C], REVIEWER)).toEqual(new Set([1]));
  });
});
