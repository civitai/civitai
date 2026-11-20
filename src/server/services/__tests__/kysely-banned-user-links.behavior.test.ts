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

/**
 * The Kysely reads that serve a user's links, run for real (the hot-reads parity schemas, on
 * PGlite): a banned user's links are not served, though the rows stay, since a ban whose profile
 * archive failed keeps them as evidence. An unbanned user's are.
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
  return { pg, db };
}
afterAll(async () => {
  for (const { pg, db } of open) {
    await db.destroy();
    await pg.close();
  }
});

// User 1 is banned, user 2 is not; each has one link.
const SEED = `
  INSERT INTO "User" (id, username, "bannedAt") VALUES (1, 'a', now()), (2, 'b', NULL);
  INSERT INTO "UserLink" (id, "userId", url, type) VALUES
    (1, 1, 'https://example.com/banned', 'Social'), (2, 2, 'https://example.com/ok', 'Social');
`;

describe('Kysely link reads skip a banned user', () => {
  it('creator card (hot reads 2)', async () => {
    const { pg, db } = await database('hot-reads-2-parity-schema.sql', 'hot_reads_2_parity', SEED);
    const links = async (id: number) =>
      (await getUserCreatorRow(db, { id, systemUserId: -1, systemUsername: 'civitai' }))?.links;
    expect(await links(1)).toEqual([]);
    expect(await links(2)).toHaveLength(1);
    expect((await pg.query(`SELECT 1 FROM "UserLink" WHERE "userId" = 1`)).rows).toHaveLength(1);
  });

  it('profile (hot reads 9)', async () => {
    const { db } = await database('hot-reads-9-parity-schema.sql', 'hot_reads_9_parity', SEED);
    const links = async (id: number) => (await getUserWithProfileRow(db, { id }))?.links;
    expect(await links(1)).toEqual([]);
    expect(await links(2)).toHaveLength(1);
  });
});
