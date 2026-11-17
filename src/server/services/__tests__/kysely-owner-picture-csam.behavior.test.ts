import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { Kysely, PostgresDialect } from 'kysely';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { getUserCreatorRow } from '@civitai/db-queries/hot-reads';
import { getUserWithProfileRow } from '@civitai/db-queries/hot-reads-9';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import { readModelVersionOwnerViaKysely } from '~/server/services/hot-reads-6.reads';
import { readCollectionByIdViaKysely } from '~/server/services/hot-reads-10.reads';
import { profilePictureOf } from '~/server/services/user-creator.reads';

/**
 * The Kysely reads that carry a user's profile picture, run for real (the hot-reads parity
 * schemas, on PGlite): a Scanned picture flagged `csam` comes back as none, a clean one as itself.
 * What decides it is the `needsReview` column each query selects.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const open: { pg: PGlite; db: Kysely<DB> }[] = [];

async function database(fixture: string, schema: string, seed: string) {
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
afterAll(async () => {
  for (const { pg, db } of open) {
    await db.destroy();
    await pg.close();
  }
});

// User 1's picture is flagged csam, user 2's is clean; both Scanned.
const PICTURES = `
  INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview") VALUES
    (11, 'flagged', 1, 'Scanned', 'csam'), (12, 'clean', 2, 'Scanned', NULL);
`;

describe('Kysely profile picture reads drop a csam-flagged picture', () => {
  it('model version owner (hot reads 6, also post detail)', async () => {
    const db = await database(
      'hot-reads-6-parity-schema.sql',
      'hot_reads_6_parity',
      `${PICTURES}
      INSERT INTO "User" (id, "profilePictureId") VALUES (1, 11), (2, 12);
      INSERT INTO "Model" (id, "userId") VALUES (1, 1), (2, 2);
      INSERT INTO "ModelVersion" (id, "modelId") VALUES (1, 1), (2, 2);`
    );
    expect((await readModelVersionOwnerViaKysely(db, 1))?.model.user.profilePicture).toBeNull();
    expect((await readModelVersionOwnerViaKysely(db, 2))?.model.user.profilePicture?.url).toBe(
      'clean'
    );
  });

  it('collection owner (hot reads 10)', async () => {
    const db = await database(
      'hot-reads-10-parity-schema.sql',
      'hot_reads_10_parity',
      `${PICTURES}
      INSERT INTO "User" (id, "profilePictureId") VALUES (1, 11), (2, 12);
      INSERT INTO "Collection" (id, name, "userId") VALUES (1, 'a', 1), (2, 'b', 2);`
    );
    expect((await readCollectionByIdViaKysely(db, 1))?.user.profilePicture).toBeNull();
    expect((await readCollectionByIdViaKysely(db, 2))?.user.profilePicture?.url).toBe('clean');
  });

  it('profile (hot reads 9), for every viewer', async () => {
    const db = await database(
      'hot-reads-9-parity-schema.sql',
      'hot_reads_9_parity',
      `${PICTURES}
      INSERT INTO "User" (id, username, "profilePictureId") VALUES (1, 'a', 11), (2, 'b', 12);`
    );
    const row = async (id: number) => profilePictureOf((await getUserWithProfileRow(db, { id }))!);
    expect(await row(1)).toBeNull();
    expect((await row(2))?.url).toBe('clean');
  });

  it('creator card (hot reads 2)', async () => {
    const db = await database(
      'hot-reads-2-parity-schema.sql',
      'hot_reads_2_parity',
      `${PICTURES}
      INSERT INTO "User" (id, username, "profilePictureId") VALUES (1, 'a', 11), (2, 'b', 12);`
    );
    const row = async (id: number) =>
      profilePictureOf(
        (await getUserCreatorRow(db, { id, systemUserId: -1, systemUsername: 'civitai' }))!
      );
    expect(await row(1)).toBeNull();
    expect((await row(2))?.url).toBe('clean');
  });
});
