// App Blocks — MODERATOR purge of one user's PER-USER App Storage (`kv`) rows.
//
// Parts 1-3 of per-user App Storage (sub-quota, revocation, stored-unit
// accounting) shipped without a moderator removal path: a user's own rows are
// deletable only by that user, one key at a time, through a block token. So an
// account that stored abusive or unlawful content inside an app had no takedown
// route at all, and a deleted account left its rows behind. This is that path.
//
// ── WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
//
// IN SCOPE — the PER-USER surface, in one app's `app_<slug>` schema:
//   - `kv`         — every row with `user_id = <target>`, across every
//                    block_instance_id of that app.
//   - `user_quota` — the (app_block_id, user_id) counter row.
//   - `quota`      — the APP-wide counter, decremented by the same
//                    `kv_quota_trigger` the ordinary `storage.delete` path uses.
//
// 🔴 OUT OF SCOPE — `shared_kv` (+ its `votes` / `counters` / `shared_kv_reports`).
// That is a different surface with different rules and it already has its own
// moderator verb (`apps.mod.purgeSharedRow`, hide or hard-delete, row-scoped,
// with its own report trail). Three reasons it is not folded in here:
//   1. a shared row is READABLE BY EVERY USER OF THE APP and carries other
//      users' votes on it — removing it is a decision about CONTENT, taken one
//      row at a time, not a decision about one account's stored data;
//   2. `votes` and `counters` CASCADE from `shared_kv`, so a per-author sweep
//      silently destroys other users' votes as a side effect;
//   3. the existing verb already covers it, and one rule in one place beats the
//      same rule spelled twice.
// The READ surface below still REPORTS the target's `shared_kv` row count per
// app, as `sharedRowsNotPurged` — so a moderator can see that other content
// exists and reach for the right verb, rather than assuming this one covered it.
//
// 🔴 NO MIN-TRUST GATE, and none should be added. Per-user KV is the user's OWN
// self-scoped data; the trust gate on `apps-shared.router` exists because shared
// rows are readable by others, and that rationale does not transfer. The gate
// here is `moderatorProcedure`, at the router.
//
// ── TWO DATABASES, SO NO TRANSACTION SPANS THEM ──────────────────────────────
// The rows live in the APPS db (`appsDb`, per-app `app_<slug>` schemas); the
// audit record lives in the MAIN civitai db (Prisma). There is no cross-database
// transaction, so the ORDER is the whole safety argument:
//
//     snapshot  →  WRITE THE AUDIT ROW  →  delete  →  stamp the outcome
//
// The audit row is written BEFORE anything is destroyed. If the audit write
// fails — including the case where the `action` CHECK widen has not been applied
// yet and Postgres raises 23514 — NOTHING IS DELETED. The failure mode is the
// good one: a purge that cannot be recorded does not happen. (Same posture, and
// the same reasoning, as `app-moderator-message.service.ts`, which writes its
// audit row before delivering the message.)
//
// If the DELETE succeeds but the outcome stamp fails, the destruction is already
// done and refusing would misreport it — the stamp is therefore best-effort and
// its failure is surfaced as `auditCompletionRecorded: false` rather than thrown.

import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { requireAppsDb } from '~/server/db/appsDb';
import { logToAxiom } from '~/server/logging/client';
import { newAppListingModerationEventId, newUlid } from '~/server/utils/app-block-ids';
import { appSchemaIdent, isValidAppSlug, sanitizeAppSlug } from '~/server/utils/apps-slug';

const PURGE_LOG = 'app-storage-mod-purge';

/**
 * The moderation-event `action` this path writes. Part of
 * `APP_LISTING_MODERATION_ACTIONS`, and therefore of the
 * `app_listing_mod_events_action_check` CHECK — see the manual-apply migration
 * `20260912120000_app_listing_mod_action_purge_user_storage`.
 */
export const APP_USER_STORAGE_PURGE_ACTION = 'purge-user-storage' as const;

/**
 * How many individual rows the snapshot enumerates per app. The TOTALS
 * (`rowCount` / `totalBytes`) are always exact and computed over ALL rows; only
 * the per-row listing is capped, and `rowsTruncated` says when it was.
 *
 * A cap is needed because the snapshot is persisted into a `Json` column and one
 * account can hold up to `USER_ROW_LIMIT` (1,000) rows in a single app. Rows are
 * ordered LARGEST FIRST, so a truncated listing keeps the rows that account for
 * most of the bytes rather than an arbitrary alphabetical prefix.
 */
