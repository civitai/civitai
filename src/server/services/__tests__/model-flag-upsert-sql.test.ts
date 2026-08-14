import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildModelFlagUpsert } from '~/server/services/model-flag.sql';

/**
 * Execution + structure gate for the `ModelFlag` upsert.
 *
 * WHY THIS EXISTS: the statement shipped broken for 15.5 months. Three
 * punctuation defects, each masking the next — a missing comma between the
 * `details` and `sfwOnly` values, a missing comma in the DO UPDATE SET list,
 * and a trailing comma before RETURNING — plus a `Prisma.JsonNull` that lands
 * as `{}` rather than SQL NULL. Every one of them is invisible to a mock: a
 * raw SQL string is just a string until something parses it, and nothing in
 * the suite ever did. Content flagging recorded nothing for 15.5 months.
 *
 * TWO ARMS, deliberately:
 *
 *  - `structure` always runs. It re-derives the statement's shape from the
 *    generated text — arity of the VALUES list against the column list, and
 *    the DO UPDATE assignments — so the exact three defects cannot come back
 *    silently in CI. It is a backstop, not a parser: it knows the shapes that
 *    broke us, not the whole PostgreSQL grammar.
 *
 *  - `execution` is the real proof and is OPT-IN, because it needs a server.
 *    It runs the statement against a real PostgreSQL, so it answers the only
 *    question that actually matters — does this parse and do what it says.
 *    🔴 Run it whenever you touch the statement; a green unit suite alone
 *    tells you nothing about whether the SQL is valid.
 *
 *      docker run -d --rm --name pg-modelflag -e POSTGRES_PASSWORD=postgres \
 *        -e POSTGRES_DB=modelflag -p 54330:5432 postgres:17
 *      MODEL_FLAG_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54330/modelflag \
 *        pnpm vitest run --project unit src/server/services/__tests__/model-flag-upsert-sql.test.ts
 *
 *    It points at its own variable and deliberately does NOT fall back to
 *    `DATABASE_URL` — that names a real environment in any checkout that has
 *    one, and this suite creates and drops tables. Same rule as
 *    `kysely-prisma-parity.test.ts`.
 */

const testDatabaseUrl = process.env.MODEL_FLAG_TEST_DATABASE_URL;

const SCAN_RESULT = {
  poi: true,
  nsfw: false,
  minor: true,
  triggerWords: false,
  poiName: true,
  sfwOnly: true,
};

/**
 * Split on commas that sit at paren depth 0 and outside a quoted identifier or
 * literal. A naive `.split(',')` would cut inside `('a','b')` and inside any
 * literal containing a comma, and would then agree with a broken statement.
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let current = '';

  for (const char of input) {
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (!inDoubleQuote && !inSingleQuote) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

/** Body of the first parenthesised group starting at `fromIndex`. */
function parenGroupAfter(sql: string, fromIndex: number): string {
  const open = sql.indexOf('(', fromIndex);
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced parentheses in generated SQL');
}

