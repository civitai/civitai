import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

/**
 * `app_sandbox_hibernations`: one row per sleeping app, per user. RAW SQL ONLY (the Prisma model
 * is `@no-type`); the table exists once migration `20271112130000_app_sandbox_hibernations` has
 * been applied by hand. Until then every read throws "relation does not exist", which the
 * feature flag keeps unreachable, and account deletion treats as "nothing stored".
 */

export type HibernationRow = {
  userId: number;
  appKey: string;
  attemptId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  excluded: string[];
  secretsObjectKey: string | null;
  secretsSha256: string | null;
  secretsBytes: number | null;
  secretsWrappedKey: string | null;
  reason: string | null;
  appCreatedAt: Date | null;
  lastActivityAt: Date | null;
  hibernatedAt: Date;
};

export type HibernationUsage = { apps: number; bytes: number };

export type OldestSleepingApp = { app: string; hibernatedAt: Date };

/**
 * Whether the account may still hibernate: it exists, is not deleted and is not banned. Read from
 * the `User` row itself, never from a cached session (a cached session can outlive a deletion).
 */
export type AccountState = 'active' | 'deleted' | 'banned' | 'missing';

/**
 * What a commit decides once it holds the user's lock: write `row` (insert, or replace the
 * user's row for that app) or not, and what to answer. Synchronous on purpose: nothing but the
 * database runs inside the transaction.
 */
export type CommitDecision<T> = { write?: HibernationRow; result: T };

export interface HibernationRepo {
  /** The user's sleeping apps, most recently put to sleep first. */
  list(userId: number): Promise<HibernationRow[]>;
  get(userId: number, appKey: string): Promise<HibernationRow | null>;
  /**
   * The user's oldest sleeping app (earliest `hibernated_at`, ties by key), leaving out
   * `excludeAppKey`: the one a limit refusal offers to delete, once the user confirms.
   */
  oldest(userId: number, excludeAppKey: string): Promise<OldestSleepingApp | null>;
  /** The user's sleeping apps and their total bytes, leaving out `excludeAppKey`'s row. */
  usage(userId: number, excludeAppKey: string): Promise<HibernationUsage>;
  /**
   * Serialised per user: reads the existing row and the usage under a transaction-scoped lock,
   * applies `decide`, and writes what it says in the same transaction.
   */
  commit<T>(
    userId: number,
    appKey: string,
    decide: (
      existing: HibernationRow | null,
      usage: HibernationUsage,
      account: AccountState
    ) => CommitDecision<T>
  ): Promise<T>;
  /** The account's state, read from its `User` row on the primary. */
  accountState(userId: number): Promise<AccountState>;
  /**
   * Deletes the user's row for `appKey` and answers it (`null` when there was none). Under the
   * same per-user lock as {@link commit}, so a delete and a commit of the user's apps never
   * interleave.
   */
  remove(userId: number, appKey: string): Promise<HibernationRow | null>;
  removeAll(userId: number): Promise<HibernationRow[]>;
  /** Which of `keys` a row records (as its archive or its secrets object). */
  referencedKeys(keys: string[]): Promise<Set<string>>;
  /** Users that are deleted but still have rows: an account-deletion step that failed. */
  deletedAccountsWithRows(limit: number): Promise<number[]>;
}

/** Namespace of the per-user advisory lock (`pg_advisory_xact_lock(int4, int4)`): "HBNT". */
const LOCK_NAMESPACE = 0x48424e54;

export type DbRow = {
  user_id: number;
  app_key: string;
  attempt_id: string;
  object_key: string;
  sha256: string;
  bytes: bigint | number;
  excluded: string[] | null;
  secrets_object_key: string | null;
  secrets_sha256: string | null;
  secrets_bytes: bigint | number | null;
  secrets_wrapped_key: string | null;
  reason: string | null;
  app_created_at: Date | null;
  last_activity_at: Date | null;
  hibernated_at: Date;
};

const COLUMNS = Prisma.sql`
  "user_id", "app_key", "attempt_id"::text AS "attempt_id", "object_key", "sha256", "bytes",
  "excluded", "secrets_object_key", "secrets_sha256", "secrets_bytes", "secrets_wrapped_key",
  "reason", "app_created_at", "last_activity_at", "hibernated_at"`;

