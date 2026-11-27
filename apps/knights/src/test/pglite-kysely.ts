import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import { parseTimestampAsUtc } from '@civitai/db/kysely';
import { JIT_OFF_STATEMENT, SERVABLE_IMAGE_CONTENT_MARKER } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import {
  KNIGHTS_APP_COLUMN_UPDATES,
  KNIGHTS_APP_FUNCTIONS,
  KNIGHTS_APP_GRANTS,
  KNIGHTS_APP_ROLE,
  KNIGHTS_APP_SCHEMAS,
  KNIGHTS_APP_SEQUENCES,
} from './knights-app-grants';

const MIGRATIONS = [
  '20261209120000_knights_new_order_player_and_link_review',
  '20261210120000_knights_v2_tables',
  '20271120160000_knights_inquisitor_review',
  '20271125120000_knights_legacy_player_days',
  '20271128120000_knights_player_question_settings',
  '20271128120100_knights_unsure',
  '20271130120000_knights_queue_item_verdict_labelled',
  '20271130120100_knights_queue_item_verdict_unlabelled_idx',
  '20271208120000_knights_question_report',
].map((name) =>
  fileURLToPath(
    new URL(
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    )
  )
);

const migrationPath = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    )
  );

/** Creates the gate's partition function and first view; `IMAGE_GATE_MIGRATION` replaces the view after it. */
const IMAGE_GATE_BASE_MIGRATION = migrationPath('20271127120000_knights_image_gate');

export const IMAGE_GATE_REVOKES_MIGRATION = migrationPath(
  '20271127120100_knights_image_gate_revokes'
);

/** The migration carrying the current "KnightsImageGate" SQL. */
export const IMAGE_GATE_MIGRATION = migrationPath('20271207120000_knights_image_gate_mod_review');

/** Owns the tables and applies the image gate migration, as the tables' owner does in production. Not a superuser. */
export const TABLE_OWNER = 'knights_table_owner';

/**
 * Months of "KnightsVote" partitions made up front, as the superuser: tests vote on fixed dates, and the owner's
 * partition function only creates a month near the real one.
 */
const PARTITION_MONTHS = { from: { year: 2026, month: 1 }, count: 24 };

async function applyImageGate(pg: PGlite) {
  const months = Array.from({ length: PARTITION_MONTHS.count }, (_, i) => {
    const start = new Date(
      Date.UTC(PARTITION_MONTHS.from.year, PARTITION_MONTHS.from.month - 1 + i, 1)
    );
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const name = `KnightsVote_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`;
    return `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "KnightsVote" FOR VALUES FROM ('${day(
      start
    )}') TO ('${day(end)}');`;
  });
  await pg.exec(`${months.join('\n')}
    CREATE ROLE ${TABLE_OWNER} NOLOGIN;
    GRANT CREATE ON SCHEMA public TO ${TABLE_OWNER};
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO ${TABLE_OWNER}', r.rel);
      END LOOP;
    END $$;
    SET ROLE ${TABLE_OWNER};`);
  try {
    await pg.exec(readFileSync(IMAGE_GATE_BASE_MIGRATION, 'utf8'));
    await pg.exec(readFileSync(IMAGE_GATE_MIGRATION, 'utf8'));
  } finally {
    await pg.exec('RESET ROLE');
  }
}