describe('buildModelFlagUpsert — structure', () => {
  // `Prisma.Sql#text` is the Postgres form ($1, $2 …); `#sql` is the MySQL `?`
  // form. Asserting this pins which one the execution arm sends to `pg`.
  it('emits numbered Postgres placeholders on .text', () => {
    const statement = buildModelFlagUpsert({ modelId: 1, scanResult: SCAN_RESULT });
    expect(statement.text).toContain('$1');
  });

  it('inserts exactly one value per column', () => {
    const { text } = buildModelFlagUpsert({ modelId: 1, scanResult: SCAN_RESULT });

    const columns = splitTopLevel(parenGroupAfter(text, text.indexOf('INSERT INTO')));
    const values = splitTopLevel(parenGroupAfter(text, text.indexOf('VALUES')));

    // Pinned literally rather than derived from `columns.length`, so a column
    // silently dropped from BOTH lists still fails here.
    expect(columns).toHaveLength(9);
    expect(values).toHaveLength(9);
    expect(values.every((value) => value.length > 0)).toBe(true);
  });

  it('assigns every non-key column exactly once in DO UPDATE, with no empty slot', () => {
    const { text } = buildModelFlagUpsert({ modelId: 1, scanResult: SCAN_RESULT });

    const setClause = text.slice(
      text.indexOf('SET ', text.indexOf('DO UPDATE')) + 'SET '.length,
      text.indexOf('RETURNING')
    );
    const assignments = splitTopLevel(setClause);

    // A trailing comma before RETURNING leaves an empty final element; a
    // missing comma fuses two assignments so one element fails the pattern.
    for (const assignment of assignments) {
      expect(assignment).toMatch(/^"(\w+)" = EXCLUDED\."\1"$/);
    }

    const assigned = assignments.map((a) => a.split('"')[1]);
    const columns = splitTopLevel(parenGroupAfter(text, text.indexOf('INSERT INTO'))).map((c) =>
      c.replaceAll('"', '')
    );
    // Every column except the conflict target is refreshed on conflict.
    expect(new Set(assigned)).toEqual(new Set(columns.filter((c) => c !== 'modelId')));
  });

  it('writes SQL NULL — not a JSON object — when details are absent', () => {
    const { text, values } = buildModelFlagUpsert({ modelId: 1, scanResult: SCAN_RESULT });

    const valueSlots = splitTopLevel(parenGroupAfter(text, text.indexOf('VALUES')));
    // `Prisma.JsonNull` interpolates as a bound parameter and lands as `{}`.
    expect(valueSlots).toContain('NULL');
    expect(values).not.toContainEqual({});
  });
});

describe.skipIf(!testDatabaseUrl)('buildModelFlagUpsert — execution (real Postgres)', () => {
  const client = new Client({ connectionString: testDatabaseUrl });

  beforeAll(async () => {
    await client.connect();
    // Mirrors the live `ModelFlag` table, including `sfwOnly`, whose migration
    // (20250425225502_add_model_flag_sfw_only) had never been applied — the
    // fourth defect, and the one no amount of source reading finds.
    await client.query(`
      DROP TABLE IF EXISTS "ModelFlag";
      DROP TYPE IF EXISTS "ModelFlagStatus";
      CREATE TYPE "ModelFlagStatus" AS ENUM ('Pending', 'Resolved');
      CREATE TABLE "ModelFlag" (
        "modelId" integer PRIMARY KEY,
        "minor" boolean NOT NULL DEFAULT false,
        "nsfw" boolean NOT NULL DEFAULT false,
        "poi" boolean NOT NULL DEFAULT false,
        "status" "ModelFlagStatus" NOT NULL DEFAULT 'Pending',
        "triggerWords" boolean NOT NULL DEFAULT false,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "details" jsonb,
        "poiName" boolean NOT NULL DEFAULT false,
        "sfwOnly" boolean NOT NULL DEFAULT false
      );
    `);
  });

  afterAll(async () => {
    await client.end();
  });

  const run = (args: Parameters<typeof buildModelFlagUpsert>[0]) => {
    const statement = buildModelFlagUpsert(args);
    return client.query(statement.text, statement.values as unknown[]);
  };

  it('inserts a flag and returns the row', async () => {
    const { rows } = await run({ modelId: 101, scanResult: SCAN_RESULT, details: { a: 1 } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      modelId: 101,
      poi: true,
      nsfw: false,
      minor: true,
      triggerWords: false,
      poiName: true,
      sfwOnly: true,
      status: 'Pending',
      details: { a: 1 },
    });
  });

  it('updates every flag column on conflict', async () => {
    await run({ modelId: 202, scanResult: SCAN_RESULT, details: { first: true } });
    const { rows } = await run({
      modelId: 202,
      scanResult: { ...SCAN_RESULT, poi: false, nsfw: true, sfwOnly: false },
      details: { second: true },
    });

    expect(rows[0]).toMatchObject({
      modelId: 202,
      poi: false,
      nsfw: true,
      sfwOnly: false,
      details: { second: true },
    });

    const { rows: all } = await client.query(
      'SELECT count(*)::int AS n FROM "ModelFlag" WHERE "modelId" = 202'
    );
    expect(all[0].n).toBe(1);
  });

  it('stores SQL NULL when details are absent', async () => {
    const { rows } = await run({ modelId: 303, scanResult: SCAN_RESULT });

    // The `Prisma.JsonNull` defect stored `{}` here, which reads as "scanned,
    // no findings" rather than "no details recorded".
    expect(rows[0].details).toBeNull();
  });
});
