import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { LabHarnessError, type LabPrompts, type LabQuote } from '../text-scan-lab/harness-client';
import type {
  LabEntityType,
  LabField,
  LabLabel,
  LabText,
  PromptChanges,
} from '../../text-scan-lab/types';
import {
  baselineState,
  labelsOf,
  promptIdsFor,
  promptKeyOf,
  type LiveState,
} from '../../text-scan-tests/baseline';
import {
  ACTIVE_RUN_STATUSES,
  CANCELLABLE_RUN_STATUSES,
  TEST_SET_LIMITS,
  type TestSet,
  type Workspace,
} from '../../text-scan-tests/types';
import {
  TestSetError,
  getRun,
  noResultIn,
  requireOpenSet,
  runnableCases,
  type RunRow,
} from './store';

type Db = Kysely<ModeratorDB>;

/** What a run start or cancel leaves in the audit trail: ids and counts only, never text. */
export type RunAuditEvent = {
  action: 'start' | 'cancel';
  userId: number;
  setId: number;
  runIds: number[];
  calls?: number;
  buzz?: number;
};
export type RunAudit = (event: RunAuditEvent) => void | Promise<void>;

export type RunsDeps = {
  db: Db;
  getPrompts: () => Promise<LabPrompts>;
  quoteTexts: (
    entityType: LabEntityType,
    texts: LabText[],
    prompts?: Record<string, string>
  ) => Promise<LabQuote>;
  launch: (runId: number) => void;
  audit: RunAudit;
};

export type DraftInput = { prompts: PromptChanges };

export type Quote = {
  cases: number;
  calls: number;
  perCallBuzz: number;
  measured: boolean;
  buzz: number;
  minutes: number;
  baseline: 'reuse' | 'top-up' | 'new';
  draft: boolean;
  stamp: string;
};

export type Started = { startId: string; runIds: number[]; runId: number };

const CHUNK_SECONDS = 20;

/** A done baseline re-queued by a top-up or re-run keeps its finished_at until it finishes again. */
const REOPENED = sql<boolean>`kind = 'baseline' AND finished_at IS NOT NULL`;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sortedKeys = <T>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** The audit row records a write that already succeeded; a failure to write it never undoes that. */
async function record(audit: RunAudit, event: RunAuditEvent) {
  try {
    await audit(event);
  } catch (e) {
    console.error('[text-scan-tests] failed to audit a run', { action: event.action, error: e });
  }
}

export async function setLabels(db: Db, setId: number): Promise<LabLabel[]> {
  const rows = await runnableCases(db, setId).select('c.entity_type').distinct().execute();
  return labelsOf(rows.map((r) => r.entity_type as LabEntityType));
}

export async function liveStateFor(
  deps: Pick<RunsDeps, 'getPrompts'>,
  labels: readonly LabLabel[]
): Promise<{ live: LiveState; prompts: LabPrompts }> {
  let prompts: LabPrompts;
  try {
    prompts = await deps.getPrompts();
  } catch (e) {
    if (e instanceof LabHarnessError) throw new TestSetError(e.message, 502);
    throw e;
  }
  const promptIds = promptIdsFor(labels, prompts.active);
  if (typeof promptIds === 'string')
    throw new TestSetError(
      `The ${promptIds} prompt has no saved version, so nothing can run.`,
      409
    );
  return {
    prompts,
    live: { promptIds, model: prompts.config.model, thinking: prompts.config.thinking },
  };
}