const STAND_INS = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "userId" INTEGER,
  "pHash" BIGINT,
  "meta" JSONB,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
  "blockedFor" TEXT,
  "needsReview" TEXT,
  "scanJobs" JSONB,
  "modelRestricted" BOOLEAN NOT NULL DEFAULT false,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "poi" BOOLEAN NOT NULL DEFAULT false,
  "minor" BOOLEAN NOT NULL DEFAULT false,
  "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  "postId" INTEGER
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE "ImageCdnModeratorDelete" ("imageId" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "userId" INTEGER, "csamReview" BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY,
  "minor" BOOLEAN NOT NULL DEFAULT false,
  "poi" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'Published',
  "availability" TEXT NOT NULL DEFAULT 'Public',
  "deletedAt" TIMESTAMP(3)
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY,
  "modelId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published',
  "availability" TEXT NOT NULL DEFAULT 'Public'
);
CREATE TABLE "ImageResourceNew" ("imageId" INTEGER NOT NULL, "modelVersionId" INTEGER NOT NULL, PRIMARY KEY ("imageId", "modelVersionId"));
CREATE TABLE "ScanLabelItem" (
  "id" serial PRIMARY KEY,
  -- No foreign key to "Image": suites that TRUNCATE "Image" without CASCADE must not trip over it.
  "imageId" integer NOT NULL,
  "copyState" text,
  "copyKey" text,
  "copiedAt" timestamptz(3),
  "voidReason" text
);
CREATE TABLE "ScanLabelFlag" (
  "id" serial PRIMARY KEY,
  "itemId" integer NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "flaggerVersion" text NOT NULL,
  "reason" text,
  "workflowId" text NOT NULL UNIQUE,
  "flaggedAt" timestamptz(3) NOT NULL,
  "snapshot" jsonb,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE "ScanLabelVote" (
  "itemId" integer NOT NULL REFERENCES "ScanLabelItem"("id") ON DELETE CASCADE,
  "userId" integer NOT NULL,
  "block" boolean NOT NULL,
  "reason" text,
  "reasonComment" text,
  "msOnItem" integer,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("itemId", "userId")
);
CREATE TABLE "Report" ("id" SERIAL PRIMARY KEY, "status" TEXT NOT NULL);
CREATE TABLE "ImageReport" ("reportId" INTEGER NOT NULL, "imageId" INTEGER NOT NULL, PRIMARY KEY ("reportId", "imageId"));
CREATE TABLE "PostReport" ("reportId" INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL);
CREATE TABLE "ModelReport" ("reportId" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "UserReport" ("reportId" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "TagsOnImageDetails" (
  "imageId" INTEGER NOT NULL,
  "tagId" INTEGER NOT NULL,
  "disabled" BOOLEAN NOT NULL DEFAULT false,
  "confidence" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "Tag" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'Moderation',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "BlockedImage" ("hash" BIGINT PRIMARY KEY, "reason" TEXT NOT NULL);
CREATE TABLE "ImageFlag" (
  "imageId" INTEGER PRIMARY KEY,
  "promptNsfw" BOOLEAN NOT NULL DEFAULT false,
  "resourcesNsfw" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL DEFAULT 0,
  "entityType" TEXT,
  "entityId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'Pending'
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending'
);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY,
  "publishedAt" TIMESTAMP(3),
  "availability" TEXT NOT NULL DEFAULT 'Public',
  "modelVersionId" INTEGER
);
CREATE TABLE "NewOrderPlayer" (
  "userId" INTEGER PRIMARY KEY,
  "rankType" TEXT NOT NULL,
  "exp" INTEGER NOT NULL DEFAULT 0,
  "fervor" INTEGER NOT NULL DEFAULT 0,
  "payoutBlockedAt" TIMESTAMP(3),
  "payoutBlockReason" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Cosmetic" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL DEFAULT '',
  "type" TEXT NOT NULL DEFAULT 'Badge',
  "source" TEXT NOT NULL,
  "data" JSONB
);
CREATE TABLE "UserCosmetic" (
  "userId" INTEGER NOT NULL,
  "cosmeticId" INTEGER NOT NULL REFERENCES "Cosmetic"("id") ON DELETE CASCADE,
  "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimKey" TEXT NOT NULL DEFAULT 'claimed',
  "equippedAt" TIMESTAMP(3),
  "remaining" INTEGER,
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT,
  "image" TEXT,
  "profilePictureId" INTEGER,
  "bannedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "muted" BOOLEAN NOT NULL DEFAULT false
);
CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
CREATE TABLE "UserEngagement" (
  "userId" INTEGER NOT NULL,
  "targetUserId" INTEGER NOT NULL,
  "type" "UserEngagementType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "targetUserId")
);
CREATE TABLE "Product" (
  "id" TEXT PRIMARY KEY,
  "metadata" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "CustomerSubscription" (
  "id" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "productId" TEXT NOT NULL REFERENCES "Product"("id"),
  "buzzType" TEXT NOT NULL DEFAULT 'yellow',
  "status" TEXT NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "activity" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "UserNotificationSettings" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "disabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "type")
);
CREATE TABLE "NewOrderSmite" (
  "id" SERIAL PRIMARY KEY,
  "targetPlayerId" INTEGER NOT NULL,
  "givenById" INTEGER NOT NULL DEFAULT -1,
  "size" INTEGER NOT NULL DEFAULT 10,
  "remaining" INTEGER NOT NULL DEFAULT 10,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleansedAt" TIMESTAMP(3),
  "cleansedReason" TEXT
);
`;

const LABEL_STORE_MIGRATION = fileURLToPath(
  new URL(
    '../../../../packages/civitai-db-schema/prisma/migrations/20261103120000_label_store/migration.sql',
    import.meta.url
  )
);

/** The site tables the label store's migration hooks into; `Image` is already a stand-in above. */
const LABEL_STORE_SOURCES = `
CREATE TABLE "ScanLabelCopyObject" (
  "key" text PRIMARY KEY,
  "itemId" integer NOT NULL,
  "imageId" integer NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "withdrawnAt" timestamptz(3),
  "withdrawReason" text
);
CREATE TABLE "AppealDecisionRecord" (
  "id" bigserial PRIMARY KEY,
  "appealId" integer NOT NULL UNIQUE,
  "imageId" integer NOT NULL,
  "imageUrl" text NOT NULL,
  "pHash" bigint,
  "nsfwLevel" integer NOT NULL,
  "nsfwLevelReason" text,
  "aiNsfwLevel" integer,
  "blockedFor" text,
  "decision" text NOT NULL,
  "decidedAt" timestamptz(3) NOT NULL
);
`;

/** Installs the real label store, for the tests that write labels. */
export async function bootLabelStore(pg: PGlite) {
  await pg.exec(LABEL_STORE_SOURCES);
  await pg.exec(readFileSync(LABEL_STORE_MIGRATION, 'utf8'));
}

/**
 * The real tag-row table, functions and view, and the real rating recompute `update_nsfw_levels_new`, which
 * `removalLowersLevel` (`@civitai/db/knights`) is pinned to. A later migration that redefines `update_nsfw_levels_new`
 * must be added to this list.
 */
const TAG_REVIEW_MIGRATIONS = [
  '20250303170613_tags_on_image_new',
  '20270105120000_update_nsfw_levels_new_judge_rating_floor',
].map((name) =>
  fileURLToPath(
    new URL(
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    )
  )
);

/** The site tables the moderator tag review source reads: tags, and what makes an image staff-only. */
// The base schema already stands in for these tables; its "TagsOnImageDetails" table gives way to the real view.
const TAG_REVIEW_SOURCES = `
CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'MinorDetection');
DROP TABLE IF EXISTS "TagsOnImageDetails";
CREATE TABLE IF NOT EXISTS "Tag" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'Moderation',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]', "details" jsonb);
CREATE TABLE IF NOT EXISTS "Report" ("id" SERIAL PRIMARY KEY, "status" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "ImageReport" ("imageId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
`;

/** Installs what the moderator tag review source reads, for the tests that create, serve or vote on its items. */
export async function bootTagReview(pg: PGlite) {
  await pg.exec(TAG_REVIEW_SOURCES);
  for (const migration of TAG_REVIEW_MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// node-postgres sends a Date as local time with the host's UTC offset, and a `timestamp without time
// zone` column drops the offset. PGlite would send the UTC instant instead, hiding any code that
// leans on the host timezone, so mimic the real driver.
function asNodePgParameter(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  const offset = -value.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
    `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}` +
    `.${pad(value.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Reads that broke the JIT rule below. Recorded as well as thrown, since a caller that catches the error (a sweep counting
 * failures, a read that falls back) would otherwise hide it: every test using this harness fails if any were recorded.
 * Known limit: it checks that some transaction is open with JIT off, not that it is this statement's own, so an
 * interleaved pool read could pass here; prod callers pass their trx to `readWithoutJit` explicitly.
 */
const jitViolations: string[] = [];
afterEach(() => {
  const found = jitViolations.splice(0);
  if (found.length)
    throw new Error(`servableImageContent read ran with JIT on:\n${found.join('\n')}`);
});

/**
 * Runs the app's statements as the production role (`KNIGHTS_APP_GRANTS`), so a query that reads a table the role has no
 * grant on fails here, not in production. Fixtures written through `pg` run as the superuser. One gate orders both, so a
 * fixture never runs under the role; a fixture that creates a table marks the grants for re-applying before the next app
 * statement.
 */
type AppRole = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** The role the session holds now, as far as the gate knows; switched only when it must, since each switch is a round trip. */
  role: 'app' | 'superuser' | 'unknown';
};

const DDL =
  /\b(create|alter)\s+(or\s+replace\s+)?(table|view|materialized\s+view|schema|function)\b/i;

function appRoleGate(): AppRole {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    role: 'unknown',
    run(fn) {
      const next = tail.then(fn);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

async function grantAppRole(pg: PGlite) {
  const present = new Set(
    (
      await pg.query<{ name: string }>(
        `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`
      )
    ).rows.map((r) => r.name)
  );
  const quoted = (name: string) =>
    name
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');
  const schemas = (
    await pg.query<{ name: string }>(`SELECT nspname AS name FROM pg_catalog.pg_namespace`)
  ).rows.map((r) => r.name);
  const functions = (
    await pg.query<{ fn: string }>(
      `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) AS fn
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1)`,
      [KNIGHTS_APP_FUNCTIONS]
    )
  ).rows.map((r) => r.fn);
  const grants = [
    ...KNIGHTS_APP_SCHEMAS.filter((s) => schemas.includes(s)).map(
      (s) => `GRANT USAGE ON SCHEMA "${s}" TO ${KNIGHTS_APP_ROLE};`
    ),
    ...Object.entries(KNIGHTS_APP_GRANTS)
      .filter(([table]) => present.has(table))
      .map(
        ([table, privileges]) =>
          `GRANT ${privileges.join(', ')} ON ${quoted(table)} TO ${KNIGHTS_APP_ROLE};`
      ),
    ...Object.entries(KNIGHTS_APP_COLUMN_UPDATES)
      .filter(([table]) => present.has(table))
      .map(
        ([table, columns]) =>
          `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(', ')}) ON ${quoted(
            table
          )} TO ${KNIGHTS_APP_ROLE};`
      ),
    ...KNIGHTS_APP_SEQUENCES.filter((s) => present.has(s)).map(
      (s) => `GRANT USAGE ON SEQUENCE "${s}" TO ${KNIGHTS_APP_ROLE};`
    ),
    ...functions.map((fn) => `GRANT EXECUTE ON FUNCTION ${fn} TO ${KNIGHTS_APP_ROLE};`),
  ];
  if (grants.length) await pg.exec(grants.join('\n'));
}

/** `pg` for the test's fixtures: through the gate, as the superuser. */
function fixturePg(pg: PGlite, gate: AppRole): PGlite {
  return new Proxy(pg, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop !== 'query' && prop !== 'exec') return value.bind(target);
      return (...args: unknown[]) =>
        gate.run(async () => {
          await becomeSuperuser(target, gate);
          const result = await value.apply(target, args);
          // Applied here, outside any transaction of the app's: a grant made inside one would go with its rollback.
          if (DDL.test(String(args[0]))) await grantAppRole(target);
          return result;
        });
    },
  });
}

async function becomeSuperuser(pg: PGlite, gate: AppRole) {
  if (gate.role === 'superuser') return;
  // Fails inside a transaction a statement aborted; its ROLLBACK restores the role.
  await pg.exec('RESET ROLE').catch(() => undefined);
  gate.role = 'superuser';
}

async function asAppRole<T>(pg: PGlite, gate: AppRole, fn: () => Promise<T>): Promise<T> {
  if (gate.role !== 'app') {
    await pg.exec(`SET ROLE ${KNIGHTS_APP_ROLE}`);
    gate.role = 'app';
  }
  try {
    return await fn();
  } catch (error) {
    gate.role = 'unknown';
    throw error;
  }
}

function dialect(
  pg: PGlite,
  transactions: { open: number },
  serialize: boolean,
  appRole: AppRole | null,
  asRole = true
): Dialect {
  // A read carrying the CSAM subplans (`servableImageContent`) must run with JIT off in its transaction
  // (`readWithoutJit`): its inflated estimate would make a server with JIT on compile it for longer than it runs.
  let jitOff = false;
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      // Under the app role every statement, transaction control too, runs through the gate in call order, so the JIT
      // bookkeeping below sees them in the order they run.
      const run = async () => {
        const text = compiled.sql.trim().toLowerCase();
        if (text === 'begin' || text === 'commit' || text === 'rollback') jitOff = false;
        else if (text === JIT_OFF_STATEMENT.toLowerCase()) jitOff = transactions.open > 0;
        else if (
          compiled.sql.includes(SERVABLE_IMAGE_CONTENT_MARKER) &&
          !(jitOff && transactions.open > 0)
        ) {
          jitViolations.push(compiled.sql.slice(0, 160));
          throw new Error(
            `A servableImageContent read ran with JIT on (wrap it in readWithoutJit): ${compiled.sql.slice(
              0,
              120
            )}`
          );
        }
        const send = () => pg.query(compiled.sql, compiled.parameters.map(asNodePgParameter));
        // Transaction control runs as is: a ROLLBACK must still run after a statement aborted the transaction.
        const control = /^(begin|commit|rollback|savepoint|release)\b/.test(text);
        let result;
        if (!appRole) result = await send();
        else if (control) {
          // A ROLLBACK can undo a SET ROLE made inside the transaction.
          appRole.role = 'unknown';
          result = await send();
        } else if (asRole) result = await asAppRole(pg, appRole, send);
        else {
          await becomeSuperuser(pg, appRole);
          result = await send();
        }
        return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
      };
      return appRole ? appRole.run(run) : run();
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used by the queue');
    },
  };
  const noop = async () => undefined;
  // One PGlite connection cannot interleave two transactions. `serialize` hands it out to one holder at a time, the way
  // a row lock makes two writers of the same player take turns, so a test can run two purchases at once.
  let tail: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;
  const driver: Driver = {
    init: noop,
    acquireConnection: async () => {
      if (!serialize) return connection;
      const previous = tail;
      let unlock: () => void = () => undefined;
      tail = new Promise<void>((resolve) => (unlock = resolve));
      await previous;
      release = unlock;
      return connection;
    },
    beginTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw('begin'));
      transactions.open++;
    },
    commitTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw('commit'));
      transactions.open--;
    },
    rollbackTransaction: async (conn) => {
      await conn.executeQuery(CompiledQuery.raw('rollback'));
      transactions.open--;
    },
    releaseConnection: async () => {
      if (serialize) release();
    },
    destroy: noop,
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

/**
 * Makes the skill-check columns of "KnightsImageGate" unreadable to the app role, and only those: the other columns
 * still serve, as when one of the skill-check tables cannot be read. `SKILL_CHECK_GATE_READABLE` undoes it.
 */
export const SKILL_CHECK_GATE_UNREADABLE = `REVOKE SELECT ON "KnightsImageGate" FROM ${KNIGHTS_APP_ROLE};
  GRANT SELECT ("imageId", "servable", "sweepServable") ON "KnightsImageGate" TO ${KNIGHTS_APP_ROLE};`;
export const SKILL_CHECK_GATE_READABLE = `GRANT SELECT ON "KnightsImageGate" TO ${KNIGHTS_APP_ROLE};`;

export async function createQueueDb({
  serialize = false,
  asSuperuser = false,
}: {
  serialize?: boolean;
  /** Runs the app's statements as the superuser instead of `KNIGHTS_APP_ROLE`: only for code production never runs as it. */
  asSuperuser?: boolean;
} = {}): Promise<{
  pg: PGlite;
  db: Kysely<DB>;
  /** The same database as the main app's role reads it (every table): for code only the main app runs. */
  mainAppDb: Kysely<DB>;
  transactions: { open: () => number };
}> {
  const pg = await PGlite.create({ parsers: { 1114: parseTimestampAsUtc } });
  await pg.exec(STAND_INS);
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  await pg.exec(`CREATE ROLE ${KNIGHTS_APP_ROLE} NOLOGIN`);
  await applyImageGate(pg);
  await grantAppRole(pg);
  const state = { open: 0 };
  const gate = asSuperuser ? null : appRoleGate();
  return {
    pg: gate ? fixturePg(pg, gate) : pg,
    db: new Kysely<DB>({ dialect: dialect(pg, state, serialize, gate) }),
    mainAppDb: new Kysely<DB>({ dialect: dialect(pg, { open: 0 }, serialize, gate, false) }),
    transactions: { open: () => state.open },
  };
}
