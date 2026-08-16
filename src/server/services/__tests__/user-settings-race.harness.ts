import { PGlite } from '@electric-sql/pglite';

/**
 * Harness for the `User.settings` lost-update tests.
 *
 * `settings` is one JSON column with many independent writers. The failure mode
 * under test is not "does a write land" — it is "does writer A's edit survive
 * writer B running at the same time". Asserting that from a single sequential
 * call is impossible, and a hand-written fake of `jsonb ||` / `jsonb_set` would
 * only re-encode whatever the test author believed those operators do. So the
 * statements the services emit run UNMODIFIED against an in-process Postgres
 * (PGlite, Postgres compiled to WASM), and the interleaving is produced by
 * holding one statement at the wire while another request completes.
 *
 * SCOPE, stated plainly: PGlite is a single connection, so what these tests
 * exercise is STATEMENT interleaving between two logical requests — request B's
 * whole read-compute-write cycle running strictly between request A's read and
 * request A's write. That is exactly the shape of the reported bug, and it is
 * what distinguishes a read-modify-write in JS from an expression evaluated over
 * the stored column. It is NOT a test of multi-connection MVCC: nothing here
 * exercises row locks, snapshot isolation, or Postgres' re-evaluation of a SET
 * expression against a concurrently-updated tuple. Those are asserted by
 * construction (single-statement writes), not by measurement.
 */

/** A one-shot hold on the next statement whose text matches. */
export type Hold = {
  /** Resolves once the matching statement has ARRIVED and is being held. */
  reached: Promise<void>;
  /** Lets the held statement proceed. */
  release: () => void;
};

export type Gate = {
  hold: (match: (sql: string) => boolean) => Hold;
  /** Every statement the bridge has executed, in order. */
  statements: string[];
};

export function createGate(): Gate {
  const pending: { match: (sql: string) => boolean; arrive: () => void; gate: Promise<void> }[] = [];
  const statements: string[] = [];

  const gate: Gate = {
    statements,
    hold(match) {
      let release!: () => void;
      let arrive!: () => void;
      const gatePromise = new Promise<void>((r) => (release = r));
      const reached = new Promise<void>((r) => (arrive = r));
      pending.push({ match, arrive, gate: gatePromise });
      return { reached, release };
    },
  };

  // Consumed by the bridge below.
  (gate as Gate & { __await: (sql: string) => Promise<void> }).__await = async (sql: string) => {
    statements.push(sql);
    const idx = pending.findIndex((p) => p.match(sql));
    if (idx === -1) return;
    const [held] = pending.splice(idx, 1);
    held.arrive();
    await held.gate;
  };

  return gate;
}

/**
 * A `Prisma.Sql` fragment — what `Prisma.join(ids)` returns. It can appear as an
 * interpolated VALUE inside a tagged template, where it contributes statement TEXT
 * rather than a single bound parameter. Binding it as a parameter instead produces
 * `invalid input syntax for type integer: "[object Object]"`, so the bridge has to
 * recurse into it.
 */
function isSqlFragment(v: unknown): v is { strings: string[]; values: unknown[] } {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { strings?: unknown }).strings) &&
    Array.isArray((v as { values?: unknown }).values)
  );
}

/** Stitch a Prisma tagged-template call back into `$1,$2,…` parameterised SQL. */
function fromTemplate(strings: readonly string[], values: unknown[]) {
  const params: unknown[] = [];
  const bind = (v: unknown) => `$${params.push(v)}`;

  const walk = (frags: readonly string[], vals: unknown[]): string => {
    let sql = '';
    for (let i = 0; i < frags.length; i++) {
      sql += frags[i];
      if (i < vals.length) {
        const v = vals[i];
        sql += isSqlFragment(v) ? walk(v.strings, v.values) : bind(v);
      }
    }
    return sql;
  };

  return { sql: walk(strings, values), params };
}

/**
 * A stand-in for the Prisma client that speaks all four raw shapes the settings
 * writers use, routed to PGlite. Every statement passes the gate first, so a
 * test can suspend one mid-flight.
 */
export function createPrismaBridge(db: PGlite, gate: Gate) {
  const wait = (gate as Gate & { __await: (sql: string) => Promise<void> }).__await;

  const run = async (sql: string, values: unknown[]) => {
    await wait(sql);
    const result = await db.query(sql, values);
    return result.rows as unknown[];
  };

  const client = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const { sql, params } = fromTemplate(strings, values);
      return run(sql, params);
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => run(sql, values),
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const { sql, params } = fromTemplate(strings, values);
      await run(sql, params);
      return 1;
    },
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      await run(sql, values);
      return 1;
    },
    // Interactive transactions run against the same single connection; the callback
    // gets the same client so a nested raw statement still reaches PGlite.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const rows = await run(`SELECT id, settings FROM "User" WHERE id = $1`, [where.id]);
        return (rows[0] as unknown) ?? null;
      },
      update: async ({ where, data }: { where: { id: number }; data: { settings?: unknown } }) => {
        // Only the settings-column shape is needed here; a caller writing anything else
        // must fail loudly rather than silently no-op.
        if (!('settings' in data))
          throw new Error('bridge: user.update called with no settings payload');
        await run(`UPDATE "User" SET settings = $1::jsonb WHERE id = $2`, [
          JSON.stringify(data.settings),
          where.id,
        ]);
        return { id: where.id };
      },
    },
  };

  return client;
}

export async function createUserSchema(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "User" (
      id             int PRIMARY KEY,
      settings       jsonb DEFAULT '{}'::jsonb,
      "showNsfw"     boolean NOT NULL DEFAULT false,
      "blurNsfw"     boolean NOT NULL DEFAULT true,
      "autoplayGifs" boolean
    );
  `);
}

export async function seedUser(db: PGlite, id: number, settings: Record<string, unknown>) {
  await db.query(
    `INSERT INTO "User" (id, settings) VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
    [id, JSON.stringify(settings)]
  );
}

export async function readSettings(db: PGlite, id: number): Promise<Record<string, unknown>> {
  const r = await db.query<{ settings: Record<string, unknown> | null }>(
    `SELECT settings FROM "User" WHERE id = $1`,
    [id]
  );
  return r.rows[0]?.settings ?? {};
}