export async function latestBaseline(db: Db, setId: number): Promise<RunRow | null> {
  const row = await db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('set_id', '=', String(setId))
    .where('kind', '=', 'baseline')
    .where('status', 'in', ['done', 'queued', 'running'])
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

export const asLive = (run: RunRow): LiveState => ({
  promptIds: run.prompt_ids as Record<string, number>,
  model: run.model,
  thinking: run.thinking,
});

function effectiveDraft(draft: DraftInput | null, labels: readonly LabLabel[]): DraftInput | null {
  if (!draft) return null;
  const used = new Set(['base', ...labels.map((label) => `label:${label}`)]);
  const prompts = Object.fromEntries(
    Object.entries(draft.prompts).filter(([key]) => used.has(key))
  ) as PromptChanges;
  return Object.keys(prompts).length ? { prompts } : null;
}

type Plan = {
  set: TestSet;
  runnable: number;
  maxCaseId: number;
  sample: { entityType: LabEntityType; texts: LabText[] };
  live: LiveState;
  draft: (DraftInput & { promptIds: Record<string, number> }) | null;
  baselineId: number | null;
  mode: Quote['baseline'];
  missing: number;
  calls: number;
  stamp: string;
};

async function planRun(
  deps: RunsDeps,
  setId: number,
  workspace: Workspace,
  draftInput: DraftInput | null
): Promise<Plan> {
  const set = await requireOpenSet(deps.db, setId, workspace);
  const [counted, last] = await Promise.all([
    runnableCases(deps.db, setId)
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow(),
    deps.db
      .selectFrom('text_scan_test_case')
      .select(sql<string | null>`max(id)`.as('max_id'))
      .where('set_id', '=', String(setId))
      .executeTakeFirstOrThrow(),
  ]);
  const runnable = Number(counted.n);
  if (!runnable) throw new TestSetError('This set has no case with text to scan.', 400);
  if (runnable > TEST_SET_LIMITS.casesPerRun)
    throw new TestSetError(
      `${runnable} cases is more than the ${TEST_SET_LIMITS.casesPerRun} one run can scan. Split the set.`,
      400
    );
  const maxCaseId = Number(last.max_id);

  const labels = await setLabels(deps.db, setId);
  const { live, prompts } = await liveStateFor(deps, labels);
  const draft = effectiveDraft(draftInput, labels);
  const draftIds = draft && promptIdsFor(labels, prompts.active, Object.keys(draft.prompts));

  const latest = await latestBaseline(deps.db, setId);
  const state = baselineState(latest && { ...asLive(latest), status: latest.status }, live);
  let missing = 0;
  if (latest && state === 'fresh') {
    const row = await runnableCases(deps.db, setId)
      .select(sql<string>`count(*)`.as('n'))
      .where(noResultIn(latest.id))
      .executeTakeFirstOrThrow();
    missing = Number(row.n);
  }
  const mode: Quote['baseline'] =
    state === 'running' || (state === 'fresh' && !missing)
      ? 'reuse'
      : state === 'fresh'
      ? 'top-up'
      : 'new';
  if (!draft && mode === 'reuse')
    throw new TestSetError(
      state === 'running'
        ? 'A baseline run of the live prompts is already in progress.'
        : 'The baseline already covers every case at the live versions. Edit a prompt to run a draft.',
      409
    );

  const calls =
    (draft ? runnable : 0) + (mode === 'new' ? runnable : mode === 'top-up' ? missing : 0);
  const sampleRows = await runnableCases(deps.db, setId)
    .select(['c.entity_type', 'c.fields'])
    .orderBy('c.entity_type')
    .orderBy('c.id')
    .limit(TEST_SET_LIMITS.quoteSample)
    .execute();
  const sampleType = sampleRows[0].entity_type as LabEntityType;
  const sample = {
    entityType: sampleType,
    texts: sampleRows
      .filter((r) => r.entity_type === sampleType)
      .map((r, i) => ({ key: `q${i}`, fields: r.fields as LabField[] })),
  };

  const stamp = sha256(
    JSON.stringify([
      set.id,
      runnable,
      maxCaseId,
      mode,
      missing,
      draft && { prompts: sortedKeys(draft.prompts) },
      sortedKeys(live.promptIds),
      live.model,
      live.thinking,
    ])
  );
  return {
    set,
    runnable,
    maxCaseId,
    sample,
    live,
    draft:
      draft && typeof draftIds === 'object' && draftIds ? { ...draft, promptIds: draftIds } : null,
    baselineId: latest && mode !== 'new' ? Number(latest.id) : null,
    mode,
    missing,
    calls,
    stamp,
  };
}

/** Fallback price when no quote is available. */
async function priceOf(deps: RunsDeps, plan: Plan) {
  try {
    const quote = await deps.quoteTexts(
      plan.sample.entityType,
      plan.sample.texts,
      plan.draft?.prompts as Record<string, string> | undefined
    );
    if (typeof quote.maxCostTotal === 'number')
      return { perCallBuzz: quote.maxCostTotal, measured: true };
  } catch (e) {
    if (!(e instanceof LabHarnessError)) throw e;
  }
  return { perCallBuzz: 1, measured: false };
}

export async function quoteRun(
  deps: RunsDeps,
  setId: number,
  workspace: Workspace,
  draft: DraftInput | null
): Promise<Quote> {
  const plan = await planRun(deps, setId, workspace, draft);
  const { perCallBuzz, measured } = await priceOf(deps, plan);
  const longestSide = Math.max(
    plan.draft ? plan.runnable : 0,
    plan.mode === 'new' ? plan.runnable : plan.mode === 'top-up' ? plan.missing : 0
  );
  return {
    cases: plan.runnable,
    calls: plan.calls,
    perCallBuzz,
    measured,
    buzz: Math.ceil(plan.calls * perCallBuzz),
    minutes: Math.max(
      1,
      Math.ceil((Math.ceil(longestSide / TEST_SET_LIMITS.chunk) * CHUNK_SECONDS) / 60)
    ),
    baseline: plan.mode,
    draft: !!plan.draft,
    stamp: plan.stamp,
  };
}

/** Serialised by an advisory lock, so two starts cannot both pass the counts. */
async function guardStarts(trx: Db, userId: number) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('text_scan_test_run_start'))`.execute(trx);
  const active = await trx
    .selectFrom('text_scan_test_run')
    .select(['start_id', 'run_by'])
    .where('status', 'in', [...ACTIVE_RUN_STATUSES])
    .execute();
  if (active.some((r) => r.run_by === userId))
    throw new TestSetError(
      'You already have a run in progress. Wait for it to finish or cancel it.',
      409
    );
  if (new Set(active.map((r) => r.start_id)).size >= TEST_SET_LIMITS.activeStarts)
    throw new TestSetError(
      `${TEST_SET_LIMITS.activeStarts} runs are already in progress. Try again when one finishes.`,
      409
    );
}

export async function startRun(
  deps: RunsDeps,
  input: {
    setId: number;
    workspace: Workspace;
    draft: DraftInput | null;
    stamp: string;
  },
  userId: number
): Promise<Started> {
  const plan = await planRun(deps, input.setId, input.workspace, input.draft);
  if (plan.stamp !== input.stamp)
    throw new TestSetError(
      'The set, your draft or the live prompts changed since the estimate. Check the new estimate and confirm again.',
      409
    );
  // Before the transaction: a pricing failure must leave no queued run for a resume to claim.
  const { perCallBuzz } = await priceOf(deps, plan);
  const startId = randomUUID();
  const runIds = await deps.db.transaction().execute(async (trx) => {
    await guardStarts(trx, userId);
    const common = {
      set_id: String(plan.set.id),
      start_id: startId,
      max_case_id: String(plan.maxCaseId),
      model: plan.live.model,
      thinking: plan.live.thinking,
      case_total: plan.runnable,
      run_by: userId,
    };
    const ids: number[] = [];
    let baselineId = plan.baselineId;
    if (plan.mode === 'new') {
      const row = await trx
        .insertInto('text_scan_test_run')
        .values({ ...common, kind: 'baseline', prompt_ids: JSON.stringify(plan.live.promptIds) })
        .returning('id')
        .executeTakeFirstOrThrow();
      baselineId = Number(row.id);
      ids.push(baselineId);
    } else if (plan.mode === 'top-up') {
      const res = await trx
        .updateTable('text_scan_test_run')
        .set({
          status: 'queued',
          start_id: startId,
          max_case_id: common.max_case_id,
          case_total: plan.runnable,
          run_by: userId,
          // Cleared so the worker reads the next claim as a first start: a refused launch then fails.
          started_at: null,
          lease_owner: null,
          heartbeat_at: null,
        })
        .where('id', '=', String(baselineId))
        .where('status', '=', 'done')
        .executeTakeFirst();
      if (!res.numUpdatedRows)
        throw new TestSetError('The baseline changed while you were confirming. Try again.', 409);
      ids.push(baselineId!);
    }
    if (plan.draft) {
      const row = await trx
        .insertInto('text_scan_test_run')
        .values({
          ...common,
          kind: 'draft',
          baseline_run_id: baselineId === null ? null : String(baselineId),
          prompt_ids: JSON.stringify(plan.draft.promptIds),
          prompt_overrides: JSON.stringify(plan.draft.prompts),
          expires_at: sql`now() + ${TEST_SET_LIMITS.draftRetentionDays} * interval '1 day'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.push(Number(row.id));
    }
    return ids;
  });
  await record(deps.audit, {
    action: 'start',
    userId,
    setId: plan.set.id,
    runIds,
    calls: plan.calls,
    buzz: Math.ceil(plan.calls * perCallBuzz),
  });
  for (const id of runIds) deps.launch(id);
  return { startId, runIds, runId: runIds[runIds.length - 1] };
}

