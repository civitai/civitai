import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { LabHarnessError, type LabOverrides, type LabRun } from '../text-scan-lab/harness-client';
import { chunkTexts } from '../../text-scan-lab/limits';
import type { LabEntityType, LabField, LabScanResult, LabText } from '../../text-scan-lab/types';
import { verdictOf, type ResultStatus } from '../../text-scan-tests/score';
import {
  ACTIVE_RUN_STATUSES,
  TEST_SET_LIMITS,
  type RunStatus,
  type Workspace,
} from '../../text-scan-tests/types';
import { goneCaseIds, wipeCases } from './sources';
import { noResultIn, runnableCases, wipedCases, type RunRow } from './store';
import { computeTotals } from './totals';

type Db = Kysely<ModeratorDB>;

export type WorkerDeps = {
  db: Db;
  main: Kysely<MainDB>;
  scanTexts: (
    entityType: LabEntityType,
    texts: LabText[],
    overrides?: LabOverrides
  ) => Promise<LabRun>;
  workerId: string;
  log: (event: string, data: Record<string, unknown>, level?: 'info' | 'error') => void;
};

export const PROMPT_MOVED =
  'A prompt was saved while this run was scanning, so its results would mix versions. Start a new run.';
export const UNEXPECTED = 'The run stopped on an unexpected error.';
const PENDING_PAGE = 64;
const LEASE_EXPIRED = sql<boolean>`heartbeat_at < now() - ${TEST_SET_LIMITS.leaseStaleMs} * interval '1 millisecond'`;
const CLAIMABLE = sql<boolean>`(status = 'queued' OR (status IN ('running', 'cancelling') AND ${LEASE_EXPIRED}))`;

export const newWorkerId = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export async function claimRun(deps: WorkerDeps, runId: number): Promise<RunRow | null> {
  const row = await deps.db
    .updateTable('text_scan_test_run')
    .set({
      lease_owner: deps.workerId,
      heartbeat_at: sql`now()`,
      started_at: sql`coalesce(started_at, now())`,
      status: sql`CASE WHEN status = 'cancelling' THEN 'cancelling' ELSE 'running' END`,
    })
    .where('id', '=', String(runId))
    .where(CLAIMABLE)
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}

type PendingCase = {
  id: number;
  entityType: LabEntityType;
  entityId: number | null;
  fields: LabField[];
};

async function pendingCases(db: Db, run: RunRow): Promise<PendingCase[]> {
  const rows = await runnableCases(db, run.set_id)
    .where('c.id', '<=', run.max_case_id)
    .where(noResultIn(run.id))
    .select(['c.id', 'c.entity_type', 'c.entity_id', 'c.fields'])
    .orderBy('c.entity_type')
    .orderBy('c.id')
    .limit(PENDING_PAGE)
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    entityType: r.entity_type as LabEntityType,
    entityId: r.entity_id,
    fields: r.fields as LabField[],
  }));
}

async function wipedWithoutResult(db: Db, run: RunRow): Promise<number[]> {
  const rows = await wipedCases(db, run.set_id)
    .where('c.id', '<=', run.max_case_id)
    .where(noResultIn(run.id))
    .select('c.id')
    .execute();
  return rows.map((r) => Number(r.id));
}

function nextChunk(pending: PendingCase[]): PendingCase[] {
  const group = pending.filter((c) => c.entityType === pending[0].entityType);
  return chunkTexts(group, TEST_SET_LIMITS.chunk)[0];
}

type ResultRow = {
  case_id: string;
  status: ResultStatus;
  output: string | null;
  literal_rule_ids: string | null;
  workflow_id: string | null;
  error: string | null;
  segments: number | null;
};

const blankRow = (caseId: number, status: ResultStatus): ResultRow => ({
  case_id: String(caseId),
  status,
  output: null,
  literal_rule_ids: null,
  workflow_id: null,
  error: null,
  segments: null,
});

const errorRow = (caseId: number, error: string, workflowId: string | null = null): ResultRow => ({
  ...blankRow(caseId, 'error'),
  error: error.slice(0, 2000),
  workflow_id: workflowId,
});

