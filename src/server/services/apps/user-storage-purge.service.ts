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
//
// 🔴 `after` ANSWERS "WERE THE ROWS ACTUALLY REMOVED?", AND EVERY STATE IT CAN
// HOLD IS SOMETHING THAT WAS OBSERVED. The states:
//
//   after.outcome === 'purged'   — COMMIT returned. The rows are gone; the counts
//                                  are in the same object.
//   after.outcome === 'failed'   — nothing was destroyed, because no COMMIT was
//                                  ever sent: either no connection was made, or the
//                                  transaction was abandoned before COMMIT. A
//                                  transaction that never receives COMMIT cannot be
//                                  durable, so this holds whether or not the
//                                  ROLLBACK statement got through.
//                                  `deletedRowCount: 0` is a measurement here.
//   after.outcome === 'unknown'  — COMMIT was sent and threw, so the server may or
//                                  may not have applied it. `deletedRowCount` is
//                                  ABSENT, deliberately: its absence is the signal.
//                                  `observedDeleteRowCount` says what the DELETE
//                                  reported, which bounds what may be gone.
//   after === null               — the row was written and NO stamp reached the
//                                  database. Nothing about the rows' fate is
//                                  recorded.
//
// 🔴 TWO EARLIER VERSIONS OF THIS COMMENT WERE WRONG, IN THE SAME DIRECTION BOTH
// TIMES — they named a state and asserted an outcome the code had not established.
// A null `after` was called "attempted, completion unrecorded" while it also
// covered a completed purge; then `'failed'` asserted `rolledBack: true` and
// `deletedRowCount: 0` from a rollback result that had been discarded. A THIRD
// version then justified `'unknown'` on a failed ROLLBACK as "genuinely
// unestablished" when a never-committed transaction settles it either way — an
// over-claim of UNCERTAINTY rather than of certainty, but still false, and on a
// takedown row it sends someone investigating nothing.
//
// If a state's meaning cannot be established, this comment must say it cannot —
// that is why `'unknown'` exists and why it omits the count rather than
// defaulting it. Where it CAN be established, it must not hide behind
// `'unknown'` either.

import type { Prisma } from '@prisma/client';
// The pool's `connect` is OVERLOADED (callback form + promise form), so deriving
// the client type from its return — `Awaited<ReturnType<…['connect']>>` — selects
// the CALLBACK overload and resolves to `void`. Name the type instead.
import type { PoolClient } from 'pg';
import { dbRead, dbWrite } from '~/server/db/client';
import { requireAppsDb } from '~/server/db/appsDb';
import { logToAxiom } from '~/server/logging/client';
import { newAppListingModerationEventId, newUlid } from '~/server/utils/app-block-ids';
import { appSchemaIdent, isValidAppSlug, sanitizeAppSlug } from '~/server/utils/apps-slug';

/**
 * The SAME datastream `apps.router`'s storage ops write to, not a new one.
 *
 * Two reasons, and the second is a gate. A purge is a tRPC storage op on the same
 * rows as the `set`/`delete` events that created them, so keeping one stream is
 * what lets a reviewer read the writes and the takedown in one place. And
 * `axiom-datastream-ledger.test.ts` requires every datastream a production call
 * site names to be either PROVISIONED in Axiom or ledgered LOKI-ONLY: a fresh
 * name here would be neither, i.e. a stream nobody had provisioned and nothing
 * could read. `app-storage-trpc` is already ledgered for exactly this traffic.
 *
 * Note this is the OPS log only. The durable, reviewable record of a purge is the
 * `AppListingModerationEvent` row, not this line.
 */
const PURGE_LOG = 'app-storage-trpc';

/**
 * The moderation-event `action` this path writes. Part of
 * `APP_LISTING_MODERATION_ACTIONS`, and therefore of the
 * `app_listing_mod_events_action_check` CHECK — see the manual-apply migration
 * `20260912120000_app_listing_mod_action_purge_user_storage`.
 */
export const APP_USER_STORAGE_PURGE_ACTION = 'purge-user-storage' as const;

/**
 * WHO set this purge in motion. Recorded STRUCTURALLY in the audit row's
 * `before.initiator`, never derived from the `reason` text.
 *
 * 🔴 THE REASON STRING CANNOT CARRY THIS AND MUST NOT BE READ AS IF IT DID. A
 * moderator types `reason` freely, so any sentinel wording a system purge used
 * could be typed by hand — "distinguishable" would then rest on a word another
 * caller can spell. `initiator` is set by the CODE PATH: the two `apps.mod.*`
 * verbs hard-code `'moderator'` and neither accepts it from input, and the
 * account-wipe hook hard-codes `'system:account-wipe'`. So a later reader can
 * always tell "the system did this as part of a wipe" from "a moderator decided
 * this", which is the thing the audit record exists to carry.
 */
