import { afterAll, describe, expect, it } from 'vitest';
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
  const pool = new Pool({ connectionString: noVerify(url as string), max: 1 });
  afterAll(() => pool.end());

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
