import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app-builder grant, at the ONE place it is derived: the hub's session producer, run for real
 * against Postgres with the hand-applied `AppAccessRequest` migration.
 *
 * Every path the main app builds a Flipt context from — the civ-token session (SSR, tRPC), API keys
 * and OAuth bearer tokens, block tokens resolved through `getSessionUserById` — reads the SessionUser
 * this function produces. So "approve → `appBuilderApproved` true" and "decline/revoke → absent" are
 * decided by the query here; a mock of the query builder could not tell a correct `EXISTS` from one
 * that ignores the status or keys on the wrong user.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../../db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../redis', () => ({ getRedis: () => null, getSysRedis: () => null }));

const { produceSessionUser } = await import('../session-producer');

const MIGRATION = join(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations/20261204120000_app_access_request/migration.sql'
);

// The tables the producer's query reads, cut to the columns it selects.
const PRELUDE = `
  CREATE TABLE "User" (
    "id" INTEGER PRIMARY KEY, "username" TEXT, "name" TEXT, "email" TEXT, "emailVerified" TIMESTAMP,
    "image" TEXT, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "isModerator" BOOLEAN,
    "showNsfw" BOOLEAN NOT NULL DEFAULT false, "blurNsfw" BOOLEAN NOT NULL DEFAULT true,
    "browsingLevel" INTEGER NOT NULL DEFAULT 1, "onboarding" INTEGER NOT NULL DEFAULT 0,
    "muted" BOOLEAN NOT NULL DEFAULT false, "mutedAt" TIMESTAMP, "bannedAt" TIMESTAMP,
    "deletedAt" TIMESTAMP, "customerId" TEXT, "paddleCustomerId" TEXT, "autoplayGifs" BOOLEAN,
    "leaderboardShowcase" TEXT, "filePreferences" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}', "meta" JSONB NOT NULL DEFAULT '{}',
    "profilePictureId" INTEGER
  );
  CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT);
  CREATE TABLE "UserReferral" ("id" INTEGER PRIMARY KEY, "userId" INTEGER);
  CREATE TABLE "Product" ("id" TEXT PRIMARY KEY, "metadata" JSONB);
  CREATE TABLE "CustomerSubscription" (
    "id" TEXT PRIMARY KEY, "userId" INTEGER, "status" TEXT, "buzzType" TEXT, "productId" TEXT
  );
  CREATE TABLE "UserRole" ("userId" INTEGER, "role" TEXT);
  CREATE TABLE "UserMembershipOverride" ("userId" INTEGER PRIMARY KEY, "tier" TEXT);
`;

// Distinct ids, so a query keyed on the wrong user cannot pass by accident.
const BUILDER = 7101;
const NEIGHBOUR = 7202;
const MODERATOR = 7303;

let pg: PGlite;

/** Kysely over in-process PGlite: one connection, no pool, no transactions needed here. */
function pgliteDialect(db: PGlite): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('the session producer does not stream');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

const request = (userId: number, status: 'pending' | 'approved' | 'declined') =>
  pg.query(
    `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "status", "reviewedAt", "reviewedById")
     VALUES ($1, 'A storyboard app for my comic panels, one page at a time.', $2, $3, $4)`,
    status === 'pending' ? [userId, status, null, null] : [userId, status, new Date(), MODERATOR]
  );

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  await pg.query(
    `INSERT INTO "User" ("id", "username", "settings") VALUES ($1, 'storyboarder', '{}'),
       ($2, 'neighbour', '{}'), ($3, 'reviewer', '{}')`,
    [BUILDER, NEIGHBOUR, MODERATOR]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('produceSessionUser — appBuilderApproved comes from AppAccessRequest', () => {
  it('🔴 an approved request puts appBuilderApproved: true on THAT user’s session only', async () => {
    await request(BUILDER, 'approved');
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBe(true);
    expect((await produceSessionUser(NEIGHBOUR))?.appBuilderApproved).toBeUndefined();
  });

  it('🔴 a pending or declined request grants nothing', async () => {
    await request(BUILDER, 'pending');
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBeUndefined();
    await pg.query(`DELETE FROM "AppAccessRequest"`);
    await request(BUILDER, 'declined');
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBeUndefined();
  });

  it('🔴 a revoke (approved → declined) takes it away on the next produce', async () => {
    await request(BUILDER, 'approved');
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBe(true);
    await pg.query(
      `UPDATE "AppAccessRequest" SET "status" = 'declined', "reviewedAt" = now() WHERE "userId" = $1`,
      [BUILDER]
    );
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBeUndefined();
  });

  it('an approval survives a later declined row in the history', async () => {
    await request(BUILDER, 'declined');
    await request(BUILDER, 'approved');
    expect((await produceSessionUser(BUILDER))?.appBuilderApproved).toBe(true);
  });

  it('🔴 the user cannot grant it to themselves through settings', async () => {
    // `User.settings` is the user-writable blob; a key there must not reach the session field.
    await pg.query(`UPDATE "User" SET "settings" = $2 WHERE "id" = $1`, [
      BUILDER,
      JSON.stringify({ appBuilderApproved: true, isEarlyAdopter: true }),
    ]);
    const user = await produceSessionUser(BUILDER);
    // Positive control: the same blob's projected key DID reach the session, so the settings
    // read ran and the absence below is not an unread blob.
    expect(user?.isEarlyAdopter).toBe(true);
    expect(user?.appBuilderApproved).toBeUndefined();
  });
});