export const APP_USER_STORAGE_SNAPSHOT_ROW_CAP = 200;

/**
 * Upper bound on how many app schemas one account-wide sweep will consider. The
 * enumeration builds ONE `UNION ALL` statement across candidate schemas, so this
 * also bounds the statement size. Exceeding it is reported as
 * `schemasTruncated`, never silently dropped.
 */
export const APP_USER_STORAGE_MAX_SCHEMAS = 500;

/**
 * A single stored row, as it will be recorded in the audit snapshot.
 *
 * 🔴 `valueMd5`, NOT the value. The snapshot must say what was destroyed, and a
 * key + size + content fingerprint does that. Copying the VALUES into the main
 * db's audit log would (a) defeat the purge — the content a moderator is
 * removing would survive in a second database — and (b) move app-owned payloads
 * across a database boundary they have never crossed. `md5()` is a core Postgres
 * function (no `pgcrypto` dependency); it is used here as an identity
 * fingerprint for matching against an app-side backup, NEVER as a security hash.
 */
export type AppUserStorageRowSnapshot = {
  key: string;
  blockInstanceId: string;
  sizeBytes: number;
  updatedAt: string;
  valueMd5: string;
};

export type AppUserStorageAppView = {
  appBlockId: string;
  /** Store slug when the block has a listing, else the raw `blockId`. */
  slug: string;
  /** The per-app schema these rows live in, e.g. `"app_my_app"`. */
  schema: string;
  /** EXACT count over every matching row, independent of the snapshot cap. */
  rowCount: number;
  /** EXACT sum of `kv.size_bytes` (STORED bytes) over every matching row. */
  totalBytes: number;
  /**
   * The trigger-maintained `user_quota` counter, or null when the app's schema
   * predates `user_quota` (nothing has been provisioned since it was added).
   */
  counter: { usedBytes: number; rowCount: number } | null;
  /**
   * Whether the counter AGREES with the rows actually present. Two
   * independently-maintained quantities: `counter` is trigger arithmetic
   * accumulated over the app's whole write history, `rowCount`/`totalBytes` are
   * a live aggregate. A `false` here is pre-existing counter drift, and it is
   * worth a moderator seeing BEFORE they purge — the purge resets the counter
   * exactly, so a drifted counter is silently repaired and they would otherwise
   * never learn it had drifted. Null counter → null verdict, not `false`.
   */
  counterMatchesRows: boolean | null;
  rows: AppUserStorageRowSnapshot[];
  rowsTruncated: boolean;
  /**
   * The target's rows in this app's `shared_kv` — reported, NEVER purged here.
   * See the header. Null when the schema has no `shared_kv` table.
   */
  sharedRowsNotPurged: number | null;
};

export type AppUserStoragePreview = {
  userId: number;
  apps: AppUserStorageAppView[];
  totals: { appCount: number; rowCount: number; totalBytes: number };
  /**
   * Schemas that hold rows for this user but could not be mapped back to an
   * `AppBlock` row. They are REPORTED and SKIPPED, never purged: without an
   * `appBlockId` there is no GUC to set and no `user_quota` key, so deleting
   * their rows would leave both counters wrong. Surfacing them is the point —
   * an unmapped schema is exactly the thing a silent sweep would miss.
   */
  unmappedSchemas: string[];
  /** True when more than `APP_USER_STORAGE_MAX_SCHEMAS` candidates existed. */
  schemasTruncated: boolean;
};

export type AppUserStoragePurgeResult = {
  appBlockId: string;
  slug: string;
  deletedRowCount: number;
  deletedBytes: number;
  /** The id of the `AppListingModerationEvent` row recording this purge. */
  auditEventId: string;
  /**
   * False when the post-delete outcome stamp failed. The audit row still exists
   * and still carries the pre-purge snapshot; only its `after` is missing.
   */
  auditCompletionRecorded: boolean;
  /** True when the `user_quota` counter row was removed (schema had the table). */
  userQuotaReset: boolean;
};

/** AppBlock ids are server-issued `apb_<ULID>`; this is the shape gate before the
 *  value is quote-doubled into a `SET LOCAL`, where `$1` is not accepted. */
const APP_BLOCK_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

