import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { Kysely, PostgresDialect } from 'kysely';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import { gateProfilePictures } from '~/server/db/servable-profile-picture.extension';
import { readModelVersionOwnerViaKysely } from '~/server/services/hot-reads-6.reads';
import {
  readUserWithProfileAndPictureGateViaKysely,
  readUserWithProfileViaKysely,
} from '~/server/services/hot-reads-9.reads';
import { readCollectionByIdViaKysely } from '~/server/services/hot-reads-10.reads';
import { readUsersWithCosmeticsViaKysely } from '~/server/services/hot-reads-12.reads';
import {
  fallbackUserImage,
  servableProfilePicture,
} from '~/server/services/profile-picture.servable';
import {
  fallbackUserImageColumn,
  servableProfilePictureSql,
} from '~/server/services/profile-picture.sql';
import { readUserCreatorViaKysely } from '~/server/services/user-creator.reads';

// A picture with a block marker is no visitor's avatar, and a User.image naming it no fallback.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const open: { pg: PGlite; db?: Kysely<DB> }[] = [];
afterAll(async () => {
  for (const { pg, db } of open) {
    await db?.destroy();
    await pg.close();
  }
});

// User id = picture id; each user's `User.image` names its own picture.
const CASES = [
  { id: 1, url: 'key-ingestion', ingestion: 'Blocked', nsfwLevel: 1, blockedFor: null },
  { id: 2, url: 'key-level', ingestion: 'Scanned', nsfwLevel: 32, blockedFor: null },
  { id: 3, url: 'key-reason', ingestion: 'Scanned', nsfwLevel: 1, blockedFor: 'tos' },
  { id: 4, url: 'key-clean', ingestion: 'Scanned', nsfwLevel: 1, blockedFor: null },
] as const;
const BLOCKED_IDS = [1, 2, 3];
const CLEAN_ID = 4;
const imageOf = (url: string) => `https://cdn.example/${url}/width=96`;

const imageRows = CASES.map(
  (c) =>
    `(${c.id}, '${c.url}', ${c.id}, '${c.ingestion}', ${c.nsfwLevel}, ${
      c.blockedFor ? `'${c.blockedFor}'` : 'NULL'
    })`
).join(', ');
const IMAGES = `INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevel", "blockedFor") VALUES ${imageRows};`;

async function kysely(fixture: string, schema: string, seed: string) {
  const pg = new PGlite({ extensions: { citext } });
  for (const statement of loadParitySchema(resolve(here, `fixtures/${fixture}`)))
    await pg.exec(statement);
  await pg.exec(`SET search_path TO ${schema}; ${seed}`);
  const client = {
    query: async (sql: string, params: unknown[]) => {
      const result = await pg.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    release: () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: { connect: async () => client, end: async () => undefined } as never,
    }),
  });
  open.push({ pg, db });
  return db;
}

