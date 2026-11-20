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

const { auditServe, deliveredTo, preservedVerdicts, recordDelivery, recordPreservedVerdict } =
  await import('../preserved-view');
const { insertModActivity, modActivityRowExists } = await import('../mod-activity');

const REVIEWER = 501;
const config = (manifestSha256: string) => ({
  manifestKey: 'fixture/manifest.json',
  manifestSha256,
  reviewerIds: new Set([REVIEWER]),
  store: {
    endpoint: 'https://store.test',
    region: 'us-east-1',
    bucket: 'b',
    accessKey: 'k',
    secretKey: 's',
  },
});
const PIN = config('a'.repeat(64));
const OTHER_PIN = config('b'.repeat(64));
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
  it('records the first verdict for a file and refuses every later one', async () => {
    expect(await recordPreservedVerdict(PIN, REVIEWER, 1, 'apparent')).toBe('recorded');
    expect(await recordPreservedVerdict(PIN, REVIEWER, 1, 'not')).toBe('already');
    expect(await recordPreservedVerdict(PIN, REVIEWER, 1, 'apparent')).toBe('already');
    expect(await recordPreservedVerdict(PIN, REVIEWER, 2, 'not')).toBe('recorded');
    expect(await rows()).toEqual([
      {
        activity: 'preservedFile:verdict-apparent',
        entityType: ENTITY,
        entityId: 1,
        userId: REVIEWER,
      },
      { activity: 'preservedFile:verdict-not', entityType: ENTITY, entityId: 2, userId: REVIEWER },
    ]);
    expect(await preservedVerdicts(PIN)).toEqual(
      new Map([
        [1, 'apparent'],
        [2, 'not'],
      ])
    );
  });

  it('keeps each pinned manifest separate', async () => {
    expect(await recordPreservedVerdict(PIN, REVIEWER, 1, 'apparent')).toBe('recorded');
    expect(await preservedVerdicts(OTHER_PIN)).toEqual(new Map());
    expect(await recordPreservedVerdict(OTHER_PIN, REVIEWER, 1, 'not')).toBe('recorded');
    expect(await preservedVerdicts(PIN)).toEqual(new Map([[1, 'apparent']]));
  });

  it("counts only this feature's verdict rows", async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (1, 'preservedFile:verdict-not', 'image', 3),
        (1, 'preservedFile:served', '${ENTITY}', 3),
        (1, 'preservedFile:delivered', '${ENTITY}', 3);`);
    expect(await preservedVerdicts(PIN)).toEqual(new Map());
    expect(await recordPreservedVerdict(PIN, REVIEWER, 3, 'not')).toBe('recorded');
  });
});

describe('serves', () => {
  it('writes rows that read back, and reports a missing id as missing', async () => {
    expect(await auditServe(PIN, REVIEWER, 2)).toBe(true);
    expect(await recordDelivery(PIN, REVIEWER, 2)).toBe(true);
    expect(await rows()).toEqual([
      { activity: 'preservedFile:served', entityType: ENTITY, entityId: 2, userId: REVIEWER },
      { activity: 'preservedFile:delivered', entityType: ENTITY, entityId: 2, userId: REVIEWER },
    ]);
    const id = await insertModActivity({ userId: 1, entityType: 'x', entityId: 1, activity: 'y' });
    expect(id).toBe(8);
    expect(await modActivityRowExists(id)).toBe(true);
    expect(await modActivityRowExists(999)).toBe(false);
  });

  it('counts a file as sent only on its delivered row, for this reviewer and this pin', async () => {
    await db.exec(`
      INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId") VALUES
        (${REVIEWER}, 'preservedFile:served', '${ENTITY}', 1),
        (${REVIEWER}, 'preservedFile:verdict-not', '${ENTITY}', 5),
        (777, 'preservedFile:delivered', '${ENTITY}', 3),
        (${REVIEWER}, 'preservedFile:delivered', 'image', 4),
        (${REVIEWER}, 'preservedFile:delivered', 'preservedFile:${'b'.repeat(16)}', 6),
        (${REVIEWER}, 'preservedFile:delivered', '${ENTITY}', 2);`);
    expect(await deliveredTo(PIN, REVIEWER)).toEqual(new Set([2]));
  });
});
