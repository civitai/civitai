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
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';

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

const { dbHandle } = vi.hoisted(() => {
  // The real token hash needs a salt; the userinfo case looks its ApiKey up by that hash.
  vi.stubEnv('NEXTAUTH_SECRET', 'pglite-test-secret');
  return { dbHandle: { current: null as unknown } };
});
vi.mock('../../db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../redis', () => ({ getRedis: () => null, getSysRedis: () => null }));

const { produceSessionUser } = await import('../session-producer');
const { GET: userinfo } = await import('../../../../routes/api/auth/oauth/userinfo/+server');

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
  CREATE TABLE "Image" (
    "id" INTEGER PRIMARY KEY, "url" TEXT, "needsReview" TEXT, "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
    "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "blockedFor" TEXT,
    "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false, "metadata" JSONB NOT NULL DEFAULT '{}',
    "scanJobs" JSONB, "modelRestricted" BOOLEAN NOT NULL DEFAULT false, "userId" INTEGER
  );
  CREATE TABLE "ApiKey" (
    "key" TEXT PRIMARY KEY, "userId" INTEGER, "type" TEXT, "expiresAt" TIMESTAMP,
    "tokenScope" INTEGER NOT NULL, "tokenScopeWide" BIGINT
  );
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

describe('produceSessionUser — the profile picture', () => {
  it.each([
    [null, 'pic.jpg'],
    ['poi', 'pic.jpg'],
    ['csam', 'legacy.jpg'],
    ['minor', 'legacy.jpg'],
  ])('a picture held %s gives the session image %s', async (hold, image) => {
    await pg.query(`INSERT INTO "Image" ("id", "url", "needsReview") VALUES (1, 'pic.jpg', $1)`, [
      hold,
    ]);
    await pg.query(
      `UPDATE "User" SET "profilePictureId" = 1, "image" = 'legacy.jpg' WHERE "id" = $1`,
      [BUILDER]
    );
    expect((await produceSessionUser(BUILDER))?.image).toBe(image);
  });

  it.each([
    ['csam', 'https://cdn.example/PIC.JPG/width=96', undefined],
    ['minor', 'pic.jpg', undefined],
    ['poi', 'pic.jpg', 'pic.jpg'],
  ])(
    'a picture held %s with User.image %s naming it gives the session image %s',
    async (hold, legacy, image) => {
      await pg.query(`INSERT INTO "Image" ("id", "url", "needsReview") VALUES (1, 'pic.jpg', $1)`, [
        hold,
      ]);
      await pg.query(`UPDATE "User" SET "profilePictureId" = 1, "image" = $2 WHERE "id" = $1`, [
        BUILDER,
        legacy,
      ]);
      expect((await produceSessionUser(BUILDER))?.image).toBe(image);
    }
  );
});

describe('produceSessionUser — a blocked profile picture', () => {
  const blocks = [
    ['Blocked ingestion', `"ingestion" = 'Blocked'`],
    ['the Blocked level', `"nsfwLevel" = 32`],
    ['a block reason', `"blockedFor" = 'tos'`],
  ];

  it.each(blocks)('carrying %s is not the session image', async (_marker, set) => {
    await pg.query(`INSERT INTO "Image" ("id", "url") VALUES (1, 'pic.jpg')`);
    await pg.query(`UPDATE "Image" SET ${set} WHERE "id" = 1`);
    await pg.query(
      `UPDATE "User" SET "profilePictureId" = 1, "image" = 'legacy.jpg' WHERE "id" = $1`,
      [BUILDER]
    );
    expect((await produceSessionUser(BUILDER))?.image).toBe('legacy.jpg');
  });

  it.each(blocks)('carrying %s leaves out a User.image naming it', async (_marker, set) => {
    await pg.query(`INSERT INTO "Image" ("id", "url") VALUES (1, 'pic.jpg')`);
    await pg.query(`UPDATE "Image" SET ${set} WHERE "id" = 1`);
    await pg.query(
      `UPDATE "User" SET "profilePictureId" = 1, "image" = 'https://cdn.example/PIC.JPG/width=96' WHERE "id" = $1`,
      [BUILDER]
    );
    expect((await produceSessionUser(BUILDER))?.image).toBeUndefined();
  });
});