describe('the SQL and TS twins agree on block markers', () => {
  it('servableProfilePictureSql and servableProfilePicture reject each marked picture and serve the clean one', async () => {
    const pg = new PGlite();
    open.push({ pg });
    await pg.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
      CREATE TABLE "Image" (
        id int PRIMARY KEY, url text, "userId" int, ingestion "ImageIngestionStatus" NOT NULL,
        "nsfwLevel" int NOT NULL, "needsReview" text, "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
        metadata jsonb, "scanJobs" jsonb, "modelRestricted" boolean NOT NULL DEFAULT false,
        "blockedFor" text
      );
      ${IMAGES}
    `);
    const sql = servableProfilePictureSql;
    const { rows } = await pg.query<{ id: number }>(
      `SELECT i.id FROM "Image" i WHERE ${sql.text} ORDER BY i.id`,
      sql.values as unknown[]
    );
    const servedBySql = rows.map((row) => row.id);
    const servedByTs = CASES.filter((c) =>
      servableProfilePicture({ ...c }, null, false, c.blockedFor)
    ).map((c) => c.id);
    expect(servedBySql).toEqual([CLEAN_ID]);
    expect(servedByTs).toEqual(servedBySql);
  });

  it('fallbackUserImageColumn and fallbackUserImage drop each User.image naming a marked picture', async () => {
    const pg = new PGlite();
    open.push({ pg });
    await pg.exec(`
      CREATE TABLE "Image" (
        id int PRIMARY KEY, url text, "userId" int, "needsReview" text, ingestion text NOT NULL,
        "nsfwLevel" int NOT NULL, "blockedFor" text
      );
      CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, image text);
      ${IMAGES}
      INSERT INTO "User" (id, "profilePictureId", image) VALUES
        ${CASES.map((c) => `(${c.id}, ${c.id}, '${imageOf(c.url)}')`).join(', ')};
    `);
    const { rows } = await pg.query<{ image: string | null }>(
      `SELECT ${fallbackUserImageColumn} AS image FROM "User" u ORDER BY u.id`
    );
    const bySql = rows.map((row) => row.image);
    const byTs = CASES.map((c) => fallbackUserImage(imageOf(c.url), { ...c, needsReview: null }));
    expect(bySql).toEqual([null, null, null, imageOf('key-clean')]);
    expect(byTs).toEqual(bySql);
  });
});

describe('the Prisma servable-profile-picture extension', () => {
  it('nulls a marked picture and a sibling User.image naming it, reading blockedFor even when the select omits it', async () => {
    const args = { select: { image: true, profilePicture: { select: { id: true, url: true } } } };
    let sent: unknown;
    const result = await gateProfilePictures(
      args,
      async (queryArgs) => {
        sent = queryArgs;
        return CASES.map((c) => ({
          image: imageOf(c.url),
          profilePicture: { ...c, needsReview: null, modelRestricted: false },
        }));
      },
      () => undefined
    );
    expect(
      (sent as { select: { profilePicture: { select: Record<string, boolean> } } }).select
        .profilePicture.select.blockedFor
    ).toBe(true);
    expect(result.map((row) => row.image)).toEqual([null, null, null, imageOf('key-clean')]);
    expect(result.map((row) => row.profilePicture?.id ?? null)).toEqual([
      null,
      null,
      null,
      CLEAN_ID,
    ]);
    expect(result[3].profilePicture).not.toHaveProperty('blockedFor');
  });
});

describe('the Kysely user reads', () => {
  const USERS = `INSERT INTO "User" (id, username, "profilePictureId", image) VALUES ${CASES.map(
    (c) => `(${c.id}, 'u${c.id}', ${c.id}, '${imageOf(c.url)}')`
  ).join(', ')};`;

  it('creator card: neither the picture nor a User.image naming it, for a marked picture', async () => {
    const db = await kysely(
      'hot-reads-2-parity-schema.sql',
      'hot_reads_2_parity',
      `${IMAGES} ${USERS}`
    );
    for (const id of BLOCKED_IDS) {
      const read = await readUserCreatorViaKysely(db, { id });
      expect(read?.user.profilePicture).toBeNull();
      expect(read?.user.image).toBeNull();
    }
    const clean = await readUserCreatorViaKysely(db, { id: CLEAN_ID });
    expect(clean?.user.profilePicture?.url).toBe('key-clean');
    expect(clean?.user.image).toBe(imageOf('key-clean'));
  });

  it("profile: no User.image naming a marked picture, and the picture's blockedFor beside it", async () => {
    const db = await kysely(
      'hot-reads-9-parity-schema.sql',
      'hot_reads_9_parity',
      `${IMAGES} ${USERS}`
    );
    for (const id of BLOCKED_IDS)
      expect((await readUserWithProfileViaKysely(db, { id })).image).toBeNull();
    expect((await readUserWithProfileViaKysely(db, { id: CLEAN_ID })).image).toBe(
      imageOf('key-clean')
    );
    const gates = [];
    for (const c of CASES)
      gates.push(
        (await readUserWithProfileAndPictureGateViaKysely(db, { id: c.id })).pictureBlockedFor
      );
    expect(gates).toEqual(CASES.map((c) => c.blockedFor));
  });
});

describe('the other Kysely reads carrying a profile picture and User.image', () => {
  const PLAIN_USERS = `INSERT INTO "User" (id, "profilePictureId", image) VALUES ${CASES.map(
    (c) => `(${c.id}, ${c.id}, '${imageOf(c.url)}')`
  ).join(', ')};`;
  const ids = CASES.map((c) => c.id).join(', ');
  const servedOnly = (served: (number | null)[]) =>
    expect(served).toEqual(CASES.map((c) => (c.id === CLEAN_ID ? CLEAN_ID : null)));
  const fallbackOnlyClean = (images: (string | null | undefined)[]) =>
    expect(images).toEqual(CASES.map((c) => (c.id === CLEAN_ID ? imageOf(c.url) : null)));

  it('model version owner (hot reads 6, also post detail)', async () => {
    const db = await kysely(
      'hot-reads-6-parity-schema.sql',
      'hot_reads_6_parity',
      `${IMAGES} ${PLAIN_USERS}
      INSERT INTO "Model" (id, "userId") SELECT id, id FROM unnest(ARRAY[${ids}]) id;
      INSERT INTO "ModelVersion" (id, "modelId") SELECT id, id FROM unnest(ARRAY[${ids}]) id;`
    );
    const users = [];
    for (const c of CASES) users.push((await readModelVersionOwnerViaKysely(db, c.id))?.model.user);
    servedOnly(users.map((u) => u?.profilePicture?.id ?? null));
    fallbackOnlyClean(users.map((u) => u?.image));
  });

  it('collection owner (hot reads 10)', async () => {
    const db = await kysely(
      'hot-reads-10-parity-schema.sql',
      'hot_reads_10_parity',
      `${IMAGES} ${PLAIN_USERS}
      INSERT INTO "Collection" (id, name, "userId") SELECT id, 'c' || id, id FROM unnest(ARRAY[${ids}]) id;`
    );
    const users = [];
    for (const c of CASES) users.push((await readCollectionByIdViaKysely(db, c.id))?.user);
    servedOnly(users.map((u) => u?.profilePicture?.id ?? null));
    fallbackOnlyClean(users.map((u) => u?.image));
  });

  it('users with cosmetics (hot reads 12)', async () => {
    const db = await kysely(
      'hot-reads-12-parity-schema.sql',
      'hot_reads_12_parity',
      `${IMAGES} INSERT INTO "User" (id, username, "profilePictureId", image) VALUES ${CASES.map(
        (c) => `(${c.id}, 'u${c.id}', ${c.id}, '${imageOf(c.url)}')`
      ).join(', ')};`
    );
    const users = await readUsersWithCosmeticsViaKysely(
      db,
      CASES.map((c) => c.id)
    );
    servedOnly(CASES.map((c) => users.get(c.id)?.profilePicture?.id ?? null));
    fallbackOnlyClean(CASES.map((c) => users.get(c.id)?.image));
  });
});