/** Postgres literal quoting for the GUC value. Mirrors `apps.router`. */
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A production app schema, by the SAME regex the provisioner validates a slug
 * with. Used to filter `information_schema` output before any name is
 * interpolated into SQL.
 *
 * 🔴 THIS IS ALSO WHAT KEEPS THE REVIEW-PREVIEW NAMESPACE OUT. A run-for-real
 * preview schema is `apprev_<id>` — no underscore at index 3 — so it can never
 * satisfy `app_` + a valid slug. Do NOT replace this with a SQL
 * `LIKE 'app\_%'`: written in a JS template literal that collapses to `app_%`,
 * where `_` is LIKE's single-character wildcard, and `apprev_x` MATCHES it.
 */
function parseAppSchema(schemaName: string): string | null {
  if (!schemaName.startsWith('app_')) return null;
  const slug = schemaName.slice(4);
  return isValidAppSlug(slug) ? slug : null;
}

type BlockIdentity = { appBlockId: string; slug: string; appListingId: string | null };

/** Resolve one AppBlock to everything the purge and the audit row need. */
async function resolveBlockIdentity(
  appBlockId: string
): Promise<(BlockIdentity & { storageSlug: string }) | null> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true, blockId: true, appListing: { select: { id: true, slug: true } } },
  });
  if (!block) return null;
  const storageSlug = sanitizeAppSlug(block.blockId);
  if (!storageSlug) return null;
  return {
    appBlockId: block.id,
    // For an on-site listing `AppListing.slug` IS `AppBlock.blockId`; the
    // fallback covers a block that has no listing row yet.
    slug: block.appListing?.slug ?? block.blockId,
    appListingId: block.appListing?.id ?? null,
    storageSlug,
  };
}

type SchemaTables = { hasKv: boolean; hasUserQuota: boolean; hasSharedKv: boolean };

/**
 * One round trip for the whole cluster's shape. `information_schema` is read
 * rather than assumed because `user_quota` and `shared_kv` were both added after
 * the first apps shipped, and a schema that has not been re-provisioned since
 * simply does not have them — a bare query there is a hard `42P01`, not an empty
 * result.
 */