export type AppUserStoragePurgeInitiator = 'moderator' | 'system:account-wipe';

/**
 * The `reason` recorded when an account wipe triggers the purge.
 *
 * Deliberately reads as machine-emitted (bracketed tag, names the function that
 * fired it) rather than as a sentence a human would write — but the LOAD-BEARING
 * discriminator is `before.initiator`, not this string. It exists because the
 * rail requires a non-empty 3..1000 char reason and a blank one would be worse:
 * it would read as a moderator who could not be bothered.
 */
export const ACCOUNT_WIPE_PURGE_REASON = '[system] account content wipe (user.removeAllContent)';

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
 * function (no `pgcrypto` dependency); it is an identity fingerprint, NEVER a
 * security hash.
 *
 * 🔴 AND THE FINGERPRINT'S USEFULNESS IS BOUNDED — do not read it as a restore
 * path. Its only purpose is matching a purged row against an apps-DB backup, and
 * that backup retention is SEVEN DAYS. The audit row is permanent, so from day 8
 * onward every `valueMd5` in it matches nothing that still exists anywhere.
 * Nothing in the tree reads this field today.
 *
 * 🔴 AND IT IS RECORDED ON THE MODERATOR PATHS ONLY. The account-wipe path
 * (`initiator: 'system:account-wipe'`) persists counts and bytes but NO `rows[]`
 * at all — see the note in `writeAuditIntent`. An erasure must not leave a
 * durable derived artefact of the content it erased; a takedown a human ordered
 * is a different question, and this paragraph is about that one.
 *
 * It is kept rather than dropped because those seven days are exactly the window
 * in which a wrongful purge gets contested, and the plumbing costs nothing — the
 * 200-row cap and `rowsTruncated` are needed for a plain key list anyway. The
 * honest cost, stated so a later reader can weigh it: a permanent md5 of content
 * that no longer exists still lets someone CONFIRM A GUESS ("did this account
 * store exactly X?"), which a bare key + byte count would not. If that trade
 * stops looking worthwhile, dropping the `md5(value::text)` column from the
 * snapshot query is a self-contained change.
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
  /**
   * The per-app schema these rows live in, as a BARE identifier (`app_my_app`),
   * not the quoted form `appSchemaIdent` produces for SQL.
   *
   * This value is persisted into the permanent audit snapshot, so the quotes are
   * not cosmetic: a JSON-path query over the moderation trail would have to strip
   * them, and a reader comparing against `information_schema.schemata` (which
   * stores bare names) would silently never match. The quoted form exists solely
   * to be interpolated into a statement and stays local to the SQL that needs it.
   */
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
   * and still carries the pre-purge snapshot; only its `after` is missing, which
   * is the one state in which the rows' fate is genuinely unrecorded.
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

/**
 * Which AppBlock owns each `app_<slug>` schema — and, crucially, which schemas
 * are owned by MORE THAN ONE.
 *
 * 🔴 THE SLUG MAP IS NOT INJECTIVE. This is stated plainly because the previous
 * two attempts to justify it were both wrong, and a third rationale composed to
 * fill the gap is how the class regenerates. `sanitizeAppSlug` collapses every
 * RUN of non-alphanumeric characters to a single `_`
 * (`replace(/[^a-z0-9]+/g, '_')`), and the published manifest pattern
 * `^[a-z][a-z0-9-]*[a-z0-9]$` admits consecutive hyphens. Measured: `my-app`,
 * `my--app` and `my---app` are ALL manifest-legal and ALL resolve to
 * `app_my_app`. (The earlier claim that the pattern "admits no underscore" was
 * true and irrelevant — underscores were never the failure mode; hyphen RUNS
 * are.)
 *
 * Two such blocks therefore share one `kv` table, and nothing upstream prevents
 * it. The consequence is the worst kind: a purge aimed at one app deletes the
 * user's rows for BOTH, decrements only the named app's `quota`, and leaves the
 * other app's `user_quota` holding exactly the phantom balance this service
 * warns about elsewhere — a counter for rows that no longer exist, which keeps
 * refusing that user's writes forever.
 *
 * So a schema claimed by two or more blocks is DISQUALIFIED, never resolved to
 * an arbitrary winner. Callers treat it the same as a schema claimed by none:
 * reported, skipped, never purged.
 *
 * Shared by both verbs on purpose. The targeted purge originally had no
 * equivalent check at all, so the guard existed at one of the two call sites
 * that needed it — a predicate open-coded once is a predicate wrong everywhere
 * else.
 */
async function resolveSchemaOwnership(): Promise<{
  bySchema: Map<string, BlockIdentity & { storageSlug: string }>;
  collidingSchemas: Set<string>;
}> {
  const blocks = await dbRead.appBlock.findMany({
    select: { id: true, blockId: true, appListing: { select: { id: true, slug: true } } },
  });
  const bySchema = new Map<string, BlockIdentity & { storageSlug: string }>();
  const collidingSchemas = new Set<string>();
  for (const b of blocks) {
    const storageSlug = sanitizeAppSlug(b.blockId);
    if (!storageSlug) continue;
    const schemaName = `app_${storageSlug}`;
    if (bySchema.has(schemaName)) {
      collidingSchemas.add(schemaName);
      continue;
    }
    bySchema.set(schemaName, {
      appBlockId: b.id,
      slug: b.appListing?.slug ?? b.blockId,
      appListingId: b.appListing?.id ?? null,
      storageSlug,
    });
  }
  for (const name of collidingSchemas) bySchema.delete(name);
  return { bySchema, collidingSchemas };
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
      // 🔴 THE BIND LIST FOLLOWS THE FRAGMENTS, because `$2` lives ONLY inside
      // `counterSelect`. When a schema has no `user_quota` that fragment becomes
      // a literal `NULL` and `$2` disappears from the statement entirely — but
      // `pg` still ships whatever array it is handed, and Postgres rejects the
      // mismatch outright: `bind message supplies 2 parameters, but prepared
      // statement "" requires 1`. That is a hard 500 on the PRIMARY read path,
      // not a degraded result.
      //
      // It is also not an edge case: `user_quota` arrived in a later
      // provisioner DDL change, so every schema not re-provisioned since is
      // exactly this branch — measured at 11 of 20 in production. Account-wide
      // `preview` and `purgeAccount` both enumerate every schema, so ONE such
      // schema took out the whole sweep, healthy apps included.
      //
      // Any future fragment that carries a `$n` must extend this the same way.
      // The suites' fake now validates bind arity against the highest `$n` in
      // the statement text, so a regression here fails in the suite rather than
      // in production.
      tables.hasUserQuota ? [userId, identity.appBlockId] : [userId]
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
    // Bare name — see the field's docstring. The quoted `schema` local is for SQL.
    schema: `app_${identity.storageSlug}`,
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
    // 🔴 THE SAME OWNERSHIP CHECK THE SWEEP AND THE PURGE MAKE. Without it the
    // READ and the WRITE disagreed about the same schema: with `my-app` and
    // `my--app` both present (the reachable collision — see
    // `resolveSchemaOwnership`), a targeted preview of `my-app` reported BOTH
    // apps' rows, key names and fingerprints as if they were all `my-app`'s,
    // while the account-wide preview called that schema unresolvable and
    // `purgeApp` refused with CONFLICT. Nothing was destroyed by it, but the read
    // surface is what a moderator approves, and it showed one app's contents
    // merged into another's with no signal at all.
    //
    // Disqualified the same way the sweep does — reported, not rendered — so all
    // three paths give one answer.
    const targetedSchemaName = `app_${identity.storageSlug}`;
    const { collidingSchemas } = await resolveSchemaOwnership();
    if (collidingSchemas.has(targetedSchemaName)) {
      // 🔴 ESTABLISH THE PREDICATE BEFORE REPORTING IT. `unmappedSchemas` means
      // "holds rows for this user AND could not be resolved to one app" — the
      // sweep only ever populates it from schemas whose row count is already
      // known to be > 0. Returning the name here unconditionally told a moderator
      // that a schema holds their target's rows and needs a human when it may hold
      // nothing at all, falsifying the field's own docstring. False-positive
      // direction, so it costs an investigation rather than a destruction — but an
      // audit surface that cries wolf is how the real signal stops being read.
      //
      // The count is safe to take even though the schema is ambiguous: it is a
      // statement about the SCHEMA, not an attribution of rows to either app,
      // which is the thing this branch refuses to do.
      const tablesForAmbiguous = shape.get(targetedSchemaName);
      let ambiguousHoldsRows = false;
      if (tablesForAmbiguous?.hasKv) {
        const pool = requireAppsDb();
        const counted = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${targetedSchemaName}".kv WHERE user_id = $1`,
          [userId]
        );
        ambiguousHoldsRows = Number(counted.rows[0]?.n ?? '0') > 0;
      }
      return {
        userId,
        apps: [],
        totals: { appCount: 0, rowCount: 0, totalBytes: 0 },
        unmappedSchemas: ambiguousHoldsRows ? [targetedSchemaName] : [],
        schemasTruncated: false,
      };
    }

    const tables = shape.get(targetedSchemaName);
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

  const { bySchema } = await resolveSchemaOwnership();

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
 * THE READ, AS A MODERATOR PERFORMS IT — `previewUserAppStorage` plus the record
 * that it happened. The router calls this; the account-wide purge calls the bare
 * function above, so an internal enumeration does not forge a "a moderator
 * looked" event.
 *
 * 🔴 WHY THIS EXISTS. Without it a moderator can enumerate ANY user's stored key
 * names, sizes, timestamps and content fingerprints across every app and leave no
 * trace — while an ordinary user deleting their OWN key writes a
 * `recordScopeInvocation` row (`apps.router.ts`). The destructive verbs were
 * specified with four audit fields and the read was specified to be built first,
 * but nobody asked whether the read should be attributable. It should: reading
 * another person's stored data is the act, whether or not anything is deleted.
 *
 * 🔴 A LOG LINE, NOT AN `AppListingModerationEvent` ROW — three reasons, and the
 * middle one is structural rather than a preference:
 *   1. That rail is a MODERATION-ACTION log. Its consumers render action chips in
 *      the per-listing history and in the app owner's own history, where an entry
 *      means "something was done to this listing". A read is not that, and
 *      putting one there would be a category error visible in two UIs.
 *   2. An ACCOUNT-WIDE preview has no listing and no single slug, and the rail
 *      requires a non-null `slug`. Recording one would mean fabricating a
 *      sentinel slug — the exact smell avoided everywhere else here.
 *   3. Reads are unbounded relative to actions (a moderator previews repeatedly
 *      while investigating), and it needs no DDL, so it adds nothing further for
 *      a human to remember to apply.
 *
 * 🔴 WHAT A READER OF THE TRAIL CAN AND CANNOT RECONSTRUCT. CAN: that actor A
 * enumerated target U's storage, at a time, at app or account scope, and how much
 * was there (app count, row count, bytes) — for as long as the log store retains
 * it, which is a retention window, NOT the permanent record a purge gets. CANNOT:
 * WHICH KEYS they saw, ever. That is deliberate and is the same argument as
 * storing no values in the purge snapshot — writing the key names here would copy
 * the user's data into a second store in order to record that someone looked at
 * it. So the trail answers "who looked at whose data, and when", and does not
 * answer "what exactly did they see".
 */
export async function previewUserAppStorageAsModerator(args: {
  actorUserId: number;
  userId: number;
  appBlockId?: string | null;
}): Promise<AppUserStoragePreview> {
  const preview = await previewUserAppStorage({
    userId: args.userId,
    appBlockId: args.appBlockId ?? null,
  });
  // Fire-and-forget: an audit line must never fail the read it describes.
  logToAxiom(
    {
      event: 'mod_preview_user_storage',
      actorUserId: args.actorUserId,
      targetUserId: args.userId,
      scope: args.appBlockId ? 'app' : 'account',
      appBlockId: args.appBlockId ?? null,
      // Counts only — never key names. See the note above.
      appCount: preview.totals.appCount,
      rowCount: preview.totals.rowCount,
      totalBytes: preview.totals.totalBytes,
      unmappedSchemaCount: preview.unmappedSchemas.length,
      schemasTruncated: preview.schemasTruncated,
    },
    PURGE_LOG
  ).catch(() => undefined);
  return preview;
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
  /**
   * NULL when no human ordered it. `AppListingModerationEvent.actorUserId` is
   * `Int?` with `onDelete: SetNull` precisely so the trail can outlive its actor,
   * so null is a first-class state on this rail rather than a hole. It is the
   * honest value for the webhook caller of `removeAllContent`, which is
   * authenticated by a shared secret and carries no user identity at all.
   */
  actorUserId: number | null;
  targetUserId: number;
  reason: string;
  initiator: AppUserStoragePurgeInitiator;
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
        initiator: args.initiator,
        appBlockId: view.appBlockId,
        schema: view.schema,
        scope: args.scope,
        purgeBatchId: args.batchId,
        rowCount: view.rowCount,
        totalBytes: view.totalBytes,
        counter: view.counter,
        counterMatchesRows: view.counterMatchesRows,
        sharedRowsNotPurged: view.sharedRowsNotPurged,
        // 🔴 THE PER-KEY SNAPSHOT IS WITHHELD ON THE ACCOUNT-WIPE PATH.
        //
        // `removeAllContent` is an ERASURE. Writing the wiped account's key names
        // and content fingerprints into a permanent main-DB row would create a
        // durable derived artefact OF THE CONTENT BEING ERASED — the audit row
        // would outlive, and partially describe, the very thing the operation
        // exists to remove.
        //
        // The `valueMd5` justification on `AppUserStorageRowSnapshot` is a
        // MODERATOR-TAKEDOWN argument: a human chose to act, a reviewable record
        // of what they destroyed is plainly wanted, and the fingerprint is
        // matchable against a backup for seven days. None of that transfers to an
        // erasure. So the two paths deliberately carry DIFFERENT shapes, and the
        // docstring on that type says which is which.
        //
        // What survives is everything answering "was anything removed, and how
        // much?" — counts, bytes, app identity, and the `after` outcome stamp.
        // What goes is the per-key detail.
        //
        // 🔴 SELECTED BY `initiator`, AND THE GUARANTEE RESTS ON TWO THINGS, NOT
        // ONE. This is the security argument for the reduction, so it is stated at
        // the strength it actually holds rather than at the strength that reads
        // well.
        //
        //   (1) Neither tRPC procedure DECLARES `initiator` in its input schema.
        //   (2) Each procedure's wire key set is pinned EXACTLY by a ledger in
        //       `apps-mod-storage.router.test.ts`, which fails when the set grows
        //       OR shrinks.
        //
        // (1) alone is NECESSARY BUT NOT SUFFICIENT, and an earlier version of
        // this comment claimed it was — "both schemas omit it, so no remote caller
        // can choose a shape". That is false, because the schema is only the first
        // of two links: the ROUTER BODY is what passes anything to the service's
        // `initiator?:`. A schema can omit `initiator` and still forward one under
        // another name. Measured: adding `asSystem: z.boolean().optional()` to
        // `purgeApp`'s input plus `initiator: input.asSystem ? …` to the service
        // call is a moderator takedown whose permanent row names none of the keys
        // it destroyed — and it ran the whole delta suite green until (2) existed.
        //
        // (2) is what closes it, and it closes it BY CONSTRUCTION rather than by
        // spelling: it does not look for the word `initiator`, it refuses any new
        // wire key at all. So the honest form is "a new wire field cannot be added
        // without that ledger failing", not "no remote caller can choose a shape".
        //
        // Neither point is about the function signature: both service functions
        // export an optional `initiator?:` and `purgeUserAppStorageForAccountWipe`
        // is exactly such an in-process caller. That is fine and deliberate.
        //
        // Separately, the REDUCTION ITSELF is pinned by a guard asserting the wipe
        // row contains none of the key names or fingerprint VALUES — a state
        // assertion, so renaming the field does not walk past it. That guard pins
        // what gets written; the ledger above pins who can ask for it.
        ...(args.initiator === 'system:account-wipe'
          ? { rowDetailWithheld: 'erasure' }
          : {
              rowsTruncated: view.rowsTruncated,
              snapshotRowCap: APP_USER_STORAGE_SNAPSHOT_ROW_CAP,
              rows: view.rows,
            }),
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
  actorUserId: number | null;
  reason: string;
  initiator: AppUserStoragePurgeInitiator;
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
    initiator: args.initiator,
    view,
    appListingId: identity.appListingId,
    batchId: args.batchId,
    scope: args.scope,
  });

  let deletedRowCount = 0;
  let deletedBytes = 0;
  let userQuotaReset = false;

  // 🔴 THE POOL CHECKOUT IS INSIDE THE TRY. It used to sit above it, and that one
  // line put the whole failure apparatus out of reach of the most ordinary fault
  // there is: a connection timeout. Anything throwing between the audit write and
  // `BEGIN` bypassed the failure stamp, the `mod_purge_app_failed` log AND the
  // error wrapper that carries the audit id — producing exactly the orphaned
  // `before`-only row this service claims to have eliminated, with
  // `auditEventId: null` in the sweep's `failures[]` so the correlation did not
  // apply either. Measured with an injected `connect()` rejection: one row, no
  // stamp of either kind, no log line.
  //
  // `client` is declared out here so the catch can tell "never connected" from
  // "connected, then rolled back" — those are different answers to the only
  // question the row exists to answer.
  let client: PoolClient | undefined;
  // Whether `COMMIT` was REACHED. Load-bearing for the outcome below: a COMMIT
  // that threw may still have been applied by the server, so "we sent it" and
  // "it did not happen" are not the same claim.
  let commitAttempted = false;
  try {
    const pool = requireAppsDb();
    client = await pool.connect();
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
    commitAttempted = true;
    await client.query('COMMIT');
  } catch (err) {
    // 🔴 READ THE ROLLBACK'S RESULT INSTEAD OF DISCARDING IT. The previous version
    // ran `.catch(() => undefined)` here and then asserted `rolledBack: true`
    // unconditionally — recording a conclusion it had thrown away the evidence
    // for. Same inversion this block was added to fix, on the lines that fixed it.
    // 🔴 THE NAME IS `rollbackStatementOk`, NOT `rollbackConfirmed`, AND THE
    // DIFFERENCE IS THE WHOLE POINT. All this records is that the ROLLBACK
    // statement RETURNED WITHOUT ERROR. Postgres accepts `ROLLBACK` outside a
    // transaction — it warns and returns OK — so `commitAttempted: true` together
    // with a successful ROLLBACK is reachable (COMMIT throws a deferred-constraint
    // or serialization error, the transaction is already resolved, the ROLLBACK
    // then returns fine). Under the old name a reader re-deriving from that pair
    // concluded "rolled back cleanly, nothing destroyed" — the exact opposite of
    // the `outcome` stored beside it. Persisted evidence must not be readable
    // against its own verdict.
    let rollbackStatementOk: boolean | null = null;
    if (client) {
      try {
        await client.query('ROLLBACK');
        rollbackStatementOk = true;
      } catch {
        rollbackStatementOk = false;
      }
    }

    // 🔴 WHEN CAN WE SAY "NOTHING WAS DESTROYED"? When no COMMIT was ever sent.
    //
    // The reasoning is about POSTGRES TRANSACTION SEMANTICS, not about what our
    // own statements returned. Every statement in the block above runs after a
    // successful `BEGIN`, so it is inside an explicit transaction; a transaction
    // that never receives `COMMIT` cannot become durable, whether we managed to
    // send `ROLLBACK` or the connection simply died — the server discards it
    // either way. So `!commitAttempted` establishes "nothing destroyed" on its
    // own, and the ROLLBACK's return value is EVIDENCE, not part of the verdict.
    //
    // 🔴 THIS DELIBERATELY NARROWS AN EARLIER, MORE CONSERVATIVE VERSION, which
    // also required `rollbackStatementOk === true`. That was wrong in the
    // direction that matters here: it recorded `'unknown'` — "we cannot tell
    // whether your data was destroyed" — for a case where we can tell, on a
    // takedown row. Over-claiming uncertainty is a smaller harm than
    // over-claiming certainty, but it is still a false statement in a permanent
    // record, and it would send someone investigating nothing.
    //
    // The one assumption: no statement in the transaction block runs outside the
    // explicit transaction. `BEGIN` is the first statement and its failure jumps
    // straight here, so there is no autocommit path through it.
    const nothingDestroyed = !client || !commitAttempted;
    // 🔴 STAMP THE FAILURE BEFORE RETHROWING, or this row becomes ambiguous.
    // "Were the rows actually removed?" is the question a takedown record exists
    // to answer, and without this stamp a rolled-back delete and a successful
    // delete whose stamp failed are byte-identical: `before` present, `after`
    // null. One of those destroyed nothing and the other destroyed everything.
    //
    // Best-effort, and deliberately does NOT swallow the original error: the
    // caller must still see the failure. If this stamp ALSO fails, `after` stays
    // null, which means only that no stamp reached the database — it says nothing
    // about the rows, and the header block above is the authority on that.
    await dbWrite.appListingModerationEvent
      .update({
        where: { id: auditEventId },
        data: {
          after: {
            outcome: nothingDestroyed ? 'failed' : 'unknown',
            // Emitted ONLY when observed. Its ABSENCE is the signal that the
            // count is not established — better than a literal 0, which is a
            // confident claim, and the wrong one, about a purge that may have
            // committed.
            ...(nothingDestroyed ? { deletedRowCount: 0 } : {}),
            // What the DELETE statement itself reported, before the transaction
            // resolved. Not the same thing as "rows destroyed" — on the 'failed'
            // path these rows came back — but it is what was observed, and on the
            // 'unknown' path it is the best available bound on what may be gone.
            observedDeleteRowCount: deletedRowCount,
            observedDeleteBytes: deletedBytes,
            // The evidence the outcome above was derived from, recorded so a
            // reader can re-derive it rather than trust it.
            connected: !!client,
            commitAttempted,
            // Records that the statement RETURNED, not that a rollback happened.
            // See the note where it is set.
            rollbackStatementOk,
            error: err instanceof Error ? err.message : String(err),
            failedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    // 🔴 LOG HERE, NOT AT THE TWO CALL SITES. An orphaned `before`-only row with
    // no correlate anywhere was the other half of this gap: the account-wide
    // sweep logged a failure carrying no `auditEventId`, and the TARGETED verb
    // logged nothing at all, so the row a reviewer found could not be tied to
    // any operational record. Both verbs funnel through here, so one line covers
    // both and cannot drift between them.
    //
    // That funnel only became real when the pool checkout moved INSIDE the try
    // above. While `connect()` sat outside it, a connection timeout reached none
    // of this — the claim was true of the code it pointed at and false of the
    // path that actually failed most often.
    logToAxiom(
      {
        event: 'mod_purge_app_failed',
        auditEventId,
        purgeBatchId: args.batchId,
        scope: args.scope,
        initiator: args.initiator,
        actorUserId: args.actorUserId,
        targetUserId,
        appBlockId: identity.appBlockId,
        slug: identity.slug,
        error: err instanceof Error ? err.message : String(err),
      },
      PURGE_LOG
    ).catch(() => undefined);

    throw new AppUserStoragePurgeFailed(
      err instanceof Error ? err.message : String(err),
      auditEventId,
      err
    );
  } finally {
    client?.release();
  }

  // Best-effort outcome stamp. The destruction has already happened; failing the
  // call here would report "nothing was purged" about a purge that ran.
  let auditCompletionRecorded = true;
  try {
    await dbWrite.appListingModerationEvent.update({
      where: { id: auditEventId },
      data: {
        after: {
          outcome: 'purged',
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
      initiator: args.initiator,
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

/**
 * A purge whose DELETE failed and rolled back. Carries the `auditEventId` so the
 * audit row — whose `after.outcome` is `'failed'` when the purge was observed to
 * have destroyed nothing, or `'unknown'` when it could not be established — can
 * be tied to the operational record and to the sweep's `failures[]` entry. The
 * original error is preserved as `cause`; nothing about the failure is dropped
 * in order to attach the id.
 */
export class AppUserStoragePurgeFailed extends Error {
  constructor(message: string, readonly auditEventId: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AppUserStoragePurgeFailed';
  }
}

export class AppUserStoragePurgeError extends Error {
  constructor(readonly kind: 'NOT_FOUND' | 'AMBIGUOUS_SCHEMA', message: string) {
    super(message);
    this.name = 'AppUserStoragePurgeError';
  }
}

/** TARGETED purge — one user, one app. */
export async function purgeUserAppStorage(args: {
  actorUserId: number | null;
  targetUserId: number;
  appBlockId: string;
  reason: string;
  /** Defaults to `'moderator'`; the router never passes anything else. */
  initiator?: AppUserStoragePurgeInitiator;
}): Promise<AppUserStoragePurgeResult> {
  const identity = await resolveBlockIdentity(args.appBlockId);
  if (!identity) {
    throw new AppUserStoragePurgeError('NOT_FOUND', 'app block not found');
  }

  // 🔴 THE SAME COLLISION GUARD THE SWEEP APPLIES — this verb had none, which is
  // where the hazard was actually reachable. The account-wide path disqualified a
  // schema claimed by two blocks; the targeted path resolved one block, derived
  // its schema, and deleted, so a purge aimed at `my-app` also destroyed
  // `my--app`'s rows for that user, decremented only `my-app`'s `quota`, and left
  // `my--app`'s `user_quota` as a phantom balance. See `resolveSchemaOwnership`
  // for why the map is not injective.
  const { collidingSchemas } = await resolveSchemaOwnership();
  const schemaName = `app_${identity.storageSlug}`;
  if (collidingSchemas.has(schemaName)) {
    throw new AppUserStoragePurgeError(
      'AMBIGUOUS_SCHEMA',
      `storage schema ${schemaName} is claimed by more than one app block; refusing to purge`
    );
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
    initiator: args.initiator ?? 'moderator',
    batchId: `apg_${newUlid()}`,
    scope: 'app',
  });
}

/**
 * ACCOUNT-WIPE hook — the entry point `removeAllContent` calls.
 *
 * 🔴 WHY THIS EXISTS AS ITS OWN FUNCTION rather than the wipe calling
 * `purgeUserAppStorageEverywhere` directly: the `reason` and the `initiator` are
 * a property of THIS path, not a decision for the call site. Inlining them at the
 * caller would let a future second caller invent a different wording, and the
 * audit trail's ability to say "the system did this" would then depend on every
 * call site remembering to spell it the same way.
 *
 * 🔴 WHY THE WIPE AND NOT `deleteUser`. `deleteUser` is a SOFT delete: it sets
 * `deletedAt`, scrubs the profile fields and reassigns models, and it has a live
 * inverse in `restoreUser` (same file) which explicitly documents what it brings
 * back. Hanging an irreversible cross-database purge off a reversible delete
 * would be a worse defect than the gap it closes — restore would return an
 * account whose app storage had been destroyed with no way back.
 * `removeAllContent` is the hard wipe (`deleteMany` across ~18 tables, S3 objects,
 * search-index deletes) and has no inverse, so it is the honest place for this.
 */
export async function purgeUserAppStorageForAccountWipe(args: {
  targetUserId: number;
  /** The acting moderator when one exists; null on the webhook path. */
  actorUserId: number | null;
}): Promise<AppUserStorageAccountPurge> {
  return purgeUserAppStorageEverywhere({
    actorUserId: args.actorUserId,
    targetUserId: args.targetUserId,
    reason: ACCOUNT_WIPE_PURGE_REASON,
    initiator: 'system:account-wipe',
  });
}

export type AppUserStorageAccountPurge = {
  userId: number;
  purgeBatchId: string;
  results: AppUserStoragePurgeResult[];
  /** Apps whose purge threw. Log-and-continue: one bad schema must not strand
   *  the rest of the sweep half-done with no record of which half. */
  failures: {
    appBlockId: string;
    slug: string;
    error: string;
    /**
     * The audit row for this app. Its `after.outcome` is `'failed'` (observed to
     * have destroyed nothing) or `'unknown'` (COMMIT threw, or the ROLLBACK could
     * not be confirmed) — read it rather than assuming which.
     *
     * Null ONLY when the purge threw before the row was written. Since the pool
     * checkout moved inside the try, a connection failure is NOT such a case: it
     * is stamped like any other.
     */
    auditEventId: string | null;
  }[];
  unmappedSchemas: string[];
  schemasTruncated: boolean;
  totals: { appCount: number; deletedRowCount: number; deletedBytes: number };
};

/** ACCOUNT-WIDE purge — one user, every app that holds rows for them. */
export async function purgeUserAppStorageEverywhere(args: {
  actorUserId: number | null;
  targetUserId: number;
  reason: string;
  /** Defaults to `'moderator'`; the router never passes anything else. */
  initiator?: AppUserStoragePurgeInitiator;
}): Promise<AppUserStorageAccountPurge> {
  const batchId = `apg_${newUlid()}`;
  const preview = await previewUserAppStorage({ userId: args.targetUserId });
  const shape = await readSchemaShape();

  const results: AppUserStoragePurgeResult[] = [];
  const failures: AppUserStorageAccountPurge['failures'] = [];

  for (const view of preview.apps) {
    const identity = await resolveBlockIdentity(view.appBlockId);
    const tables = identity ? shape.get(`app_${identity.storageSlug}`) : undefined;
    if (!identity || !tables?.hasKv) {
      failures.push({
        appBlockId: view.appBlockId,
        slug: view.slug,
        error: 'app block or schema disappeared between preview and purge',
        // No purge was attempted, so no audit row exists to point at.
        auditEventId: null,
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
          initiator: args.initiator ?? 'moderator',
          batchId,
          scope: 'account',
        })
      );
    } catch (err) {
      failures.push({
        appBlockId: view.appBlockId,
        slug: view.slug,
        error: err instanceof Error ? err.message : String(err),
        // `purgeOneApp` stamps the audit row (`after.outcome` is `'failed'` or
        // `'unknown'` — it does not assume which) and throws an
        // `AppUserStoragePurgeFailed` carrying its id, so the sweep's report and
        // the row can be tied together. Anything that threw BEFORE the row existed
        // leaves this null.
        auditEventId: err instanceof AppUserStoragePurgeFailed ? err.auditEventId : null,
      });
      // NOT logged here — `purgeOneApp` already emits `mod_purge_app_failed`
      // with the audit id, for BOTH verbs. Logging again would double-count and
      // would reintroduce the drift between the two call sites.
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
