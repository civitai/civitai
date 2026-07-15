import { PGlite } from '@electric-sql/pglite';

/**
 * Behavioral test harness for {@link BlockRegistry.listForModel}.
 *
 * Unlike block-registry.service.test.ts — which mocks `dbRead.$queryRaw` to
 * return a fixed array and only asserts on the SQL *string shape* — this
 * harness EXECUTES the real, unmodified `listForModel` UNION-ALL query against
 * an in-process Postgres (PGlite, Postgres compiled to WASM). That lets a test
 * seed rows, call `listForModel`, and assert on the rows the query actually
 * resolves — the only way to catch behavioral bugs (e.g. the H2 suppressor
 * gap) in a 4-rank precedence query full of PG-only operators (`@>` jsonb
 * containment, `= ANY(array)`, `cardinality`, `array_length`).
 *
 * Wiring:
 *   - `installPgliteQueryRaw(db)` returns a fn shaped like Prisma's tagged-
 *     template `$queryRaw` — `(strings, ...values)` — that stitches the
 *     template back into a parameterized `$1,$2,…` SQL string and runs it on
 *     PGlite, returning `.rows`. The mock factory in the test file hands that
 *     fn to the `~/server/db/client` mock so the unmodified service SQL runs.
 *   - The seed helpers create only the columns the query reads.
 *
 * NOTE: this module exports plain helpers; the `vi.mock` calls (which must be
 * hoisted) live in the behavior test file. See block-registry.service.test.ts
 * for the hoisting idiom this mirrors.
 */

/**
 * Prisma's `$queryRaw` is a tagged template: it receives the array of string
 * fragments plus the interpolated values. Reconstruct the equivalent
 * parameterized SQL by interleaving each fragment with a `$N` placeholder, in
 * order, then run it on PGlite. Returns the `.rows` array so it is a drop-in
 * for the real `$queryRaw<Row[]>` (which resolves to `Row[]`).
 */
export function installPgliteQueryRaw(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    let sql = '';
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    const result = await db.query(sql, values as unknown[]);
    return result.rows as unknown[];
  };
}

/**
 * Create only the tables `listForModel` touches, with only the columns the
 * query reads. Column names/types mirror what the SQL references (read from
 * block-registry.service.ts ~L375-590): array columns are real PG arrays so
 * `cardinality` / `array_length` / `= ANY` behave as in production, and
 * `manifest`/`settings` are `jsonb` so `@>` containment and `->>` work.
 */
export async function createSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE app_blocks (
      id            text PRIMARY KEY,
      block_id      text NOT NULL,
      app_id        text NOT NULL,
      manifest      jsonb NOT NULL DEFAULT '{}'::jsonb,
      status        text NOT NULL DEFAULT 'approved',
      render_mode   text NOT NULL DEFAULT 'iframe',
      trust_tier    text NOT NULL DEFAULT 'unverified',
      -- DEPLOY-GATE columns: off-site apps set external_url; current_version_
      -- deployed_at is non-null once an app has successfully deployed. Default
      -- now() so a seeded app is "deployed" and the render gate passes unless a
      -- test deliberately seeds it NULL (never-deployed).
      external_url  text,
      current_version_deployed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE block_user_subscriptions (
      id                  text PRIMARY KEY,
      user_id             int NOT NULL,
      app_block_id        text NOT NULL,
      scope               text NOT NULL,
      slot_id             text,
      target_model_ids    int[]  NOT NULL DEFAULT ARRAY[]::int[],
      target_model_types  text[] NOT NULL DEFAULT ARRAY[]::text[],
      target_base_models  text[] NOT NULL DEFAULT ARRAY[]::text[],
      settings            jsonb  NOT NULL DEFAULT '{}'::jsonb,
      enabled             boolean NOT NULL DEFAULT true,
      block_instance_id   text
    );

    CREATE TABLE platform_default_blocks (
      app_block_id        text NOT NULL,
      slot_id             text NOT NULL,
      enabled             boolean NOT NULL DEFAULT true,
      priority            int NOT NULL DEFAULT 0,
      target_model_types  text[]
    );

    CREATE TABLE "Model" (
      id      int PRIMARY KEY,
      "userId" int NOT NULL
    );

    CREATE TABLE "ModelVersion" (
      id         int PRIMARY KEY,
      "modelId"  int NOT NULL,
      "baseModel" text
    );
  `);
}

/** Truncate every seeded table so a single PGlite instance can be reused
 * across tests without cross-contamination. */
export async function truncateAll(db: PGlite): Promise<void> {
  await db.exec(`
    TRUNCATE app_blocks, block_user_subscriptions, platform_default_blocks,
             "Model", "ModelVersion";
  `);
}

function pgIntArray(xs: number[]): string {
  return xs.length === 0 ? 'ARRAY[]::int[]' : `ARRAY[${xs.join(',')}]::int[]`;
}
function pgTextArray(xs: string[]): string {
  if (xs.length === 0) return 'ARRAY[]::text[]';
  const quoted = xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${quoted}]::text[]`;
}
function pgTextArrayOrNull(xs: string[] | null | undefined): string {
  if (xs == null) return 'NULL';
  return pgTextArray(xs);
}