async function readSchemaShape(): Promise<Map<string, SchemaTables>> {
  const pool = requireAppsDb();
  const rows = (
    await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_name IN ('kv', 'user_quota', 'shared_kv')`
    )
  ).rows;
  const out = new Map<string, SchemaTables>();
  for (const r of rows) {
    const cur = out.get(r.table_schema) ?? {
      hasKv: false,
      hasUserQuota: false,
      hasSharedKv: false,
    };
    if (r.table_name === 'kv') cur.hasKv = true;
    if (r.table_name === 'user_quota') cur.hasUserQuota = true;
    if (r.table_name === 'shared_kv') cur.hasSharedKv = true;
    out.set(r.table_schema, cur);
  }
  return out;
}

/** Build the per-app view (the READ surface, and the purge's own snapshot). */
async function buildAppView(args: {
  identity: BlockIdentity & { storageSlug: string };
  tables: SchemaTables;
  userId: number;
}): Promise<AppUserStorageAppView> {
  const { identity, tables, userId } = args;
  const schema = appSchemaIdent(identity.storageSlug);
  const pool = requireAppsDb();

  const counterSelect = tables.hasUserQuota
    ? `(SELECT used_bytes FROM ${schema}.user_quota WHERE app_block_id = $2 AND user_id = $1)::text AS counter_bytes,
       (SELECT row_count  FROM ${schema}.user_quota WHERE app_block_id = $2 AND user_id = $1)::text AS counter_rows`
    : `NULL::text AS counter_bytes, NULL::text AS counter_rows`;
  const sharedSelect = tables.hasSharedKv
    ? `(SELECT count(*) FROM ${schema}.shared_kv WHERE author_user_id = $1)::text AS shared_rows`
    : `NULL::text AS shared_rows`;

  const totals = (
    await pool.query<{
      row_count: string;
      total_bytes: string;
      counter_bytes: string | null;
      counter_rows: string | null;
      shared_rows: string | null;
    }>(
      `SELECT (SELECT count(*) FROM ${schema}.kv WHERE user_id = $1)::text AS row_count,
              (SELECT COALESCE(sum(size_bytes), 0) FROM ${schema}.kv WHERE user_id = $1)::text
                AS total_bytes,
              ${counterSelect},
              ${sharedSelect}`,
      [userId, identity.appBlockId]
    )
  ).rows[0];

  const rowCount = Number(totals?.row_count ?? '0');
  const totalBytes = Number(totals?.total_bytes ?? '0');

  // Largest first: a truncated listing then keeps the rows that hold most of the
  // bytes, which is what a moderator sizing up a takedown actually needs.
  const rows =
    rowCount === 0
      ? []
      : (
          await pool.query<{
            key: string;
            block_instance_id: string;
            size_bytes: number;
            updated_at: Date;
            value_md5: string;
          }>(
            `SELECT key, block_instance_id, size_bytes, updated_at, md5(value::text) AS value_md5
               FROM ${schema}.kv
              WHERE user_id = $1
              ORDER BY size_bytes DESC, key ASC
              LIMIT $2`,
            [userId, APP_USER_STORAGE_SNAPSHOT_ROW_CAP]
          )
        ).rows;

  const counter =
    totals?.counter_bytes == null && totals?.counter_rows == null
      ? null
      : {
          usedBytes: Number(totals?.counter_bytes ?? '0'),
          rowCount: Number(totals?.counter_rows ?? '0'),
        };

  return {
    appBlockId: identity.appBlockId,
    slug: identity.slug,
    schema,
    rowCount,
    totalBytes,
    counter,
    counterMatchesRows:
      counter === null ? null : counter.usedBytes === totalBytes && counter.rowCount === rowCount,
    rows: rows.map((r) => ({
      key: r.key,
      blockInstanceId: r.block_instance_id,
      sizeBytes: Number(r.size_bytes),
      updatedAt: new Date(r.updated_at).toISOString(),
      valueMd5: r.value_md5,
    })),
    rowsTruncated: rowCount > rows.length,
    sharedRowsNotPurged: totals?.shared_rows == null ? null : Number(totals.shared_rows),
  };
}

/**
 * THE READ SURFACE. Exactly what a purge would remove, before it removes it.
 *
 * `appBlockId` narrows it to ONE app (the targeted-purge preview); omitted, it
 * sweeps every provisioned app schema (the account-wide preview). Both return
 * the same shape, and both return the same `AppUserStorageAppView` objects the
 * purge records as its `before` snapshot — so the thing a moderator reads and
 * the thing the audit log records are one value, not two descriptions of one.
 */
export async function previewUserAppStorage(args: {
  userId: number;
  appBlockId?: string | null;
}): Promise<AppUserStoragePreview> {
  const { userId } = args;
  const shape = await readSchemaShape();

  // ── Targeted: one named app. ────────────────────────────────────────────────
  if (args.appBlockId) {
    const identity = await resolveBlockIdentity(args.appBlockId);
    if (!identity) {
      return {
        userId,
        apps: [],
        totals: { appCount: 0, rowCount: 0, totalBytes: 0 },
        unmappedSchemas: [],
        schemasTruncated: false,
      };
    }
    const tables = shape.get(`app_${identity.storageSlug}`);
    // Not provisioned (or provisioned without `kv`, which cannot happen through
    // the provisioner) → nothing stored, rather than a relation error.
    if (!tables?.hasKv) {
      return {
        userId,
        apps: [],
        totals: { appCount: 0, rowCount: 0, totalBytes: 0 },
        unmappedSchemas: [],
        schemasTruncated: false,
      };
    }
    const view = await buildAppView({ identity, tables, userId });
    return {
      userId,
      apps: [view],
      totals: { appCount: 1, rowCount: view.rowCount, totalBytes: view.totalBytes },
      unmappedSchemas: [],
      schemasTruncated: false,
    };
  }

  // ── Account-wide: every provisioned app schema. ─────────────────────────────
  const allCandidates = [...shape.entries()]
    .filter(([, t]) => t.hasKv)
    .map(([name]) => name)
    .filter((name) => parseAppSchema(name) !== null)
    .sort();
  const schemasTruncated = allCandidates.length > APP_USER_STORAGE_MAX_SCHEMAS;
  const candidates = allCandidates.slice(0, APP_USER_STORAGE_MAX_SCHEMAS);

  if (candidates.length === 0) {
    return {
      userId,
      apps: [],
      totals: { appCount: 0, rowCount: 0, totalBytes: 0 },
      unmappedSchemas: [],
      schemasTruncated,
    };
  }

  // One statement for the cheap "does this user have anything here" pass. Schema
  // names are inlined because identifiers cannot be parameterised; every one has
  // already been through `parseAppSchema`.
  const pool = requireAppsDb();
  const unionSql = candidates
    .map(
      (name) =>
        `SELECT '${name}' AS schema_name, count(*)::text AS n FROM "${name}".kv WHERE user_id = $1`
    )
    .join(' UNION ALL ');
  const hits = (await pool.query<{ schema_name: string; n: string }>(unionSql, [userId])).rows
    .filter((r) => Number(r.n) > 0)
    .map((r) => r.schema_name);

  if (hits.length === 0) {
    return {
      userId,
      apps: [],
      totals: { appCount: 0, rowCount: 0, totalBytes: 0 },
      unmappedSchemas: [],
      schemasTruncated,
    };
  }

  // Map schema → AppBlock. `sanitizeAppSlug` is LOSSY (a `-` and a `_` both
  // become `_`), so the mapping cannot be inverted from the schema name — it is
  // built forwards from the AppBlock rows instead.
  const blocks = await dbRead.appBlock.findMany({
    select: { id: true, blockId: true, appListing: { select: { id: true, slug: true } } },
  });
  const bySchema = new Map<string, BlockIdentity & { storageSlug: string }>();
  for (const b of blocks) {
    const storageSlug = sanitizeAppSlug(b.blockId);
    if (!storageSlug) continue;
    bySchema.set(`app_${storageSlug}`, {
      appBlockId: b.id,
      slug: b.appListing?.slug ?? b.blockId,
      appListingId: b.appListing?.id ?? null,
      storageSlug,
    });
  }

  const apps: AppUserStorageAppView[] = [];
  const unmappedSchemas: string[] = [];
  for (const schemaName of hits) {
    const identity = bySchema.get(schemaName);
    if (!identity) {
      unmappedSchemas.push(schemaName);
      continue;
    }
    const tables = shape.get(schemaName);
    if (!tables?.hasKv) continue;
    apps.push(await buildAppView({ identity, tables, userId }));
  }

  return {
    userId,
    apps,
    totals: {
      appCount: apps.length,
      rowCount: apps.reduce((a, v) => a + v.rowCount, 0),
      totalBytes: apps.reduce((a, v) => a + v.totalBytes, 0),
    },
    unmappedSchemas,
    schemasTruncated,
  };
}

/**
 * Write the audit row BEFORE anything is destroyed. Returns the row id.
 *
 * The rail is `AppListingModerationEvent` — the audit log this codebase already
 * keeps for moderator actions on an app, with an `actorUserId`, a `reason`, and
 * `before`/`after` Json for the snapshot. No new table, and therefore no new
 * DDL beyond the one-line `action` CHECK widen that taxonomy already requires of
 * every new verb.
 *
 * The one thing the rail lacks is a `targetUserId` COLUMN — it is listing-keyed,
 * not user-keyed — so the target rides in `before.targetUserId` (structured, and
 * reachable by a JSON path query) and in `detail` (human-readable). The
 * alternative rails were considered and rejected: `ModActivity` has a
 * `targetUserId` equivalent but NO reason and NO snapshot column, which loses
 * two of the four things this record has to carry; `AppOwnershipEvent` has a
 * real `targetUserId` but its schema comment reserves it for AUTHOR/ownership
 * actions and its own CHECK admits no moderation verb.
 */
async function writeAuditIntent(args: {
  actorUserId: number;
  targetUserId: number;
  reason: string;
  view: AppUserStorageAppView;
  appListingId: string | null;
  batchId: string;
  scope: 'app' | 'account';
}): Promise<string> {
  const { view } = args;
  const id = newAppListingModerationEventId();
  await dbWrite.appListingModerationEvent.create({
    data: {
      id,
      // Nullable by design ("so the audit event outlives a listing purge"). A
      // block with no listing row writes null here and still carries a `slug`,
      // so the event stays self-describing; it is then absent from the
      // per-listing history view and present in the per-actor one.
      appListingId: args.appListingId,
      slug: view.slug,
      action: APP_USER_STORAGE_PURGE_ACTION,
      actorUserId: args.actorUserId,
      reason: args.reason,
      detail: `Purged per-user App Storage for user #${args.targetUserId} in ${view.slug}: ${view.rowCount} row(s), ${view.totalBytes} stored byte(s).`,
      before: {
        targetUserId: args.targetUserId,
        appBlockId: view.appBlockId,
        schema: view.schema,
        scope: args.scope,
        purgeBatchId: args.batchId,
        rowCount: view.rowCount,
        totalBytes: view.totalBytes,
        counter: view.counter,
        counterMatchesRows: view.counterMatchesRows,
        sharedRowsNotPurged: view.sharedRowsNotPurged,
        rowsTruncated: view.rowsTruncated,
        snapshotRowCap: APP_USER_STORAGE_SNAPSHOT_ROW_CAP,
        rows: view.rows,
      } as Prisma.InputJsonValue,
    },
  });
  return id;
}

