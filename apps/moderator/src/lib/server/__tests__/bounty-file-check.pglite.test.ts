import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  dbWrite: {},
}));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { getBlockedEntryFiles, getClearedEntryFiles, getStuckEntryFiles } = await import(
  '../bounty-file-check.service'
);

// The columns the queries read. `citext` is a plain domain here: the match lookup only needs the
// cast to resolve, and the test hashes are already one case.
const SCHEMA = `
CREATE DOMAIN citext AS text;
CREATE TABLE "User" (id INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE "Bounty" (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT false, refunded BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "BountyEntry" (id INTEGER PRIMARY KEY, "bountyId" INTEGER NOT NULL, "userId" INTEGER);
CREATE TABLE "BountyBenefactor" (
  "userId" INTEGER NOT NULL, "bountyId" INTEGER NOT NULL, "awardedToId" INTEGER,
  PRIMARY KEY ("bountyId", "userId")
);
CREATE TABLE "File" (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
  "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, metadata JSONB
);
CREATE TABLE "Model" (id INTEGER PRIMARY KEY, name TEXT, "userId" INTEGER, "deletedAt" TIMESTAMP(3));
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "ModelFile" (id INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL);
CREATE TABLE "ModelFileHash" ("fileId" INTEGER NOT NULL, hash citext NOT NULL);
CREATE TABLE "ModActivity" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL,
  "entityType" TEXT, "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

const ENTRY = 20;
const BLOCKED = {
  hashCheckedAt: '2026-10-20T00:00:00Z',
  sha256Server: 'F'.repeat(64),
  blockedReason: 'other-users-model',
};
const CLEAR = { by: 1, at: '2026-10-21T00:00:00Z', reason: 'their own alt account' };

let db: PGlite;

async function file(id: number, metadata: object) {
  await db.query(
    `INSERT INTO "File" (id, name, "entityType", "entityId", metadata) VALUES ($1, $2, 'BountyEntry', $3, $4)`,
    [id, `file-${id}.safetensors`, ENTRY, JSON.stringify(metadata)]
  );
}

async function logActivity(kind: 'clearFileCheck' | 'reblockFileCheck', fileId: number) {
  await db.query(
    `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId") VALUES (1, $1, 'bountyEntry', $2)`,
    [`${kind}:${JSON.stringify({ fileId, reason: CLEAR.reason })}`, ENTRY]
  );
}
const logClear = (fileId: number) => logActivity('clearFileCheck', fileId);

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (1, 'mod'), (2, 'entrant');
    INSERT INTO "Bounty" (id, name, type) VALUES (10, 'A LoRA', 'LoraCreation');
    INSERT INTO "BountyEntry" (id, "bountyId", "userId") VALUES (${ENTRY}, 10, 2);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('the Blocked list', () => {
  it('leaves out a file a moderator cleared, and keeps one whose stored clear is malformed', async () => {
    await file(1, BLOCKED);
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    await file(3, { ...BLOCKED, checkOverride: { ...CLEAR, by: '1' } });
    await file(4, { hashCheckedAt: '2026-10-20T00:00:00Z' });

    const { items } = await getBlockedEntryFiles(10);
    expect(items.map((f) => f.fileId)).toEqual([1, 3]);
  });

  // A re-block is allowed after the bounty settles; the file must stay reachable to clear again.
  it.each([
    ['complete', 'complete = true'],
    ['refunded', 'refunded = true'],
  ])('lists a file re-blocked on a %s bounty, with the bounty state', async (_, settled) => {
    await db.exec(`UPDATE "Bounty" SET ${settled}`);
    await file(1, BLOCKED);
    await file(2, BLOCKED);
    // File 2's clear, and a re-block of file 21 of the same entry, are not a re-block of file 2.
    await logActivity('reblockFileCheck', 1);
    await logActivity('clearFileCheck', 2);
    await logActivity('reblockFileCheck', 21);

    const { items } = await getBlockedEntryFiles(10);
    expect(items).toEqual([
      expect.objectContaining({
        fileId: 1,
        bountyComplete: settled === 'complete = true',
        bountyRefunded: settled === 'refunded = true',
      }),
    ]);
  });

  it('lists open-bounty and re-blocked settled-bounty files together, oldest first, once each', async () => {
    await db.exec(`
      INSERT INTO "Bounty" (id, name, type, complete) VALUES (11, 'Settled', 'LoraCreation', true);
      INSERT INTO "BountyEntry" (id, "bountyId", "userId") VALUES (21, 11, 2);
    `);
    await file(1, { ...BLOCKED, hashCheckedAt: '2026-10-20T02:00:00Z' });
    await file(3, { ...BLOCKED, hashCheckedAt: '2026-10-20T03:00:00Z' });
    await db.query(
      `INSERT INTO "File" (id, name, "entityType", "entityId", metadata) VALUES (2, 'settled.safetensors', 'BountyEntry', 21, $1)`,
      [JSON.stringify({ ...BLOCKED, hashCheckedAt: '2026-10-20T01:00:00Z' })]
    );
    // Two re-blocks of the settled file: still one row.
    for (let i = 0; i < 2; i++)
      await db.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId") VALUES (1, $1, 'bountyEntry', 21)`,
        [`reblockFileCheck:${JSON.stringify({ fileId: 2, reason: 'why' })}`]
      );

    // An open-bounty file re-blocked earlier comes from the open branch only.
    await logActivity('reblockFileCheck', 1);

    const { items } = await getBlockedEntryFiles(10);
    const ids = items.map((f) => f.fileId);
    expect(new Set(ids).size, `a file listed twice: ${ids}`).toBe(ids.length);
    expect(items.map((f) => [f.fileId, f.bountyComplete])).toEqual([
      [2, true],
      [1, false],
      [3, false],
    ]);
    expect((await getBlockedEntryFiles(2)).hasMore).toBe(true);
  });
});