describe('produceSessionUser — an unscanned profile picture', () => {
  const NAMING = 'https://cdn.example/PIC.JPG/width=96';
  const picture = async (ingestion: string, nsfwLevel: number, image: string) => {
    await pg.query(
      `INSERT INTO "Image" ("id", "url", "ingestion", "nsfwLevel") VALUES (1, 'pic.jpg', $1, $2)`,
      [ingestion, nsfwLevel]
    );
    await pg.query(`UPDATE "User" SET "profilePictureId" = 1, "image" = $2 WHERE "id" = $1`, [
      BUILDER,
      image,
    ]);
  };

  it('🔴 a Pending picture, with User.image naming it, is not the session image', async () => {
    await picture('Pending', 0, NAMING);
    expect((await produceSessionUser(BUILDER))?.image).toBeUndefined();
  });

  it('the same picture once Scanned is the session image (control)', async () => {
    await picture('Scanned', 1, NAMING);
    expect((await produceSessionUser(BUILDER))?.image).toBe('pic.jpg');
  });

  it('🔴 a Pending picture leaves a User.image that names another picture', async () => {
    await picture('Pending', 0, 'legacy.jpg');
    expect((await produceSessionUser(BUILDER))?.image).toBe('legacy.jpg');
  });

  it.each([
    { state: 'Pending at a rated level', set: `"ingestion" = 'Pending'`, image: undefined },
    { state: 'Scanned but unrated', set: `"nsfwLevel" = 0`, image: undefined },
    {
      state: 'mature on a restricted model',
      set: `"nsfwLevel" = 4, "modelRestricted" = true`,
      image: undefined,
    },
    { state: 'PG on a restricted model', set: `"modelRestricted" = true`, image: 'pic.jpg' },
    {
      state: 'locked, Pending',
      set: `"ingestion" = 'Pending', "nsfwLevelLocked" = true`,
      image: 'pic.jpg',
    },
    {
      state: 'locked, Error',
      set: `"ingestion" = 'Error', "nsfwLevelLocked" = true`,
      image: 'pic.jpg',
    },
    {
      state: 'locked, Error from a Knights vote',
      set: `"ingestion" = 'Error', "nsfwLevelLocked" = true,
       "metadata" = jsonb_build_object('nsfwLevelReason', '${KNIGHTS_VOTE_NSFW_LEVEL_REASON}')`,
      image: undefined,
    },
    {
      state: 'locked, Error from a permanent scan failure',
      set: `"ingestion" = 'Error', "nsfwLevelLocked" = true,
       "scanJobs" = '{"error": {"failureClass": "permanent"}}'`,
      image: undefined,
    },
  ])('a picture $state gives the session image $image', async ({ set, image }) => {
    await picture('Scanned', 1, NAMING);
    await pg.query(`UPDATE "Image" SET ${set} WHERE "id" = 1`);
    expect((await produceSessionUser(BUILDER))?.image).toBe(image);
  });

  describe('the OAuth userinfo picture claim', () => {
    const TOKEN = 'civitai_userinfo_test';
    const claims = async () => {
      await pg.query(
        `INSERT INTO "ApiKey" ("key", "userId", "type", "tokenScope") VALUES ($1, $2, 'Access', $3)`,
        [generateSecretHash(TOKEN), BUILDER, TokenScope.UserRead]
      );
      const response = await userinfo({
        request: new Request('https://auth.civitai.com/api/auth/oauth/userinfo', {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      } as never);
      expect(response.status).toBe(200);
      return (await response.json()) as { picture?: string | null };
    };

    it('🔴 is absent for a Pending picture', async () => {
      await picture('Pending', 0, NAMING);
      expect((await claims()).picture ?? null).toBeNull();
    });

    it('is the url of a Scanned picture (control)', async () => {
      await picture('Scanned', 1, NAMING);
      expect((await claims()).picture).toBe('pic.jpg');
    });
  });
});

describe("produceSessionUser — a User.image naming another of the user's own images", () => {
  const OLD_KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';
  const staleKey = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${OLD_KEY.toUpperCase()}/width=96`;
  // The profile picture is still scanning, so the session falls back to User.image.
  const seed = async (oldImage: string, image: string, owner = BUILDER) => {
    await pg.query(
      `INSERT INTO "Image" ("id", "url", "ingestion", "nsfwLevel", "userId") VALUES
         (1, 'pic.jpg', 'Pending', 0, $1), (2, $2, 'Scanned', 1, $3)`,
      [BUILDER, OLD_KEY, owner]
    );
    await pg.query(`UPDATE "Image" SET ${oldImage} WHERE "id" = 2`);
    await pg.query(`UPDATE "User" SET "profilePictureId" = 1, "image" = $2 WHERE "id" = $1`, [
      BUILDER,
      image,
    ]);
  };

  it.each([
    ['blocked', `"blockedFor" = 'tos'`],
    ['held', `"needsReview" = 'csam'`],
    ['unscanned', `"ingestion" = 'Pending', "nsfwLevel" = 0`],
  ])('🔴 is not the session image when that image is %s', async (_state, set) => {
    await seed(set, staleKey);
    expect((await produceSessionUser(BUILDER))?.image).toBeUndefined();
  });

  it('is the session image when that image is servable (control)', async () => {
    await seed(`"nsfwLevel" = 1`, staleKey);
    expect((await produceSessionUser(BUILDER))?.image).toBe(staleKey);
  });

  it('leaves an external avatar url, even with a blocked upload in the history', async () => {
    const external = 'https://avatars.githubusercontent.com/u/1?v=4';
    await seed(`"blockedFor" = 'tos'`, external);
    expect((await produceSessionUser(BUILDER))?.image).toBe(external);
  });
});
