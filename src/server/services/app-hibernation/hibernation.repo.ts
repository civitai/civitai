import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';

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

/**
 * What a commit decides once it holds the user's lock: write `row` (insert, or replace the
 * user's row for that app) or not, and what to answer. Synchronous on purpose: nothing but the
 * database runs inside the transaction.
 */
export type CommitDecision<T> = { write?: HibernationRow; result: T };

export interface HibernationRepo {
  list(userId: number): Promise<HibernationRow[]>;
  get(userId: number, appKey: string): Promise<HibernationRow | null>;
  /** The user's sleeping apps and their total bytes, leaving out `excludeAppKey`'s row. */
  usage(userId: number, excludeAppKey: string): Promise<HibernationUsage>;
  /**
   * Serialised per user: reads the existing row and the usage under a transaction-scoped lock,
   * applies `decide`, and writes what it says in the same transaction.
   */
  commit<T>(
    userId: number,
    appKey: string,
    decide: (existing: HibernationRow | null, usage: HibernationUsage) => CommitDecision<T>
  ): Promise<T>;
  remove(userId: number, appKey: string): Promise<HibernationRow | null>;
  removeAll(userId: number): Promise<HibernationRow[]>;
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
    ORDER BY "hibernated_at" DESC`,
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
  remove: (userId: number, appKey: string) => Prisma.sql`
    DELETE FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId} AND "app_key" = ${appKey}
    RETURNING ${COLUMNS}`,
  removeAll: (userId: number) => Prisma.sql`
    DELETE FROM "app_sandbox_hibernations"
    WHERE "user_id" = ${userId}
    RETURNING ${COLUMNS}`,
};

export type UsageDbRow = { apps: number; bytes: bigint | number };
export const toUsage = (rows: UsageDbRow[]): HibernationUsage => ({
  apps: Number(rows[0]?.apps ?? 0),
  bytes: Number(rows[0]?.bytes ?? 0),
});

export const hibernationRepo: HibernationRepo = {
  async list(userId) {
    return (await dbRead.$queryRaw<DbRow[]>(hibernationSql.list(userId))).map(fromDb);
  },

  async get(userId, appKey) {
    // The primary: a wake must see the commit that just landed.
    const rows = await dbWrite.$queryRaw<DbRow[]>(hibernationSql.get(userId, appKey));
    return rows[0] ? fromDb(rows[0]) : null;
  },

  async usage(userId, excludeAppKey) {
    return toUsage(
      await dbWrite.$queryRaw<UsageDbRow[]>(hibernationSql.usage(userId, excludeAppKey))
    );
  },

  async commit(userId, appKey, decide) {
    return dbWrite.$transaction(async (tx) => {
      await tx.$queryRaw(hibernationSql.lock(userId));
      const existing = await tx.$queryRaw<DbRow[]>(hibernationSql.get(userId, appKey));
      const usage = toUsage(await tx.$queryRaw<UsageDbRow[]>(hibernationSql.usage(userId, appKey)));
      const decision = decide(existing[0] ? fromDb(existing[0]) : null, usage);
      if (decision.write) await tx.$executeRaw(hibernationSql.upsert(decision.write));
      return decision.result;
    });
  },

  async remove(userId, appKey) {
    const rows = await dbWrite.$queryRaw<DbRow[]>(hibernationSql.remove(userId, appKey));
    return rows[0] ? fromDb(rows[0]) : null;
  },

  async removeAll(userId) {
    return (await dbWrite.$queryRaw<DbRow[]>(hibernationSql.removeAll(userId))).map(fromDb);
  },
};