/**
 * Purge one user's per-user rows in ONE app. The unit both public verbs are
 * built from: the account-wide sweep is N of these, each independently recorded,
 * sharing a `purgeBatchId`.
 */
async function purgeOneApp(args: {
  identity: BlockIdentity & { storageSlug: string };
  tables: SchemaTables;
  view: AppUserStorageAppView;
  targetUserId: number;
  actorUserId: number;
  reason: string;
  batchId: string;
  scope: 'app' | 'account';
}): Promise<AppUserStoragePurgeResult> {
  const { identity, tables, view, targetUserId } = args;
  if (!APP_BLOCK_ID_RE.test(identity.appBlockId)) {
    // The id is server-issued and came out of a PK lookup, so this cannot fire
    // on any row the platform wrote. It is a shape gate on the ONE value that is
    // interpolated rather than parameterised, and it fails shut.
    throw new Error(
      `app storage purge: refusing to interpolate app block id ${JSON.stringify(
        identity.appBlockId
      )}`
    );
  }
  const schema = appSchemaIdent(identity.storageSlug);

  const auditEventId = await writeAuditIntent({
    actorUserId: args.actorUserId,
    targetUserId,
    reason: args.reason,
    view,
    appListingId: identity.appListingId,
    batchId: args.batchId,
    scope: args.scope,
  });

  const pool = requireAppsDb();
  const client = await pool.connect();
  let deletedRowCount = 0;
  let deletedBytes = 0;
  let userQuotaReset = false;
  try {
    await client.query('BEGIN');
    // Same GUC the ordinary `storage.delete` path sets: `kv_quota_trigger` reads
    // it to decrement the APP-wide `quota` row. One connection, so SET LOCAL is
    // bound to the backend that runs the trigger.
    await client.query(
      `SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(identity.appBlockId)}`
    );
    const deleted = await client.query<{ size_bytes: number }>(
      `DELETE FROM ${schema}.kv WHERE user_id = $1 RETURNING size_bytes`,
      [targetUserId]
    );
    deletedRowCount = deleted.rowCount ?? deleted.rows.length;
    deletedBytes = deleted.rows.reduce((a, r) => a + Number(r.size_bytes), 0);

    // 🔴 The per-user counter is SET, not decremented. After this statement the
    // target holds zero rows in this schema BY CONSTRUCTION, so zero is a fact
    // rather than the result of arithmetic — and deleting the row is how the
    // rest of the code spells zero (`getUserQuota` returns zeroes for a missing
    // row; the `set` path COALESCEs a missing join to 0). Leaving it to the
    // trigger's subtraction would carry any pre-existing drift THROUGH the
    // purge: a counter that had drifted high would survive as a phantom balance
    // that keeps refusing the user's future writes in an app where they now
    // store nothing at all.
    if (tables.hasUserQuota) {
      await client.query(
        `DELETE FROM ${schema}.user_quota WHERE app_block_id = $1 AND user_id = $2`,
        [identity.appBlockId, targetUserId]
      );
      userQuotaReset = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Best-effort outcome stamp. The destruction has already happened; failing the
  // call here would report "nothing was purged" about a purge that ran.
  let auditCompletionRecorded = true;
  try {
    await dbWrite.appListingModerationEvent.update({
      where: { id: auditEventId },
      data: {
        after: {
          deletedRowCount,
          deletedBytes,
          userQuotaReset,
          completedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    auditCompletionRecorded = false;
    logToAxiom(
      {
        event: 'mod_purge_audit_completion_failed',
        auditEventId,
        appBlockId: identity.appBlockId,
        targetUserId,
        deletedRowCount,
        error: err instanceof Error ? err.message : String(err),
      },
      PURGE_LOG
    ).catch(() => undefined);
  }

  logToAxiom(
    {
      event: 'mod_purge_user_storage',
      scope: args.scope,
      auditEventId,
      purgeBatchId: args.batchId,
      actorUserId: args.actorUserId,
      targetUserId,
      appBlockId: identity.appBlockId,
      slug: identity.slug,
      deletedRowCount,
      deletedBytes,
      userQuotaReset,
    },
    PURGE_LOG
  ).catch(() => undefined);

  return {
    appBlockId: identity.appBlockId,
    slug: identity.slug,
    deletedRowCount,
    deletedBytes,
    auditEventId,
    auditCompletionRecorded,
    userQuotaReset,
  };
}

export class AppUserStoragePurgeError extends Error {
  constructor(readonly kind: 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'AppUserStoragePurgeError';
  }
}

/** TARGETED purge — one user, one app. */
export async function purgeUserAppStorage(args: {
  actorUserId: number;
  targetUserId: number;
  appBlockId: string;
  reason: string;
}): Promise<AppUserStoragePurgeResult> {
  const identity = await resolveBlockIdentity(args.appBlockId);
  if (!identity) {
    throw new AppUserStoragePurgeError('NOT_FOUND', 'app block not found');
  }
  const shape = await readSchemaShape();
  const tables = shape.get(`app_${identity.storageSlug}`);
  if (!tables?.hasKv) {
    // Never provisioned → there is nothing stored and nothing to record.
    return {
      appBlockId: identity.appBlockId,
      slug: identity.slug,
      deletedRowCount: 0,
      deletedBytes: 0,
      auditEventId: '',
      auditCompletionRecorded: true,
      userQuotaReset: false,
    };
  }
  const view = await buildAppView({ identity, tables, userId: args.targetUserId });
  return purgeOneApp({
    identity,
    tables,
    view,
    targetUserId: args.targetUserId,
    actorUserId: args.actorUserId,
    reason: args.reason,
    batchId: `apg_${newUlid()}`,
    scope: 'app',
  });
}

export type AppUserStorageAccountPurge = {
  userId: number;
  purgeBatchId: string;
  results: AppUserStoragePurgeResult[];
  /** Apps whose purge threw. Log-and-continue: one bad schema must not strand
   *  the rest of the sweep half-done with no record of which half. */
  failures: { appBlockId: string; slug: string; error: string }[];
  unmappedSchemas: string[];
  schemasTruncated: boolean;
  totals: { appCount: number; deletedRowCount: number; deletedBytes: number };
};

/** ACCOUNT-WIDE purge — one user, every app that holds rows for them. */
export async function purgeUserAppStorageEverywhere(args: {
  actorUserId: number;
  targetUserId: number;
  reason: string;
}): Promise<AppUserStorageAccountPurge> {
  const batchId = `apg_${newUlid()}`;
  const preview = await previewUserAppStorage({ userId: args.targetUserId });
  const shape = await readSchemaShape();

  const results: AppUserStoragePurgeResult[] = [];
  const failures: { appBlockId: string; slug: string; error: string }[] = [];

  for (const view of preview.apps) {
    const identity = await resolveBlockIdentity(view.appBlockId);
    const tables = identity ? shape.get(`app_${identity.storageSlug}`) : undefined;
    if (!identity || !tables?.hasKv) {
      failures.push({
        appBlockId: view.appBlockId,
        slug: view.slug,
        error: 'app block or schema disappeared between preview and purge',
      });
      continue;
    }
    try {
      results.push(
        await purgeOneApp({
          identity,
          tables,
          view,
          targetUserId: args.targetUserId,
          actorUserId: args.actorUserId,
          reason: args.reason,
          batchId,
          scope: 'account',
        })
      );
    } catch (err) {
      failures.push({
        appBlockId: view.appBlockId,
        slug: view.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      logToAxiom(
        {
          event: 'mod_purge_app_failed',
          purgeBatchId: batchId,
          appBlockId: view.appBlockId,
          targetUserId: args.targetUserId,
          error: err instanceof Error ? err.message : String(err),
        },
        PURGE_LOG
      ).catch(() => undefined);
    }
  }

  return {
    userId: args.targetUserId,
    purgeBatchId: batchId,
    results,
    failures,
    unmappedSchemas: preview.unmappedSchemas,
    schemasTruncated: preview.schemasTruncated,
    totals: {
      appCount: results.length,
      deletedRowCount: results.reduce((a, r) => a + r.deletedRowCount, 0),
      deletedBytes: results.reduce((a, r) => a + r.deletedBytes, 0),
    },
  };
}