export function fromDb(r: DbRow): HibernationRow {
  return {
    userId: r.user_id,
    appKey: r.app_key,
    attemptId: r.attempt_id,
    objectKey: r.object_key,
    sha256: r.sha256,
    bytes: Number(r.bytes),
    excluded: r.excluded ?? [],
    secretsObjectKey: r.secrets_object_key,
    secretsSha256: r.secrets_sha256,
    secretsBytes: r.secrets_bytes === null ? null : Number(r.secrets_bytes),
    secretsWrappedKey: r.secrets_wrapped_key,
    reason: r.reason,
    appCreatedAt: r.app_created_at,
    lastActivityAt: r.last_activity_at,
    hibernatedAt: r.hibernated_at,
  };
}

/**
 * The statements, as builders, so a test can run them against the real migration
 * (`__tests__/hibernation.repo.sql.test.ts`).
 */
export const hibernationSql = {
  list: (userId: number) => Prisma.sql`
    SELECT ${COLUMNS} FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId}
    ORDER BY "hibernated_at" DESC, "app_key" ASC`,
  remove: (userId: number, appKey: string) => Prisma.sql`
    DELETE FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId} AND "app_key" = ${appKey}
    RETURNING ${COLUMNS}`,
  oldest: (userId: number, excludeAppKey: string) => Prisma.sql`
    SELECT "app_key", "hibernated_at" FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId} AND "app_key" <> ${excludeAppKey}
    ORDER BY "hibernated_at" ASC, "app_key" ASC
    LIMIT 1`,
  get: (userId: number, appKey: string) => Prisma.sql`
    SELECT ${COLUMNS} FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId} AND "app_key" = ${appKey}`,
  usage: (userId: number, excludeAppKey: string) => Prisma.sql`
    SELECT count(*)::int AS "apps", COALESCE(sum("bytes"), 0)::bigint AS "bytes"
    FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId} AND "app_key" <> ${excludeAppKey}`,
  lock: (userId: number) =>
    Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${userId}::int)`,
  upsert: (w: HibernationRow) => Prisma.sql`
    INSERT INTO "app_sandbox_hibernations" (
      "user_id", "app_key", "attempt_id", "object_key", "sha256", "bytes", "excluded",
      "secrets_object_key", "secrets_sha256", "secrets_bytes", "secrets_wrapped_key",
      "reason", "app_created_at", "last_activity_at", "hibernated_at", "updated_at"
    ) VALUES (
      ${w.userId}, ${w.appKey}, ${w.attemptId}::uuid, ${w.objectKey}, ${w.sha256},
      ${w.bytes}::bigint, ${w.excluded}::text[], ${w.secretsObjectKey}, ${w.secretsSha256},
      ${w.secretsBytes}::bigint, ${w.secretsWrappedKey}, ${w.reason}, ${w.appCreatedAt},
      ${w.lastActivityAt}, ${w.hibernatedAt}, now()
    )
    ON CONFLICT ("user_id", "app_key") DO UPDATE SET
      "attempt_id" = EXCLUDED."attempt_id",
      "object_key" = EXCLUDED."object_key",
      "sha256" = EXCLUDED."sha256",
      "bytes" = EXCLUDED."bytes",
      "excluded" = EXCLUDED."excluded",
      "secrets_object_key" = EXCLUDED."secrets_object_key",
      "secrets_sha256" = EXCLUDED."secrets_sha256",
      "secrets_bytes" = EXCLUDED."secrets_bytes",
      "secrets_wrapped_key" = EXCLUDED."secrets_wrapped_key",
      "reason" = EXCLUDED."reason",
      "app_created_at" = EXCLUDED."app_created_at",
      "last_activity_at" = EXCLUDED."last_activity_at",
      "hibernated_at" = EXCLUDED."hibernated_at",
      "updated_at" = now()`,
  /**
   * `FOR SHARE` inside the commit transaction: an account deletion's `User` update waits for the
   * commit, or the commit waits for the deletion and then sees `deletedAt`. Either way no row is
   * written for an account whose deletion already committed.
   */
  accountState: (userId: number, forShare: boolean) => Prisma.sql`
    SELECT "deletedAt" IS NOT NULL AS "deleted", "bannedAt" IS NOT NULL AS "banned"
    FROM "User" WHERE "id" = ${userId}
    ${forShare ? Prisma.sql`FOR SHARE` : Prisma.empty}`,
  referencedKeys: (keys: string[]) => Prisma.sql`
    SELECT "object_key" AS "key" FROM "app_sandbox_hibernations"
    WHERE "object_key" = ANY(${keys}::text[])
    UNION
    SELECT "secrets_object_key" AS "key" FROM "app_sandbox_hibernations"
    WHERE "secrets_object_key" = ANY(${keys}::text[])`,
  deletedAccountsWithRows: (limit: number) => Prisma.sql`
    SELECT DISTINCT h."user_id" AS "userId" FROM "app_sandbox_hibernations" h
    JOIN "User" u ON u."id" = h."user_id"
    WHERE u."deletedAt" IS NOT NULL
    ORDER BY h."user_id"
    LIMIT ${limit}`,
  removeAll: (userId: number) => Prisma.sql`
    DELETE FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId}
    RETURNING ${COLUMNS}`,
};

export type OldestDbRow = { app_key: string; hibernated_at: Date };
export const fromOldestDb = (r: OldestDbRow): OldestSleepingApp => ({
  app: r.app_key,
  hibernatedAt: r.hibernated_at,
});

export type AccountDbRow = { deleted: boolean; banned: boolean };
export const toAccountState = (rows: AccountDbRow[]): AccountState =>
  !rows[0] ? 'missing' : rows[0].deleted ? 'deleted' : rows[0].banned ? 'banned' : 'active';

export type UsageDbRow = { apps: number; bytes: bigint | number };
export const toUsage = (rows: UsageDbRow[]): HibernationUsage => ({
  apps: Number(rows[0]?.apps ?? 0),
  bytes: Number(rows[0]?.bytes ?? 0),
});

/** Runs one statement and answers its rows. */
export type SqlQuery = <R>(sql: Prisma.Sql) => Promise<R[]>;

/**
 * What the repo needs from a database: run a statement, and run several in ONE transaction. The
 * production one is Prisma's primary; tests pass an in-process Postgres
 * (`__tests__/hibernation.repo.sql.test.ts`), so the transaction below is the code they run.
 */
export type SqlRunner = {
  query: SqlQuery;
  transaction: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>;
};

export function createHibernationRepo(db: SqlRunner): HibernationRepo {
  return {
    async list(userId) {
      // The primary: a list read right after a commit or a delete must show it.
      return (await db.query<DbRow>(hibernationSql.list(userId))).map(fromDb);
    },

    async remove(userId, appKey) {
      return db.transaction(async (tx) => {
        await tx(hibernationSql.lock(userId));
        const rows = await tx<DbRow>(hibernationSql.remove(userId, appKey));
        return rows[0] ? fromDb(rows[0]) : null;
      });
    },

    async oldest(userId, excludeAppKey) {
      const rows = await db.query<OldestDbRow>(hibernationSql.oldest(userId, excludeAppKey));
      return rows[0] ? fromOldestDb(rows[0]) : null;
    },

    async get(userId, appKey) {
      // The primary: a wake must see the commit that just landed.
      const rows = await db.query<DbRow>(hibernationSql.get(userId, appKey));
      return rows[0] ? fromDb(rows[0]) : null;
    },

    async usage(userId, excludeAppKey) {
      return toUsage(await db.query<UsageDbRow>(hibernationSql.usage(userId, excludeAppKey)));
    },

    async commit(userId, appKey, decide) {
      return db.transaction(async (tx) => {
        await tx(hibernationSql.lock(userId));
        const existing = await tx<DbRow>(hibernationSql.get(userId, appKey));
        const usage = toUsage(await tx<UsageDbRow>(hibernationSql.usage(userId, appKey)));
        const account = toAccountState(
          await tx<AccountDbRow>(hibernationSql.accountState(userId, true))
        );
        const decision = decide(existing[0] ? fromDb(existing[0]) : null, usage, account);
        if (decision.write) await tx(hibernationSql.upsert(decision.write));
        return decision.result;
      });
    },

    async accountState(userId) {
      return toAccountState(
        await db.query<AccountDbRow>(hibernationSql.accountState(userId, false))
      );
    },

    async referencedKeys(keys) {
      if (keys.length === 0) return new Set();
      const rows = await db.query<{ key: string }>(hibernationSql.referencedKeys(keys));
      return new Set(rows.map((r) => r.key));
    },

    async deletedAccountsWithRows(limit) {
      const rows = await db.query<{ userId: number }>(
        hibernationSql.deletedAccountsWithRows(limit)
      );
      return rows.map((r) => r.userId);
    },

    async removeAll(userId) {
      return (await db.query<DbRow>(hibernationSql.removeAll(userId))).map(fromDb);
    },
  };
}

/** Prisma's primary as a {@link SqlRunner}. */
const primary: SqlRunner = {
  query: <R>(sql: Prisma.Sql) => dbWrite.$queryRaw<R[]>(sql),
  transaction: (fn) =>
    dbWrite.$transaction((tx) => fn(<R>(sql: Prisma.Sql) => tx.$queryRaw<R[]>(sql))),
};

export const hibernationRepo: HibernationRepo = createHibernationRepo(primary);