describe('Recently cleared', () => {
  it('shows a clear recorded in ModActivity, with who cleared it and why', async () => {
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    await logClear(2);

    expect(await getClearedEntryFiles(10)).toEqual([
      expect.objectContaining({
        fileId: 2,
        entryId: ENTRY,
        moderator: 'mod',
        reason: 'their own alt account',
        clearedAt: CLEAR.at,
      }),
    ]);
  });

  it('says whether the entry was awarded and the bounty settled, for the re-block', async () => {
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    await logClear(2);
    const [open] = await getClearedEntryFiles(10);
    expect(open).toMatchObject({
      entryAwarded: false,
      bountyComplete: false,
      bountyRefunded: false,
    });

    // Another bounty's award to an entry with the same id is not this entry's award.
    await db.exec(`
      INSERT INTO "BountyBenefactor" ("userId", "bountyId", "awardedToId") VALUES (3, 99, ${ENTRY});
    `);
    expect((await getClearedEntryFiles(10))[0]).toMatchObject({ entryAwarded: false });

    await db.exec(`
      INSERT INTO "BountyBenefactor" ("userId", "bountyId", "awardedToId") VALUES (3, 10, ${ENTRY});
      UPDATE "Bounty" SET complete = true;
    `);
    expect((await getClearedEntryFiles(10))[0]).toMatchObject({
      entryAwarded: true,
      bountyComplete: true,
      bountyRefunded: false,
    });
  });

  // What the main app's re-block writes: the clear removed, the check's own keys untouched.
  it('drops a re-blocked file, which goes back to the Blocked list', async () => {
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    await logClear(2);
    await db.query(`UPDATE "File" SET metadata = metadata - 'checkOverride' WHERE id = 2`);

    expect(await getClearedEntryFiles(10)).toEqual([]);
    expect((await getBlockedEntryFiles(10)).items.map((f) => f.fileId)).toEqual([2]);
  });

  it('control: a cleared file with no ModActivity row is not listed', async () => {
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    expect(await getClearedEntryFiles(10)).toEqual([]);
  });
});

describe('Still checking', () => {
  it('lists a file that failed to hash, and reads a planted count as none', async () => {
    await file(5, { hashFailCount: 2, hashLastError: 'download failed: 503' });
    await file(6, { hashFailCount: 'many' });
    await file(7, { hashFailCount: 3.5 });

    const { items } = await getStuckEntryFiles(10);
    expect(items).toEqual([
      expect.objectContaining({ fileId: 5, failCount: 2, lastError: 'download failed: 503' }),
    ]);
  });
});
