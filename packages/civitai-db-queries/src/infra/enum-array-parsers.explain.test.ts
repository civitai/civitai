import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { registerEnumArrayTypeParsers } from '@civitai/db/kysely';
import { testDbUrl } from '../test/harness';

// DB-backed: proves `registerEnumArrayTypeParsers` (from @civitai/db) makes pg parse Postgres enum-ARRAY
// columns as string[] instead of the raw `{a,b}` literal. Uses a literal enum-array cast so it needs no table
// rows — only that the `CommercialUse` enum exists in the schema. Skips when no DB URL is configured.
const url = testDbUrl();

// Force sslmode=no-verify for the cnpg pooler's self-signed cert (createKyselyClients does this internally;
// this raw test Pool must do it too). Production is unaffected — instrumentation passes the app's pre-built,
// SSL-configured pgDbWrite pool.
function noVerify(u: string): string {
  const parsed = new URL(u);
  parsed.searchParams.set('sslmode', 'no-verify');
  return parsed.toString();
}

describe.skipIf(!url)('registerEnumArrayTypeParsers (DB-backed)', () => {
  // The Pool is built in `beforeAll`, not in the describe body. Vitest EXECUTES a describe
  // callback during collection even when `skipIf` is true — it only skips the `it`s — so a
  // `new Pool({ connectionString: noVerify(undefined) })` here ran with no DB URL configured
  // and threw `TypeError: Invalid URL` out of `new URL(undefined)`. That is not a failing
  // test: it fails the whole FILE to import, which Vitest reports as "1 failed test file"
  // with no test count at all. The suite was DB-less-safe in intent and not in fact, and it
  // stayed that way because nothing in CI ran this package (fixed in the same change).
  // `beforeAll` hooks do not run for a skipped suite, so the guard now actually holds.
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: noVerify(url as string), max: 1 });
  });
  afterAll(() => pool?.end());

  it('parses an enum[] result as a JS array (was a raw literal string before registration)', async () => {
    // Before registration pg has no parser for the enum's dynamic array oid → raw literal string.
    const before = await pool.query<{ x: unknown }>(`SELECT ARRAY['Sell']::"CommercialUse"[] AS x`);
    expect(typeof before.rows[0].x).toBe('string');
    expect(before.rows[0].x).toBe('{Sell}');

    await registerEnumArrayTypeParsers(pool);

    const after = await pool.query<{ x: unknown }>(`SELECT ARRAY['Sell']::"CommercialUse"[] AS x`);
    expect(Array.isArray(after.rows[0].x)).toBe(true);
    expect(after.rows[0].x).toEqual(['Sell']);
  });
});