function toResultRow(caseId: number, r: LabScanResult | undefined): ResultRow {
  if (!r) return errorRow(caseId, 'No result returned for this case.');
  if (!r.ok) return errorRow(caseId, r.error, r.workflowId ?? null);
  if (!r.output)
    return errorRow(caseId, `Unreadable reply: ${r.parseError ?? 'no output'}`, r.workflowId);
  return {
    case_id: String(caseId),
    status: 'ok',
    output: JSON.stringify(r.output),
    literal_rule_ids: null,
    workflow_id: r.workflowId,
    error: null,
    segments: verdictOf(r.output).segments,
  };
}

const idsAgree = (recorded: Record<string, number>, reported: Record<string, number>) =>
  Object.entries(reported).every(([key, id]) => recorded[key] === id);

/** Null when this worker no longer holds the lease; the rows are then not written. */
async function writeChunk(
  deps: WorkerDeps,
  runId: number,
  rows: ResultRow[]
): Promise<RunStatus | null> {
  return deps.db.transaction().execute(async (trx) => {
    const lease = await trx
      .updateTable('text_scan_test_run')
      .set({ heartbeat_at: sql`now()` })
      .where('id', '=', String(runId))
      .where('lease_owner', '=', deps.workerId)
      .where('status', 'in', ['running', 'cancelling'])
      .returning('status')
      .executeTakeFirst();
    if (!lease) return null;
    if (rows.length) {
      const present = new Set(
        (
          await trx
            .selectFrom('text_scan_test_case')
            .select('id')
            .where(
              'id',
              'in',
              rows.map((r) => r.case_id)
            )
            .execute()
        ).map((r) => String(r.id))
      );
      const values = rows
        .filter((r) => present.has(r.case_id))
        .map((r) => ({ ...r, run_id: String(runId) }));
      if (values.length)
        await trx
          .insertInto('text_scan_test_result')
          .values(values)
          .onConflict((oc) => oc.columns(['run_id', 'case_id']).doNothing())
          .execute();
    }
    await trx
      .updateTable('text_scan_test_run')
      .set({
        case_done: sql`(SELECT count(*) FROM text_scan_test_result WHERE run_id = ${String(
          runId
        )})`,
        error_count: sql`(SELECT count(*) FROM text_scan_test_result WHERE run_id = ${String(
          runId
        )} AND status = 'error')`,
      })
      .where('id', '=', String(runId))
      .execute();
    return lease.status as RunStatus;
  });
}

/** A reopened baseline that stops short is done again at its old finish, so history keeps it. */
async function endRun(
  deps: WorkerDeps,
  runId: number,
  status: 'done' | 'cancelled' | 'failed',
  failure: string | null = null
): Promise<void> {
  const run = await deps.db
    .selectFrom('text_scan_test_run')
    .select(['kind', 'finished_at'])
    .where('id', '=', String(runId))
    .executeTakeFirstOrThrow();
  const restore = status !== 'done' && run.kind === 'baseline' && run.finished_at !== null;
  const final = restore ? 'done' : status;
  const totals = final === 'failed' ? null : JSON.stringify(await computeTotals(deps.db, runId));
  await deps.db
    .updateTable('text_scan_test_run')
    .set({
      status: final,
      failure: restore ? null : failure,
      totals,
      finished_at: restore ? run.finished_at : sql`now()`,
      lease_owner: null,
      heartbeat_at: null,
    })
    .where('id', '=', String(runId))
    .where('lease_owner', '=', deps.workerId)
    .execute();
}

async function pauseRun(deps: WorkerDeps, runId: number): Promise<void> {
  await deps.db
    .updateTable('text_scan_test_run')
    .set({ lease_owner: null, heartbeat_at: sql`to_timestamp(0)` })
    .where('id', '=', String(runId))
    .where('lease_owner', '=', deps.workerId)
    .execute();
  deps.log('text-scan test run paused', { runId, reason: 'session refused' }, 'info');
}

// claimRun stamps both with one `now()`, so equal means this claim is the run's first start.
const firstStart = (run: RunRow) =>
  run.started_at !== null &&
  run.heartbeat_at !== null &&
  new Date(run.started_at).getTime() === new Date(run.heartbeat_at).getTime();

