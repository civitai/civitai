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
// `20261221120000_app_storage_migration_runs`): the ops, the status, the cursor, and the counts
// scanned / migrated / unchanged / failed / still-invalid, with a sample of failed keys. Until
// that table exists the run still happens, in-process and once, and its outcome is logged
// (`app-storage-migration-run`) instead of recorded — nothing resumes it.
//
// SUPERSEDED: a run stops (status `superseded`) once a NEWER version of the app is approved —
// that version's own plan is computed against this one and is what applies from then on.
//
// FORKS need nothing here: a fork writes its parent's collections in the PARENT's app, under the
// parent's schema, so the parent's run migrates the fork's documents too.

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
};

type RawClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
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
  };
}

/**
 * Record one `pending` run per planned collection. Idempotent (a re-approve of the same request
 * records nothing new). Returns `table_missing` when the hand-applied migration has not run.
 */
export async function recordStorageMigrationRuns(args: {
  publishRequestId: string;
  appBlockId: string;
  plans: ReadonlyMap<string, readonly MigrationMutationOp[]>;
}): Promise<'recorded' | 'table_missing'> {
  try {
    for (const [collection, ops] of args.plans) {
      await raw().$queryRaw`
        INSERT INTO "app_storage_migration_runs"
          ("publish_request_id", "collection", "app_block_id", "ops")
        VALUES (${args.publishRequestId}, ${collection}, ${args.appBlockId},
          ${JSON.stringify(ops)}::jsonb)
        ON CONFLICT ("publish_request_id", "collection") DO NOTHING
        RETURNING 1
      `;
    }
    return 'recorded';
  } catch (err) {
    if (await isRunsTableMissing(err)) return 'table_missing';
    throw err;
  }
}

/** Take a run: pending, or running with a stale heartbeat. Null when someone else holds it. */
async function claim(
  publishRequestId: string,
  collection: string
): Promise<StorageMigrationRun | null> {
  const rows = (await raw().$queryRaw`
    UPDATE "app_storage_migration_runs"
    SET "status" = 'running',
        "started_at" = COALESCE("started_at", CURRENT_TIMESTAMP),
        "heartbeat_at" = CURRENT_TIMESTAMP
    WHERE "publish_request_id" = ${publishRequestId} AND "collection" = ${collection}
      AND ("status" = 'pending'
        OR ("status" = 'running'
          AND "heartbeat_at" < CURRENT_TIMESTAMP - ${STALE_INTERVAL}))
    RETURNING *
  `) as Record<string, unknown>[];
  return rows[0] ? toRun(rows[0]) : null;
}

async function save(run: StorageMigrationRun, done: boolean): Promise<void> {
  await raw().$queryRaw`
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
        "heartbeat_at" = CURRENT_TIMESTAMP,
        "finished_at" = CASE WHEN ${done}::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE "publish_request_id" = ${run.publishRequestId} AND "collection" = ${run.collection}
    RETURNING 1
  `;
}

/** The collection as the approved request declares it, and whether a newer approval superseded it. */
async function loadTarget(
  run: Pick<StorageMigrationRun, 'publishRequestId' | 'collection'>
): Promise<{ collection: DocCollection | null; superseded: boolean }> {
  const request = await dbWrite.appBlockPublishRequest.findUnique({
    where: { id: run.publishRequestId },
    select: { slug: true, manifest: true, status: true },
  });
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
 * `persist`. Returns the run as it was left. Never throws for a document; a store that is
 * disabled or unreachable leaves the run `pending` with the error, for the next attempt.
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
    const target = await load(state);
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
    let result;
    try {
      result = await store.migrateDocuments(
        state.appBlockId,
        target.collection,
        (data) => applyMigrationOps(data, state.ops),
        { after: state.cursor, limit: deps.pageSize ?? STORAGE_MIGRATION_PAGE }
      );
    } catch (err) {
      state.status = 'pending';
      state.lastError = err instanceof Error ? err.message.slice(0, 500) : String(err);
      await deps.persist(state, false);
      if (isDocStoreError(err, 'storage_disabled') || isDocStoreError(err, 'service_unavailable')) {
        return state;
      }
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
      log('error', {
        publishRequestId,
        collection,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The approve hook: record the plan and start it in the background. Never rejects and never
 * blocks the approval on the run itself. Without the runs table the plan still runs, once and
 * in-process, its outcome logged.
 */
export async function startStorageMigrationsOnApprove(args: {
  publishRequestId: string;
  appBlockId: string;
  plans: ReadonlyMap<string, readonly MigrationMutationOp[]>;
}): Promise<void> {
  if (args.plans.size === 0) return;
  let recorded: 'recorded' | 'table_missing';
  try {
    recorded = await recordStorageMigrationRuns(args);
  } catch (err) {
    log('error', {
      publishRequestId: args.publishRequestId,
      message: `could not record the storage migration plan; nothing runs until the next approve: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }
  const collections = [...args.plans.keys()];
  if (recorded === 'recorded') {
    void runStorageMigrationsForRequest(args.publishRequestId, collections);
    return;
  }
  log('error', {
    publishRequestId: args.publishRequestId,
    message:
      'app_storage_migration_runs is missing (apply migration 20261221120000_app_storage_migration_runs): running the storage migration unrecorded, once, with no resume',
  });
  void (async () => {
    for (const [collection, ops] of args.plans) {
      const run: StorageMigrationRun = {
        publishRequestId: args.publishRequestId,
        collection,
        appBlockId: args.appBlockId,
        ops: [...ops],
        status: 'running',
        cursor: null,
        scanned: 0,
        migrated: 0,
        unchanged: 0,
        failed: 0,
        invalid: 0,
        failures: [],
        lastError: null,
      };
      try {
        const left = await advanceStorageMigrationRun(run, {
          persist: async () => undefined,
          maxPages: Number.POSITIVE_INFINITY,
        });
        log('info', { ...summary(left), recorded: false });
      } catch (err) {
        log('error', {
          publishRequestId: args.publishRequestId,
          collection,
          recorded: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
}

/** Runs the job resumes per invocation at most. */
export const STORAGE_MIGRATION_JOB_BATCH = 10;

/**
 * The job's sweep: every pending run, and every running one whose heartbeat went stale, oldest
 * first. Returns the runs it advanced; a missing table reads as nothing to do.
 */
export async function resumeStorageMigrationRuns(
  opts: { limit?: number; checkIfCanceled?: () => void } = {}
): Promise<{ advanced: number; tableMissing: boolean }> {
  let rows: Record<string, unknown>[];
  try {
    rows = (await raw().$queryRaw`
      SELECT "publish_request_id", "collection" FROM "app_storage_migration_runs"
      WHERE "status" = 'pending'
        OR ("status" = 'running'
          AND "heartbeat_at" < CURRENT_TIMESTAMP - ${STALE_INTERVAL})
      ORDER BY "created_at"
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
