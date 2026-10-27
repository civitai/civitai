import { randomBytes } from 'node:crypto';

import pg from 'pg';

/** A throwaway Postgres server the suites may create and drop databases on. Unset, they skip. */
export const TEST_DATABASE_URL = process.env.ASSISTANT_RUNNER_TEST_DATABASE_URL;

/** A new, empty database on the test server, and how to drop it. */
export async function freshDatabase(
  prefix: string
): Promise<{ url: string; drop(): Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set');
  const name = `ar_${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Every row of every table in `schema` whose text contains `needle`, as `table: row` lines. */
export async function rowsContaining(
  url: string,
  schema: string,
  needle: string
): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: tables } = await client.query<{ name: string }>(
      `select table_name as name from information_schema.tables where table_schema = $1`,
      [schema]
    );
    const found: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ row: string }>(
        `select t::text as row from "${schema}"."${name}" t where t::text like $1`,
        [`%${needle}%`]
      );
      for (const { row } of rows) found.push(`${name}: ${row.slice(0, 200)}`);
    }
    return found;
  } finally {
    await client.end();
  }
}

/** How many tables `schema` has: the scan above is only worth something when this is not 0. */
export async function tableCount(url: string, schema: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = $1`,
      [schema]
    );
    return rows[0]!.n;
  } finally {
    await client.end();
  }
}
