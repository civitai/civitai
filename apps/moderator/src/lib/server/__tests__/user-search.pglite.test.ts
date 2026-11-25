import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { searchUsers } = await import('../users.service');
const { resolveUserId } = await import('../user-lookup.service');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "image" TEXT,
      "deletedAt" TIMESTAMP);
    INSERT INTO "User" VALUES
      (-1, 'civitai', NULL, NULL),
      (990004992, 'SynthMiner', NULL, NULL),
      (12, 'SynthMinerAlt', NULL, NULL),
      (13, 'SynthXMiner', NULL, NULL),
      (14, 'Synth_Miner', NULL, NULL),
      (15, '990004992fan', NULL, NULL),
      (16, 'SynthMinerGone', NULL, '2026-11-01');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const names = async (query: string) => (await searchUsers({ query })).map((u) => u.username);

describe('the grant page user picker', () => {
  it("never sends an account's legacy profile image", async () => {
    await db.exec(`UPDATE "User" SET image = 'legacy-key'`);
    for (const user of await searchUsers({ query: 'SynthMiner' }))
      expect(user).not.toHaveProperty('image');
  });

  it('finds a pasted name that carries a zero-width space or a leading @', async () => {
    expect(await names('SynthMiner​')).toEqual(['SynthMiner', 'SynthMinerAlt']);
    expect(await names('​@SynthMiner ')).toEqual(['SynthMiner', 'SynthMinerAlt']);
  });

  it('puts the account with a pasted id first, then usernames that start with those digits', async () => {
    expect(await names('990004992')).toEqual(['SynthMiner', '990004992fan']);
    expect(await names('#990004992')).toEqual(['SynthMiner', '990004992fan']);
  });

  it('treats an underscore as itself, not as any character', async () => {
    expect(await names('Synth_')).toEqual(['Synth_Miner']);
  });

  it('never offers the system account or a deleted one, and survives an over-long id', async () => {
    expect(await names('civ')).toEqual([]);
    expect(await names('-1')).toEqual([]);
    expect(await names('99999999999')).toEqual([]);
    expect(await names('SynthMinerG')).toEqual([]);
  });
});

describe('User Lookup, which resolves one account from a pasted term', () => {
  it('resolves a pasted name with a zero-width space or a leading @, and a #id', async () => {
    expect(await resolveUserId('​@SynthMiner')).toBe(990004992);
    expect(await resolveUserId('#990004992')).toBe(990004992);
  });
});
