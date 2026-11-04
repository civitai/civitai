// App Storage SCHEMA MIGRATIONS — the run. When a version whose manifest declares migration ops
// is approved, the ops that cover a breaking change of that transition (the PLAN, computed by
// `checkStorageMigrations` in `storage-schema-migrations.ts`) run over the app's existing
// production documents of each collection, in bounded pages, idempotently.
//
// WHEN: approve writes the new manifest onto `app_blocks` before anything else, and the store
// reads its collection schemas from there, so the new schema binds every write from that moment
// (not from when the new build is live). `approveRequest` therefore records the plan once the
// approval is durable and starts the run without waiting for it; the `run-storage-migrations`
// job resumes whatever a run did not finish (a restart, a timeout, the store unreachable).
//
// WHERE THE OUTCOME IS RECORDED: one row per (publish request, collection) in
// `app_storage_migration_runs` (main database, raw SQL only; MANUAL-APPLY migration
// `20261221120000_app_storage_migration_runs`): the ops, the status, the cursor, the counts
// scanned / migrated / unchanged / failed / still-invalid with a sample of failed keys, and the
// consecutive failed attempts (a deterministic page failure, or a runner that died mid-page;
// transient store errors do not count). A run whose attempts reach
// {@link STORAGE_MIGRATION_MAX_ATTEMPTS} is `failed` and no longer picked.
//
// FAIL-CLOSED AT APPROVE ({@link reserveStorageMigrationRuns}, on every approve of an existing app,
// under a per-app lock): refused while an earlier run of the same app is still pending or running —
// so a run is never left half-done by the next approval — and, for a version with a plan, while the
// runs table is missing. The plan is reserved in the same locked transaction. (A run is still
// marked `superseded` if a newer approval is somehow found, defensively.)
//
// FORKS need nothing here: a fork writes its parent's collections in the PARENT's app, under the
// parent's schema, so the parent's run migrates the fork's documents too.

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreMaintenance, MigrationCursor } from '~/server/services/apps/doc-store';
import { getDocStoreMaintenance } from '~/server/services/apps/doc-store-maintenance.instance';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import type { MigrationMutationOp } from '~/server/services/apps/storage-schema-migrations';
import { applyMigrationOps } from '~/server/services/apps/storage-schema-migrations';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ENABLED_FEATURES,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';

/** Documents per page (one `migrateDocuments` call). */
export const STORAGE_MIGRATION_PAGE = 100;
/** Pages one invocation runs at most before it hands the rest to the next job run. */
export const STORAGE_MIGRATION_MAX_PAGES = 50;
/** A `running` row whose heartbeat is older than this is taken to be abandoned and re-claimed. */
export const STORAGE_MIGRATION_STALE_MINUTES = 15;
/**
 * The staleness bound as SQL, inlined (`Prisma.raw`): `make_interval` has only int4 overloads and
 * Prisma binds a number as int8, so a bound `${n}` fails every call.
 */
const STALE_INTERVAL = Prisma.raw(`make_interval(mins => ${STORAGE_MIGRATION_STALE_MINUTES})`);
/** Consecutive failed attempts after which a run is `failed` and the job stops picking it. */
export const STORAGE_MIGRATION_MAX_ATTEMPTS = 5;
/** Approved manifests read for a re-declared collection's baseline (newest first). */
export const STORAGE_MIGRATION_HISTORY = 50;
/** Store error codes that are transient or the platform's own state: never counted as an attempt. */
const TRANSIENT_STORE_CODES = ['storage_disabled', 'service_unavailable', 'rate_limited'] as const;
/** Failed documents kept on the row, across pages. */
const FAILURE_SAMPLES_KEPT = 20;

export const STORAGE_MIGRATION_STATUSES = [
  'pending',
  'running',
  'completed',
  'completed_with_failures',
  'failed',
  'superseded',
] as const;
export type StorageMigrationStatus = (typeof STORAGE_MIGRATION_STATUSES)[number];

