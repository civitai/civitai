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
    // silently dropped from BOTH lists still fails here. The order is pinned
    // too: the value-binding suite below reads `statement.values`, which is
    // blind to a swap in the COLUMN list — reorder `"minor"` and
    // `"triggerWords"` here with the values untouched and the minor flag is
    // written into `triggerWords`, which only Postgres would otherwise catch.
    expect(columns).toEqual([
      '"modelId"',
      '"poi"',
      '"nsfw"',
      '"minor"',
      '"triggerWords"',
      '"poiName"',
      '"status"',
      '"details"',
      '"sfwOnly"',
    ]);
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

/**
 * The assertions above constrain the statement's SHAPE. Shape cannot see a
 * wrong BIND: swap two entries in the VALUES list, or point the `sfwOnly` slot
 * at `poi`, and every arity and assignment check above still passes. Booleans
 * cannot be told apart by value, so they are told apart by POSITION.
 *
 * Each case sets exactly one flag and pins `statement.values` exactly, so any
 * swap, stale bind or defaulted flag lands a `true` in the wrong slot. This
 * runs with no database, which matters: CI provides no Postgres server, so the
 * execution arm below never runs there and this is the guard that does.
 *
 * 🔴 What this does NOT cover, so nobody reads it as closing the class: these
 * cases read `statement.values`, so anything living only in the statement TEXT
 * has to be caught elsewhere. Measured over a 25-mutant battery, exactly three
 * corruptions survive the whole always-on suite and are caught only by the
 * execution arm — i.e. never in CI:
 *
 *   - the table name
 *   - the ON CONFLICT target
 *   - narrowing `RETURNING *`
 *
 * Everything else text-only IS covered without a database: the column list's
 * order and contents (pinned by the shape suite above), `DO UPDATE` vs
 * `DO NOTHING`, a commented-out SET clause, and all three original punctuation
 * defects. Do not treat a green always-on run as proof the statement is
 * correct; run the execution arm when you change it.
 */
describe('buildModelFlagUpsert — value binding', () => {
  // Measured against the built statement, not assumed. `Prisma.sql`NULL`` is
  // spliced as literal text and consumes no placeholder, so with details
  // absent there are 8 bound values and `sfwOnly` sits at index 7.
  const VALUE_INDEX = {
    poi: 1,
    nsfw: 2,
    minor: 3,
    triggerWords: 4,
    poiName: 5,
    sfwOnly: 7,
  } as const;
  const ALL_FALSE = {
    poi: false,
    nsfw: false,
    minor: false,
    triggerWords: false,
    poiName: false,
    sfwOnly: false,
  };

  it.each(Object.keys(VALUE_INDEX) as (keyof typeof VALUE_INDEX)[])(
    'binds %s to its own slot and leaves every other flag false',
    (flag) => {
      const { values } = buildModelFlagUpsert({
        modelId: 4242,
        scanResult: { ...ALL_FALSE, [flag]: true },
      });

      const expected: unknown[] = [4242, false, false, false, false, false, 'Pending', false];
      expected[VALUE_INDEX[flag]] = true;
      expect(values).toEqual(expected);
    }
  );

  it('defaults a flag the caller omitted to false, never true', () => {
    // `sfwOnly` is the optional field, so this is the `?? false` path. Without
    // a case that OMITS a flag, none of the six defaults is ever exercised.
    const { values } = buildModelFlagUpsert({
      modelId: 4242,
      scanResult: { poi: true, nsfw: false, minor: false, triggerWords: false, poiName: false },
    });

    expect(values).toEqual([4242, true, false, false, false, false, 'Pending', false]);
  });

  it('forwards details as jsonb and shifts sfwOnly, keeping status Pending', () => {
    const { text, values } = buildModelFlagUpsert({
      modelId: 4242,
      scanResult: { ...ALL_FALSE, sfwOnly: true },
      details: { verdict: 'x' },
    });

    // details occupies index 7 when present, pushing sfwOnly to 8.
    expect(values).toEqual([
      4242,
      false,
      false,
      false,
      false,
      false,
      'Pending',
      JSON.stringify({ verdict: 'x' }),
      true,
    ]);
    // A `::text` cast would store the payload as a string, not queryable jsonb.
    expect(text).toContain('::jsonb');
    // New flags must land Pending or they never reach the moderator queue.
    expect(text).toContain('::"ModelFlagStatus"');
  });
});

describe.skipIf(!testDatabaseUrl)('buildModelFlagUpsert — execution (real Postgres)', () => {
  const client = new Client({ connectionString: testDatabaseUrl });

  beforeAll(async () => {
    // This suite DROPs "ModelFlag". The env-var isolation above stops it
    // pointing at a real environment by default, but a mis-set variable would
    // still destroy the table, so refuse anything that isn't visibly scratch.
    //
    // 🔴 Read the name off the CLIENT, not off `new URL(...).pathname`. They
    // disagree: `pg-connection-string` resolves `socket:/tmp?db=civitai` to
    // database `civitai`, whose pathname is `tmp` — so a pathname check
    // ACCEPTS a URL that connects to production, and rejects the legitimate
    // `socket:/var/run/postgresql?db=modelflag_test`. `client.database` is
    // populated at construction, before `connect()`, and is what pg will use.
    const databaseName = client.database;
    if (!databaseName || !/(^|[-_])(test|modelflag|scratch|tmp)([-_]|$)/i.test(databaseName)) {
      throw new Error(
        `MODEL_FLAG_TEST_DATABASE_URL must name a throwaway database (got "${databaseName}"). ` +
          'This suite drops and recreates "ModelFlag".'
      );
    }

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

  it('returns the whole row, so RETURNING * cannot be narrowed', async () => {
    const { rows } = await run({ modelId: 99, scanResult: SCAN_RESULT, details: { a: 1 } });

    // Named for what it actually pins. This compares the returned keys against
    // a hand-written list, so it does NOT verify `ModelFlagRow` against the
    // live schema — adding a field to the type, or to the live table without
    // updating the fixture DDL above, leaves it green. (Adding one to that
    // fixture DDL does turn it red.) What it does catch is `RETURNING *` being
    // narrowed, which would drop keys the type promises callers.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'modelId',
        'poi',
        'nsfw',
        'minor',
        'sfwOnly',
        'triggerWords',
        'poiName',
        'status',
        'details',
        'createdAt',
      ].sort()
    );
  });

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