export async function cancelRun(
  deps: Pick<RunsDeps, 'db' | 'audit'>,
  setId: number,
  runId: number,
  userId: number,
  canCancelAny: boolean
): Promise<number> {
  const { db } = deps;
  const run = await getRun(db, setId, runId);
  if (run.run_by !== userId && !canCancelAny)
    throw new TestSetError(
      'Only the moderator who started this run, or someone who can edit test sets, can cancel it.',
      403
    );
  const res = await db
    .updateTable('text_scan_test_run')
    .set({
      status: sql`CASE WHEN status <> 'queued' THEN 'cancelling' WHEN ${REOPENED} THEN 'done' ELSE 'cancelled' END`,
      finished_at: sql`CASE WHEN status = 'queued' THEN coalesce(finished_at, now()) ELSE finished_at END`,
    })
    .where('start_id', '=', run.start_id)
    .where('status', 'in', [...CANCELLABLE_RUN_STATUSES])
    .returning('id')
    .execute();
  if (!res.length) throw new TestSetError('This run is not in progress.', 409);
  await record(deps.audit, {
    action: 'cancel',
    userId,
    setId,
    runIds: res.map((r) => Number(r.id)),
  });
  return res.length;
}

export async function rerunErrors(
  deps: RunsDeps,
  setId: number,
  runId: number,
  userId: number
): Promise<Started> {
  await requireOpenSet(deps.db, setId);
  const run = await getRun(deps.db, setId, runId);
  if (!['done', 'cancelled', 'failed'].includes(run.status))
    throw new TestSetError('This run has not finished yet.', 409);
  if (run.expires_at && new Date(run.expires_at).getTime() < Date.now())
    throw new TestSetError('This draft run has expired. Start a new run.', 409);
  const errors = await deps.db
    .selectFrom('text_scan_test_result')
    .select(sql<string>`count(*)`.as('n'))
    .where('run_id', '=', run.id)
    .where('status', '=', 'error')
    .executeTakeFirstOrThrow();
  const errorCount = Number(errors.n);
  if (!errorCount) throw new TestSetError('This run has no errors to re-run.', 400);
  const unscanned = await runnableCases(deps.db, setId)
    .select(sql<string>`count(*)`.as('n'))
    .where('c.id', '<=', run.max_case_id)
    .where(noResultIn(run.id))
    .executeTakeFirstOrThrow();
  // The worker scans every case without a result, so the quoted error count would undercount.
  if (Number(unscanned.n))
    throw new TestSetError(
      'This run stopped with cases not scanned, so a re-run would scan more than its errors. Start a new run.',
      409
    );

  const { prompts } = await liveStateFor(deps, []);
  const changed = Object.entries(run.prompt_ids as Record<string, number>)
    .filter(([key, id]) => id > 0 && prompts.active[promptKeyOf(key)]?.id !== id)
    .map(([key]) => `the ${promptKeyOf(key)} prompt`);
  if (run.model !== prompts.config.model) changed.push('the model');
  if (run.thinking !== prompts.config.thinking) changed.push('the thinking setting');
  if (changed.length) {
    const what = changed.join(', ');
    throw new TestSetError(
      `${what[0].toUpperCase()}${what.slice(
        1
      )} changed since this run, so re-running it would mix versions. Start a new run.`,
      409
    );
  }

  const startId = randomUUID();
  await deps.db.transaction().execute(async (trx) => {
    await guardStarts(trx, userId);
    await trx
      .deleteFrom('text_scan_test_result')
      .where('run_id', '=', run.id)
      .where('status', '=', 'error')
      .execute();
    const res = await trx
      .updateTable('text_scan_test_run')
      .set({
        status: 'queued',
        start_id: startId,
        run_by: userId,
        failure: null,
        started_at: null,
        ...(run.kind === 'baseline' && run.status === 'done' ? {} : { finished_at: null }),
        lease_owner: null,
        heartbeat_at: null,
        error_count: 0,
      })
      .where('id', '=', run.id)
      .where('status', '=', run.status)
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw new TestSetError('This run is already being re-run.', 409);
  });
  await record(deps.audit, { action: 'start', userId, setId, runIds: [runId], calls: errorCount });
  deps.launch(runId);
  return { startId, runIds: [runId], runId };
}