export async function seedModel(
  db: PGlite,
  opts: { id: number; ownerUserId: number }
): Promise<void> {
  await db.query(`INSERT INTO "Model" (id, "userId") VALUES ($1, $2)`, [
    opts.id,
    opts.ownerUserId,
  ]);
}

export async function seedModelVersion(
  db: PGlite,
  opts: { id: number; modelId: number; baseModel: string }
): Promise<void> {
  await db.query(
    `INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES ($1, $2, $3)`,
    [opts.id, opts.modelId, opts.baseModel]
  );
}

export async function seedAppBlock(
  db: PGlite,
  opts: {
    id: string;
    blockId: string;
    appId?: string;
    status?: string;
    renderMode?: string;
    trustTier?: string;
    /** Defaults to a manifest that targets `model.sidebar_top` with a 'g'
     * content rating so the `@>` slot match + JS content-rating filter pass. */
    manifest?: Record<string, unknown>;
  }
): Promise<void> {
  const manifest = opts.manifest ?? {
    targets: [{ slotId: 'model.sidebar_top' }],
    contentRating: 'g',
  };
  await db.query(
    `INSERT INTO app_blocks (id, block_id, app_id, manifest, status, render_mode, trust_tier)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      opts.id,
      opts.blockId,
      opts.appId ?? `app_${opts.id}`,
      JSON.stringify(manifest),
      opts.status ?? 'approved',
      opts.renderMode ?? 'iframe',
      opts.trustTier ?? 'unverified',
    ]
  );
}

export async function seedSubscription(
  db: PGlite,
  opts: {
    id: string;
    userId: number;
    appBlockId: string;
    scope: string;
    slotId?: string | null;
    targetModelIds?: number[];
    targetModelTypes?: string[];
    targetBaseModels?: string[];
    settings?: Record<string, unknown>;
    enabled?: boolean;
    blockInstanceId?: string | null;
  }
): Promise<void> {
  // Build the row via string interpolation for the array columns (PG array
  // literal syntax is clearest here) and a jsonb param for settings.
  const sql = `
    INSERT INTO block_user_subscriptions
      (id, user_id, app_block_id, scope, slot_id,
       target_model_ids, target_model_types, target_base_models,
       settings, enabled, block_instance_id)
    VALUES
      ($1, $2, $3, $4, $5,
       ${pgIntArray(opts.targetModelIds ?? [])},
       ${pgTextArray(opts.targetModelTypes ?? [])},
       ${pgTextArray(opts.targetBaseModels ?? [])},
       $6::jsonb, $7, $8)
  `;
  await db.query(sql, [
    opts.id,
    opts.userId,
    opts.appBlockId,
    opts.scope,
    opts.slotId ?? null,
    JSON.stringify(opts.settings ?? {}),
    opts.enabled ?? true,
    opts.blockInstanceId ?? null,
  ]);
}

export async function seedPlatformDefault(
  db: PGlite,
  opts: {
    appBlockId: string;
    slotId: string;
    enabled?: boolean;
    priority?: number;
    targetModelTypes?: string[] | null;
  }
): Promise<void> {
  const sql = `
    INSERT INTO platform_default_blocks
      (app_block_id, slot_id, enabled, priority, target_model_types)
    VALUES ($1, $2, $3, $4, ${pgTextArrayOrNull(opts.targetModelTypes)})
  `;
  await db.query(sql, [
    opts.appBlockId,
    opts.slotId,
    opts.enabled ?? true,
    opts.priority ?? 0,
  ]);
}