export type StorageMigrationRun = {
  publishRequestId: string;
  collection: string;
  appBlockId: string;
  ops: MigrationMutationOp[];
  status: StorageMigrationStatus;
  cursor: MigrationCursor | null;
  scanned: number;
  migrated: number;
  unchanged: number;
  failed: number;
  invalid: number;
  failures: { scopeUid: number; key: string; code: string }[];
  lastError: string | null;
  /** Consecutive attempts that ended in an error (reset by a page that completes). */
  attempts: number;
  /** The token of the claim this runner holds; a save under another token is refused. */
  claimToken: string | null;
};

/** A save by a runner whose claim was taken over (its heartbeat went stale). */
export class StorageMigrationClaimLost extends Error {
  constructor(run: Pick<StorageMigrationRun, 'publishRequestId' | 'collection'>) {
    super(
      `storage migration run ${run.publishRequestId}/${run.collection} was re-claimed by another runner`
    );
    this.name = 'StorageMigrationClaimLost';
  }
}

type RawClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};
const raw = () => dbWrite as unknown as RawClient;

const ALL_FEATURES = Object.fromEntries(
  Object.keys(APP_STORAGE_ENABLED_FEATURES).map((f) => [f, true])
) as Record<AppStorageFeature, boolean>;

/** The hand-applied runs table is absent. `app-access.service` is loaded lazily, as elsewhere. */
async function isRunsTableMissing(err: unknown): Promise<boolean> {
  const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
  return isMissingTableError(err);
}

function log(type: 'info' | 'error', fields: Record<string, unknown>): void {
  logToAxiom({ name: 'app-storage-migration-run', type, ...fields }, 'app-blocks').catch(
    () => undefined
  );
}

