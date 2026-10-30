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
import type { DB } from '@civitai/db-schema/kysely';

const MIGRATIONS = [
  '20261210120000_knights_v2_queue',
  '20261212120000_knights_v2_trials',
  '20261213120000_knights_v2_progression',
  '20261215120000_knights_v2_daily',
  '20261217120000_knights_v2_notify',
  '20261218120000_knights_v2_conversion',
  '20261219120000_knights_v2_smites',
  '20261221120000_knights_v2_yesno',
].map((name) =>
  fileURLToPath(
    new URL(
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    )
  )
);

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
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "postId" INTEGER
);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY,
  "publishedAt" TIMESTAMP(3)
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
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "bannedAt" TIMESTAMP(3)
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
CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
CREATE TABLE "Appeal" ("id" serial PRIMARY KEY, "userId" integer NOT NULL);
CREATE TABLE "ScanLabelItem" (
  "id" serial PRIMARY KEY,
  "imageId" integer NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,
  "copyState" text,
  "copyKey" text,
  "copiedAt" timestamptz(3)
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

function dialect(pg: PGlite, transactions: { open: number }): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const result = await pg.query(compiled.sql, compiled.parameters.map(asNodePgParameter));
      return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used by the queue');
    },
  };
  const noop = async () => undefined;
  const driver: Driver = {
    init: noop,
    acquireConnection: async () => connection,
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
    releaseConnection: noop,
    destroy: noop,
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

export async function createQueueDb(): Promise<{
  pg: PGlite;
  db: Kysely<DB>;
  transactions: { open: () => number };
}> {
  const pg = await PGlite.create({ parsers: { 1114: parseTimestampAsUtc } });
  await pg.exec(STAND_INS);
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  const state = { open: 0 };
  return {
    pg,
    db: new Kysely<DB>({ dialect: dialect(pg, state) }),
    transactions: { open: () => state.open },
  };
}