/** `launch`: started by the moderator who launched it, under their own session. */
async function drive(deps: WorkerDeps, run: RunRow, launch: boolean): Promise<void> {
  const runId = Number(run.id);
  if (run.status === 'cancelling') return endRun(deps, runId, 'cancelled');
  const recorded = run.prompt_ids as Record<string, number>;
  const overrides: LabOverrides = {
    prompts: (run.prompt_overrides as Record<string, string> | null) ?? undefined,
  };
  let launchFirstRequest = launch && firstStart(run);

  const prewiped = await wipedWithoutResult(deps.db, run);
  if (
    prewiped.length &&
    !(await writeChunk(
      deps,
      runId,
      prewiped.map((id) => blankRow(id, 'skipped'))
    ))
  )
    return;

  for (;;) {
    const pending = await pendingCases(deps.db, run);
    if (!pending.length) break;
    const batch = nextChunk(pending);
    const gone = await goneCaseIds(
      deps.main,
      batch.flatMap((c) =>
        c.entityId === null
          ? []
          : [{ caseId: c.id, entityType: c.entityType, entityId: c.entityId }]
      )
    );
    if (gone.size) await wipeCases(deps.db, [...gone]);
    const live = batch.filter((c) => !gone.has(c.id));
    const rows = batch.filter((c) => gone.has(c.id)).map((c) => blankRow(c.id, 'skipped'));

    if (live.length) {
      let results: LabScanResult[];
      try {
        const texts = live.map((c) => ({ key: String(c.id), fields: c.fields }));
        const scanned = await deps.scanTexts(batch[0].entityType, texts, overrides);
        if (scanned.authRefused) return pauseRun(deps, runId);
        results = scanned.results;
      } catch (e) {
        if (!(e instanceof LabHarnessError)) throw e;
        if (launchFirstRequest) return endRun(deps, runId, 'failed', e.message);
        if (e.authRefused) return pauseRun(deps, runId);
        results = live.map((c) => ({ key: String(c.id), ok: false as const, error: e.message }));
      }
      if (results.some((r) => r.ok && !idsAgree(recorded, r.promptIds)))
        return endRun(deps, runId, 'failed', PROMPT_MOVED);
      const byKey = new Map(results.map((r) => [r.key, r] as const));
      rows.push(...live.map((c) => toResultRow(c.id, byKey.get(String(c.id)))));
      launchFirstRequest = false;
    }

    const status = await writeChunk(deps, runId, rows);
    if (status === null) return;
    if (status === 'cancelling') return endRun(deps, runId, 'cancelled');
  }
  await endRun(deps, runId, 'done');
}

// Only the code: a Postgres error message quotes the failing row, which can hold case text.
const errorCode = (e: unknown) =>
  (e as { code?: unknown } | null)?.code ?? (e as Error | null)?.name ?? 'unknown';

export async function runWorker(
  deps: WorkerDeps,
  runId: number,
  opts: { launch?: boolean } = {}
): Promise<void> {
  let run: RunRow | null;
  try {
    run = await claimRun(deps, runId);
  } catch (e) {
    deps.log('text-scan test run claim failed', { runId, error: errorCode(e) });
    return;
  }
  if (!run) return;
  try {
    await drive(deps, run, opts.launch === true);
  } catch (e) {
    deps.log('text-scan test run failed', { runId, error: errorCode(e) });
    await endRun(deps, runId, 'failed', UNEXPECTED).catch(() => undefined);
  }
}

/** `workspaces`: only runs of sets in these; omitted, every set. */
export async function resumableRunIds(
  db: Db,
  workspaces?: readonly Workspace[]
): Promise<number[]> {
  if (workspaces && !workspaces.length) return [];
  let query = db
    .selectFrom('text_scan_test_run as r')
    .select('r.id')
    .where(CLAIMABLE)
    .orderBy('r.id')
    .limit(20);
  if (workspaces)
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('text_scan_test_set as s')
          .select('s.id')
          .whereRef('s.id', '=', 'r.set_id')
          .where('s.workspace', 'in', [...workspaces])
      )
    );
  const rows = await query.execute();
  return rows.map((r) => Number(r.id));
}

/** At boot no lease held under this host name is live: the process that held it has gone. */
export async function releaseOwnLeases(db: Db, host: string): Promise<number> {
  const res = await db
    .updateTable('text_scan_test_run')
    .set({ heartbeat_at: sql`to_timestamp(0)` })
    .where(sql<boolean>`starts_with(lease_owner, ${`${host}:`})`)
    .where('status', 'in', [...ACTIVE_RUN_STATUSES])
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}