function toRun(r: Record<string, unknown>): StorageMigrationRun {
  return {
    publishRequestId: r.publish_request_id as string,
    collection: r.collection as string,
    appBlockId: r.app_block_id as string,
    ops: r.ops as MigrationMutationOp[],
    status: r.status as StorageMigrationStatus,
    cursor: (r.cursor as MigrationCursor | null) ?? null,
    scanned: Number(r.scanned),
    migrated: Number(r.migrated),
    unchanged: Number(r.unchanged),
    failed: Number(r.failed),
    invalid: Number(r.invalid),
    failures: (r.failures as StorageMigrationRun['failures']) ?? [],
    lastError: (r.last_error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    claimToken: (r.claim_token as string | null) ?? null,
  };
}

/**
 * Record one `pending` run per planned collection, in ONE statement: all of them or none.
 * Idempotent (a re-approve of the same request records nothing new). Returns `table_missing`
 * when the hand-applied migration has not run.
 */
export async function recordStorageMigrationRuns(args: {
  publishRequestId: string;
  appBlockId: string;
  plans: ReadonlyMap<string, readonly MigrationMutationOp[]>;
}): Promise<'recorded' | 'table_missing'> {
  const collections = [...args.plans.keys()];
  const ops = collections.map((c) => JSON.stringify(args.plans.get(c)));
  try {
    await raw().$queryRaw`
      INSERT INTO "app_storage_migration_runs"
        ("publish_request_id", "collection", "app_block_id", "ops")
      SELECT ${args.publishRequestId}, p.collection, ${args.appBlockId}, p.ops::jsonb
      FROM unnest(${collections}::text[], ${ops}::text[]) AS p(collection, ops)
      ON CONFLICT ("publish_request_id", "collection") DO NOTHING
      RETURNING 1
    `;
    return 'recorded';
  } catch (err) {
    if (await isRunsTableMissing(err)) return 'table_missing';
    throw err;
  }
}

/** The advisory-lock class of the per-app approve gate ({@link reserveStorageMigrationRuns}). */
const RESERVE_LOCK_CLASS = 0x41534d01;

const TABLE_MISSING_REFUSAL =
  'Cannot approve: this version migrates stored App Storage documents, but the app_storage_migration_runs table does not exist yet. Apply migration 20261221120000_app_storage_migration_runs first, then approve again.';

/**
 * THE approve gate, run on EVERY approve of an existing app, before anything is written. Under a
 * per-app advisory lock (so two concurrent approves of one app are serialised), it refuses — with a
 * message for the moderator — while a run of this app belonging to ANOTHER publish request is still
 * pending or running (approving now would leave it half-done), and otherwise RESERVES this
 * request's plan: its run rows are inserted `pending` in the same transaction, so a concurrent
 * approve sees them and is refused. A reserved run whose request is not approved yet is left alone
 * by the runner (`loadTarget`), and one whose request ends rejected or withdrawn is closed.
 *
 * Without the runs table: a version with a plan is refused (nothing could record or resume it); a
 * version without one passes (no run can be open).
 */
export async function reserveStorageMigrationRuns(args: {
  appBlockId: string;
  publishRequestId: string;
  plans: ReadonlyMap<string, readonly MigrationMutationOp[]>;
}): Promise<void> {
  const collections = [...args.plans.keys()];
  const ops = collections.map((c) => JSON.stringify(args.plans.get(c)));
  let open: Record<string, unknown> | undefined;
  try {
    open = await dbWrite.$transaction(async (tx) => {
      const t = tx as unknown as RawClient;
      await t.$executeRaw`SELECT pg_advisory_xact_lock(${RESERVE_LOCK_CLASS}::int, hashtext(${args.appBlockId}))`;
      const rows = (await t.$queryRaw`
        SELECT "publish_request_id", "collection", "status" FROM "app_storage_migration_runs"
        WHERE "app_block_id" = ${args.appBlockId}
          AND "publish_request_id" <> ${args.publishRequestId}
          AND "status" IN ('pending', 'running')
        ORDER BY "created_at" LIMIT 1
      `) as Record<string, unknown>[];
      if (rows[0]) return rows[0];
      if (collections.length > 0) {
        await t.$queryRaw`
          INSERT INTO "app_storage_migration_runs"
            ("publish_request_id", "collection", "app_block_id", "ops")
          SELECT ${args.publishRequestId}, p.collection, ${args.appBlockId}, p.ops::jsonb
          FROM unnest(${collections}::text[], ${ops}::text[]) AS p(collection, ops)
          ON CONFLICT ("publish_request_id", "collection") DO NOTHING
          RETURNING 1
        `;
      }
      return undefined;
    });
  } catch (err) {
    if (await isRunsTableMissing(err)) {
      if (collections.length > 0) throw new Error(TABLE_MISSING_REFUSAL);
      return;
    }
    throw err;
  }
  if (open) {
    throw new Error(
      `Cannot approve: an earlier storage migration of this app is still ${String(
        open.status
      )} (publish request ${String(open.publish_request_id)}, collection ${String(
        open.collection
      )}), and approving a newer version now would leave it half-done. Approve again once it has finished.`
    );
  }
}

/**
 * The storage-migration BASELINE for a submission: what the store enforces today
 * (`app_blocks.manifest`, read on the primary) and the app's earlier approved manifests, newest
 * first (for a re-declared collection). The newest approved request is expected to equal the
 * enforced manifest; when its storage differs, the enforced one wins and the divergence is logged.
 */
export async function loadStorageMigrationBaseline(args: {
  slug: string;
  excludePublishRequestId?: string;
  /**
   * At approve: the request's own manifest. If `app_blocks.manifest` already carries this storage,
   * an earlier attempt of THIS approve wrote it (step 3) and then failed, so the store's schema is
   * not the documents' schema: the baseline is the latest approved request instead.
   */
  selfManifest?: unknown;
}): Promise<{ prev: unknown | null; history: unknown[] }> {
  const block = await dbWrite.appBlock.findFirst({
    where: { blockId: args.slug },
    select: { id: true, manifest: true },
  });
  if (!block) return { prev: null, history: [] };
  const approved =
    (await dbWrite.appBlockPublishRequest.findMany({
      where: {
        slug: args.slug,
        status: 'approved',
        ...(args.excludePublishRequestId ? { NOT: { id: args.excludePublishRequestId } } : {}),
      },
      orderBy: { reviewedAt: 'desc' },
      take: STORAGE_MIGRATION_HISTORY,
      select: { id: true, manifest: true },
    })) ?? [];
  const storageOf = (m: unknown) =>
    JSON.stringify((m as { storage?: unknown } | null)?.storage ?? null);
  const latest = approved[0];
  if (
    args.selfManifest !== undefined &&
    block.manifest &&
    storageOf(block.manifest) === storageOf(args.selfManifest) &&
    storageOf(latest?.manifest) !== storageOf(args.selfManifest)
  ) {
    return { prev: latest?.manifest ?? null, history: approved.map((r) => r.manifest) };
  }
  if (block.manifest && latest && storageOf(latest.manifest) !== storageOf(block.manifest)) {
    log('error', {
      slug: args.slug,
      appBlockId: block.id,
      publishRequestId: latest.id,
      message:
        'the storage declared by app_blocks.manifest differs from the latest approved publish request; the schema migration check uses app_blocks.manifest (what the store enforces)',
    });
  }
  return {
    prev: block.manifest ?? latest?.manifest ?? null,
    history: approved.map((r) => r.manifest),
  };
}

/**
 * Take a run: pending, or running with a stale heartbeat, and under the attempt cap. The claim
 * token it writes is what every later save must match. Null when someone else holds it.
 */
async function claim(
  publishRequestId: string,
  collection: string
): Promise<StorageMigrationRun | null> {
  const token = randomUUID();
  const rows = (await raw().$queryRaw`
    UPDATE "app_storage_migration_runs"
    SET "status" = 'running',
        "claim_token" = ${token},
        -- Re-claiming a run whose heartbeat went stale means its runner died mid-page (a crashed
        -- process never reaches the catch below): that counts as a failed attempt.
        "attempts" = CASE WHEN "status" = 'running' THEN "attempts" + 1 ELSE "attempts" END,
        "started_at" = COALESCE("started_at", CURRENT_TIMESTAMP),
        "heartbeat_at" = CURRENT_TIMESTAMP
    WHERE "publish_request_id" = ${publishRequestId} AND "collection" = ${collection}
      AND "attempts" < ${STORAGE_MIGRATION_MAX_ATTEMPTS}::int
      AND ("status" = 'pending'
        OR ("status" = 'running'
          AND "heartbeat_at" < CURRENT_TIMESTAMP - ${STALE_INTERVAL}))
    RETURNING *
  `) as Record<string, unknown>[];
  return rows[0] ? toRun(rows[0]) : null;
}

/** Persist the run, only while this runner still holds the claim (else {@link StorageMigrationClaimLost}). */
async function save(run: StorageMigrationRun, done: boolean): Promise<void> {
  const rows = (await raw().$queryRaw`
    UPDATE "app_storage_migration_runs"
    SET "status" = ${run.status},
        "cursor" = ${run.cursor === null ? null : JSON.stringify(run.cursor)}::jsonb,
        "scanned" = ${run.scanned}::int,
        "migrated" = ${run.migrated}::int,
        "unchanged" = ${run.unchanged}::int,
        "failed" = ${run.failed}::int,
        "invalid" = ${run.invalid}::int,
        "failures" = ${JSON.stringify(run.failures)}::jsonb,
        "last_error" = ${run.lastError},
        "attempts" = ${run.attempts}::int,
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "finished_at" = CASE WHEN ${done}::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE "publish_request_id" = ${run.publishRequestId} AND "collection" = ${run.collection}
      AND "claim_token" = ${run.claimToken}
    RETURNING 1
  `) as unknown[];
  if (rows.length === 0) throw new StorageMigrationClaimLost(run);
}

/**
 * The collection as the approved request declares it; whether a newer approval superseded it; and
 * `wait` while the request is still pending (reserved at approve, approval not written yet — or an
 * approve that failed and will be retried).
 */
async function loadTarget(
  run: Pick<StorageMigrationRun, 'publishRequestId' | 'collection'>
): Promise<{ collection: DocCollection | null; superseded: boolean; wait?: boolean }> {
  const request = await dbWrite.appBlockPublishRequest.findUnique({
    where: { id: run.publishRequestId },
    select: { slug: true, manifest: true, status: true },
  });
  if (request?.status === 'pending') return { collection: null, superseded: false, wait: true };
  if (!request || request.status !== 'approved') return { collection: null, superseded: true };
  const latest = await dbWrite.appBlockPublishRequest.findFirst({
    where: { slug: request.slug, status: 'approved' },
    orderBy: { reviewedAt: 'desc' },
    select: { id: true },
  });
  if (latest && latest.id !== run.publishRequestId) return { collection: null, superseded: true };
  const config = parseManifestStorage(request.manifest, ALL_FEATURES).collections.get(
    run.collection
  );
  return { collection: config ? { name: run.collection, config } : null, superseded: false };
}

/**
 * Run (or continue) one run for at most `maxPages` pages, persisting after each page through
 * `persist`. Returns the run as it was left. Never throws for a document. A page that throws
 * counts one failed attempt and leaves the run `pending` for the next job run — or `failed`, with
 * the error, once {@link STORAGE_MIGRATION_MAX_ATTEMPTS} consecutive attempts have failed.
 */
export async function advanceStorageMigrationRun(
  run: StorageMigrationRun,
  deps: {
    store?: DocStoreMaintenance;
    persist: (run: StorageMigrationRun, done: boolean) => Promise<void>;
    load?: typeof loadTarget;
    maxPages?: number;
    pageSize?: number;
  }
): Promise<StorageMigrationRun> {
  const store = deps.store ?? getDocStoreMaintenance();
  const load = deps.load ?? loadTarget;
  const maxPages = deps.maxPages ?? STORAGE_MIGRATION_MAX_PAGES;
  const state: StorageMigrationRun = { ...run, status: 'running' };
  for (let page = 0; page < maxPages; page++) {
    let target: Awaited<ReturnType<typeof loadTarget>>;
    try {
      target = await load(state);
    } catch (err) {
      // Our own database could not be read: transient, not this run's fault.
      state.status = 'pending';
      state.lastError = err instanceof Error ? err.message.slice(0, 500) : String(err);
      await deps.persist(state, false);
      return state;
    }
    if (target.wait) {
      state.status = 'pending';
      await deps.persist(state, false);
      return state;
    }
    if (target.superseded) {
      state.status = 'superseded';
      await deps.persist(state, true);
      return state;
    }
    if (!target.collection) {
      state.status = 'failed';
      state.lastError = `the approved manifest does not declare collection ${state.collection}`;
      await deps.persist(state, true);
      return state;
    }
    const collection = target.collection;
    let result;
    try {
      result = await store.migrateDocuments(
        state.appBlockId,
        target.collection,
        (data) => applyMigrationOps(data, state.ops, collection.config.schema),
        { after: state.cursor, limit: deps.pageSize ?? STORAGE_MIGRATION_PAGE }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
      // Transient, or ours (the store switched off, unreachable, lock contention): not this run's
      // fault, so not an attempt. The run stays pending and is retried.
      if (TRANSIENT_STORE_CODES.some((code) => isDocStoreError(err, code))) {
        state.status = 'pending';
        state.lastError = message;
        await deps.persist(state, false);
        return state;
      }
      state.attempts += 1;
      const exhausted = state.attempts >= STORAGE_MIGRATION_MAX_ATTEMPTS;
      state.status = exhausted ? 'failed' : 'pending';
      state.lastError = exhausted
        ? `gave up after ${state.attempts} failed attempts: ${message}`
        : message;
      await deps.persist(state, exhausted);
      if (exhausted) return state;
      throw err;
    }
    state.scanned += result.scanned;
    state.migrated += result.migrated;
    state.unchanged += result.unchanged;
    state.failed += result.failed;
    state.invalid += result.invalid;
    state.failures = [...state.failures, ...result.failures].slice(0, FAILURE_SAMPLES_KEPT);
    state.cursor = result.next;
    state.lastError = null;
    state.attempts = 0;
    if (result.next === null) {
      state.status = state.failed > 0 ? 'completed_with_failures' : 'completed';
      await deps.persist(state, true);
      return state;
    }
    await deps.persist(state, false);
  }
  // Out of budget: hand the rest to the next job run.
  state.status = 'pending';
  await deps.persist(state, false);
  return state;
}

function summary(run: StorageMigrationRun) {
  return {
    publishRequestId: run.publishRequestId,
    collection: run.collection,
    appBlockId: run.appBlockId,
    status: run.status,
    scanned: run.scanned,
    migrated: run.migrated,
    unchanged: run.unchanged,
    failed: run.failed,
    invalid: run.invalid,
    failures: run.failures,
    lastError: run.lastError,
    attempts: run.attempts,
  };
}

/** Claim and advance every claimable run of one request. Never rejects. */
export async function runStorageMigrationsForRequest(
  publishRequestId: string,
  collections: readonly string[]
): Promise<void> {
  for (const collection of collections) {
    try {
      const run = await claim(publishRequestId, collection);
      if (!run) continue;
      const left = await advanceStorageMigrationRun(run, { persist: save });
      log('info', summary(left));
    } catch (err) {
      // A lost claim is another runner's run now: nothing to report as an error.
      log(err instanceof StorageMigrationClaimLost ? 'info' : 'error', {
        publishRequestId,
        collection,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The approve hook: record the plan and start it in the background. Never rejects and never
 * blocks the approval on the run itself. {@link reserveStorageMigrationRuns} already inserted the
 * rows before the approval was written, so this insert is a backstop (`ON CONFLICT DO NOTHING`);
 * should it fail, the reserved rows are still picked up by the job.
 */
export async function startStorageMigrationsOnApprove(args: {
  publishRequestId: string;
  appBlockId: string;
  plans: ReadonlyMap<string, readonly MigrationMutationOp[]>;
}): Promise<void> {
  if (args.plans.size === 0) return;
  try {
    await recordStorageMigrationRuns(args);
  } catch (err) {
    log('error', {
      publishRequestId: args.publishRequestId,
      message: `could not re-record the storage migration plan (the rows reserved before the approval are still run by the job): ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  void runStorageMigrationsForRequest(args.publishRequestId, [...args.plans.keys()]);
}

/** Runs the job resumes per invocation at most. */
export const STORAGE_MIGRATION_JOB_BATCH = 10;

/**
 * The job's sweep: every pending run, and every running one whose heartbeat went stale, under the
 * attempt cap. Least recently touched first (`heartbeat_at`, never-started first), so a run that
 * keeps failing rotates behind newer runs instead of holding the batch. Returns the runs it
 * advanced; a missing table reads as nothing to do.
 */
export async function resumeStorageMigrationRuns(
  opts: { limit?: number; checkIfCanceled?: () => void } = {}
): Promise<{ advanced: number; tableMissing: boolean }> {
  let rows: Record<string, unknown>[];
  try {
    // A run re-claimed STORAGE_MIGRATION_MAX_ATTEMPTS times whose runner died again is never
    // claimable (attempts at the cap) and would stay "running" — and block approves — forever.
    await raw().$queryRaw`
      UPDATE "app_storage_migration_runs"
      SET "status" = 'failed', "finished_at" = CURRENT_TIMESTAMP,
          "last_error" = 'gave up: the run stopped without finishing too many times (its process was lost each time)'
      WHERE "status" = 'running' AND "attempts" >= ${STORAGE_MIGRATION_MAX_ATTEMPTS}::int
        AND "heartbeat_at" < CURRENT_TIMESTAMP - ${STALE_INTERVAL}
      RETURNING 1
    `;
    rows = (await raw().$queryRaw`
      SELECT "publish_request_id", "collection" FROM "app_storage_migration_runs"
      WHERE "attempts" < ${STORAGE_MIGRATION_MAX_ATTEMPTS}::int
        AND ("status" = 'pending'
          OR ("status" = 'running'
            AND "heartbeat_at" < CURRENT_TIMESTAMP - ${STALE_INTERVAL}))
      ORDER BY "heartbeat_at" NULLS FIRST, "created_at"
      LIMIT ${opts.limit ?? STORAGE_MIGRATION_JOB_BATCH}::int
    `) as Record<string, unknown>[];
  } catch (err) {
    if (await isRunsTableMissing(err)) return { advanced: 0, tableMissing: true };
    throw err;
  }
  let advanced = 0;
  for (const r of rows) {
    opts.checkIfCanceled?.();
    await runStorageMigrationsForRequest(r.publish_request_id as string, [r.collection as string]);
    advanced += 1;
  }
  return { advanced, tableMissing: false };
}
