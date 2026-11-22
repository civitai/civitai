import { describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mintAccessToken, resolveAccessToken } from '@civitai/db-queries/access-token';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

// The main database's AccessToken table as Prisma declares it: zoneless timestamps holding UTC.
async function mainDb() {
  const pg = await freshPglite();
  await pg.exec(`
    SET TIME ZONE 'America/Denver';
    CREATE TABLE "AccessToken" (
      id serial PRIMARY KEY,
      "resourceType" text NOT NULL,
      "resourceId" integer NOT NULL,
      "tokenHash" text NOT NULL UNIQUE,
      "createdById" integer NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" timestamp(3) NOT NULL,
      "revokedAt" timestamp(3)
    );`);
  return { pg, db: new Kysely<DB>({ dialect: pgliteDialect(pg) }) };
}

describe('case link tokens', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const in30d = new Date(now.getTime() + 30 * 86_400_000);

  it('a minted token resolves to its party, and only for that kind of resource', async () => {
    const { db } = await mainDb();
    const token = await mintAccessToken(db, {
      resourceType: 'CaseParty',
      resourceId: 42,
      createdById: -1,
      expiresAt: in30d,
    });
    expect((await resolveAccessToken(db, token, 'CaseParty', now))?.resourceId).toBe(42);
    expect(await resolveAccessToken(db, token, 'Article', now)).toBeNull();
  });

  it('stores only the hash, and the expiry as UTC whatever the session time zone', async () => {
    const { pg, db } = await mainDb();
    const token = await mintAccessToken(db, {
      resourceType: 'CaseParty',
      resourceId: 1,
      createdById: -1,
      expiresAt: in30d,
    });
    const row = (
      await pg.query<{ tokenHash: string; exp: string }>(
        `SELECT "tokenHash", to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI') AS exp FROM "AccessToken"`
      )
    ).rows[0];
    expect(row.tokenHash).not.toBe(token);
    expect(row.exp).toBe(in30d.toISOString().slice(0, 16));
  });

  it('an expired or revoked token resolves to nothing', async () => {
    const { pg, db } = await mainDb();
    const token = await mintAccessToken(db, {
      resourceType: 'CaseParty',
      resourceId: 1,
      createdById: -1,
      expiresAt: in30d,
    });
    expect(
      await resolveAccessToken(db, token, 'CaseParty', new Date(in30d.getTime() + 1000))
    ).toBeNull();
    await pg.exec(`UPDATE "AccessToken" SET "revokedAt" = now()`);
    expect(await resolveAccessToken(db, token, 'CaseParty', now)).toBeNull();
  });

  it('an unknown token resolves to nothing', async () => {
    const { db } = await mainDb();
    expect(await resolveAccessToken(db, 'not-a-token', 'CaseParty', now)).toBeNull();
  });
});
