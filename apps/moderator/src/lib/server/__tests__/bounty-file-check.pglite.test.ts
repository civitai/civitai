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
});

describe('Recently cleared', () => {
  it('shows a clear recorded in ModActivity, with who cleared it and why', async () => {
    await file(2, { ...BLOCKED, checkOverride: CLEAR });
    await db.query(
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId") VALUES (1, $1, 'bountyEntry', $2)`,
      [`clearFileCheck:${JSON.stringify({ fileId: 2, reason: CLEAR.reason })}`, ENTRY]
    );

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
