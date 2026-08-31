import { sql } from 'kysely';
import { dbRead } from '$lib/server/db';
import { getClickhouse } from '$lib/server/clickhouse';
import { clickhouseDate } from '$lib/server/clickhouse-date';
import { utcMs } from '$lib/format';

// A run whose Draft model was reaped at 30 days has no DB record, and the orchestrator flushes on the
// same horizon — ClickHouse's copy is the only thing that outlives both.
//
// `orchestration.workflowSteps` keys on the charge's `workflowId` and is the only source of final
// status. Retention ~3 months. Its `type` was renamed on 2026-07-16 (`training` /
// `imageResourceTraining` → `model/kohya`, `model/musubi`, `model/ai-toolkit/<ecosystem>`), so matching
// one form silently loses every run on the other side of that date.
//
// `orchestration.jobs` has no workflow column (`externalId` is populated on 10 rows of 3M), but every
// job of a workflow shares one `createdAt` instant ~150ms after the charge — so the submit second is
// the join key. Back to 2024-05, and it carries epochs, real GPU cost, provider and `resourcesUsed`.
//
// The money is in neither: `orchestration` costs are GPU, not Buzz. A refund is a `buzzTransactions`
// row of type `refund` carrying the same `workflowId`, so it joins to the charge exactly.
//
// ⚠️ Charges and refunds must be TWO queries. The combined
// `(type='training' AND fromAccountId=x) OR (type='refund' AND toAccountId=x)` defeats whatever prunes
// the single-sided form: 0.2s + 1.5s apart, against 21s combined and a 280s timeout.
//
// ⚠️ Both tables are `ORDER BY createdAt` with no index on user or workflow, so cost is a function of
// the WINDOW, not of rows returned — every bound below is load-bearing (heaviest account: 0.7s over
// 7 days, 19.1s over its full 912). And a cheap measurement on an OLD window proves nothing:
// `workflowSteps` starts around 2026-05-18, so anything mostly before that prunes to nothing.

/** Step types that are a training run. `model/model*` and `model/comfyNodepackSnapshot` share the
 *  `model/` namespace but are upload-scanning steps, not trainings. */
const TRAINING_STEP_TYPES = `(
  (startsWith(type, 'model/') AND NOT startsWith(type, 'model/model') AND type != 'model/comfyNodepackSnapshot')
  OR type IN ('training', 'imageResourceTraining')
)`;

/** The job types that ARE the training. A workflow also dispatches `Gate` and `AgeClassification`,
 *  which are reported but are not epochs; its sampler is filtered out — see `BUCKET_JOB_TYPES`. */
const TRAINING_JOB_TYPES = ['AIToolkitTrainingEpoch', 'ImageResourceTraining'];

/**
 * What the jobs query is allowed to pull into a bucket.
 *
 * 🔴 Do not widen this. A bucket is "every job this account created in that second", and the samplers
 * a training dispatches are the same job types a plain generation uses — so an account generating at
 * the moment it submitted a training gets those jobs reported as the run, and "no training job ran"
 * renders over someone else's. `Gate` and `AgeClassification` stay: a run stopped before training
 * dispatches those and nothing else, which is what the panel's badge reads.
 */
const BUCKET_JOB_TYPES = [...TRAINING_JOB_TYPES, 'Gate', 'AgeClassification'];

/** One `Gate` job per workflow, so a bucket's Gate count is how many workflows landed in it. */
const GATE_JOB_TYPE = 'Gate';

export type ChargeRef = {
  /** `buzzTransactions.transactionId` — how the caller re-attaches this to the row it already has. */
  id: string;
  /** The charge instant, as ClickHouse returns it: `YYYY-MM-DD HH:MM:SS`, UTC, no zone marker. */
  date: string;
  workflowId: string | null;
};

export type StepRow = {
  workflowId: string;
  type: string;
  status: string;
  jobs: number;
  cost: number;
  failureClass: string;
};

export type JobRow = {
  /** The submit second shared by every job of the workflow. */
  second: string;
  jobType: string;
  jobs: number;
  cost: number;
  provider: string;
  lastCompletedAt: string;
  resources: number[];
};

export type RefundRow = {
  /** The refunded workflow, from `details`. Charges and refunds of one run share it exactly. */
  workflowId: string;
  amount: number;
};

export type BaseModel = {
  modelVersionId: number;
  modelId: number;
  modelName: string | null;
  versionName: string | null;
  baseModel: string | null;
};

export type OrchestratorRun = {
  /** From `workflowSteps`; null when the run predates its retention window. */
  status: string | null;
  /** The step type with the `model/` namespace stripped — `ai-toolkit/sdxl`, `kohya`. */
  engine: string | null;
  /** Buzz returned for this run, summed over every refund carrying its workflow id. 0 means the
   *  account paid in full; equal to the charge means the run failed or was cancelled. Null only when
   *  the charge carries no workflow id to join on — i.e. before 2024-10. */
  refunded: number | null;
  failureClass: string | null;
  /** From `jobs`; null when no job bucket matched the submit second. */
  epochs: number | null;
  /** GPU cost of the training, `Gate` and classification jobs — not the sampler, which the bucket
   *  filter excludes — and not what the account was quoted. */
  cost: number | null;
  provider: string | null;
  /** When the last job of the workflow finished — i.e. whether it ran to the end. */
  lastJobAt: string | null;
  /** The bucket's job types, largest first — training, `Gate` and `AgeClassification` only. A run
   *  with `Gate` and no epoch job was submitted and stopped before training. */
  jobTypes: { type: string; count: number }[];
  baseModels: BaseModel[];
  /** More than one workflow landed in this submit second, so these numbers cover all of them. `jobs`
   *  has no workflow column to split them by. The other workflow need not be a training — a plain
   *  generation submitted in the same second counts. */
  ambiguous: boolean;
};

export type TrainingOrchestration = {
  /** Keyed by `buzzTransactions.transactionId`. Absent means neither table had anything. */
  runs: Record<string, OrchestratorRun>;
  /** False when the lookup itself failed, so the panel can say "could not read" rather than
   *  "nothing survives" — the two mean opposite things to whoever is deciding a refund. */
  reachable: boolean;
  /** Charges older than the newest `MAX_ENRICHED` were not looked up. Reported rather than silently
   *  dropped: a list that quietly stops reads as "the rest have nothing". */
  truncated: boolean;
  /** The oldest charge this call actually looked up, as a UTC ISO string. A charge older than it has
   *  an absent `runs` entry for a different reason than one inside the window — not found and not
   *  looked up are opposite answers to "was this account charged for nothing". */
  enrichedFrom: string | null;
};

/**
 * How many charges one call will enrich, newest first.
 *
 * The submit seconds go into the jobs query as an `IN` list, and ClickHouse rejects a statement over
 * `max_query_size` (256KB). 400 charges is ~27KB; 11,615 produced 766KB and threw.
 */
const MAX_ENRICHED = 400;

/** `workflowSteps` retains ~3 months; an older bound prunes nothing and costs real time (a 912-day
 *  span clamped to 100 took the step query 19.1s → 7.1s). `jobs` has no such floor. */
const STEPS_RETENTION_DAYS = 100;

/** Every job of a workflow is stamped ~150ms after the charge, so the submit second usually matches and
 *  occasionally rolls over. */
const SECOND_OFFSETS = [0, 1];

const ymdhms = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The instant a run was submitted, to the second. `workflowId` carries it to the millisecond and is on
 *  every charge since 2024-10; the charge's own `date` is the fallback for older ones. */
export function submitSecond(charge: ChargeRef): string | null {
  const stamp = charge.workflowId?.split('-')[1];
  if (stamp && /^\d{14}/.test(stamp))
    return (
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ` +
      `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`
    );
  const ms = utcMs(charge.date);
  return Number.isNaN(ms) ? null : ymdhms(ms);
}

/** Attach the orchestration history to each charge. The job side is joined on a TIMESTAMP, not an id,
 *  so its failure mode is a confident wrong answer rather than an empty one. */
export function mergeOrchestratorRuns(
  charges: ChargeRef[],
  steps: StepRow[],
  jobs: JobRow[],
  refunds: RefundRow[],
  baseModels: Map<number, BaseModel>
): Record<string, OrchestratorRun> {
  const stepBy = new Map(steps.map((s) => [s.workflowId, s]));

  // Summed, not taken: one workflow can carry several refund rows.
  const refundBy = new Map<string, number>();
  for (const r of refunds) refundBy.set(r.workflowId, (refundBy.get(r.workflowId) ?? 0) + r.amount);

  const jobsBy = new Map<string, JobRow[]>();
  for (const row of jobs) {
    const key = row.second.slice(0, 19);
    const bucket = jobsBy.get(key);
    if (bucket) bucket.push(row);
    else jobsBy.set(key, [row]);
  }

  const resolved = charges.map((charge) => {
    const second = submitSecond(charge);
    const ms = second === null ? NaN : utcMs(second);
    const key = Number.isNaN(ms)
      ? undefined
      : SECOND_OFFSETS.map((offset) => ymdhms(ms + offset * 1000)).find((candidate) =>
          jobsBy.has(candidate)
        );
    return { charge, key };
  });

  // A second holding more than one workflow cannot be split, only declared. Counting CHARGES is not
  // enough: the other workflow may be a generation, which is no charge at all — so the bucket's own
  // `Gate` count is the primary signal and the charge count only a fallback for data without one.
  const claims = new Map<string, number>();
  for (const { key } of resolved) if (key) claims.set(key, (claims.get(key) ?? 0) + 1);

  const runs: Record<string, OrchestratorRun> = {};
  for (const { charge, key } of resolved) {
    const step = charge.workflowId ? stepBy.get(charge.workflowId) : undefined;
    const bucket = key ? jobsBy.get(key) ?? [] : [];
    const refunded = charge.workflowId ? refundBy.get(charge.workflowId) ?? 0 : null;
    if (!step && !bucket.length && !refunded) continue;

    const training = bucket.filter((r) => TRAINING_JOB_TYPES.includes(r.jobType));
    const resources = [...new Set(training.flatMap((r) => r.resources))];
    const finished = bucket
      .map((r) => r.lastCompletedAt)
      .sort()
      .at(-1);

    runs[charge.id] = {
      refunded,
      status: step?.status || null,
      engine: step ? step.type.replace(/^model\//, '') : null,
      failureClass: step?.failureClass || null,
      epochs: training.length ? training.reduce((sum, r) => sum + r.jobs, 0) : null,
      cost: bucket.length ? Math.round(bucket.reduce((sum, r) => sum + r.cost, 0)) : null,
      provider: training.find((r) => r.provider)?.provider ?? null,
      lastJobAt: finished ? clickhouseDate(finished.slice(0, 19)) : null,
      jobTypes: bucket
        .map((r) => ({ type: r.jobType, count: r.jobs }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      baseModels: resources.flatMap((id) => {
        const model = baseModels.get(id);
        return model ? [model] : [];
      }),
      ambiguous:
        (bucket.find((r) => r.jobType === GATE_JOB_TYPE)?.jobs ?? 0) > 1 ||
        (!!key && (claims.get(key) ?? 0) > 1),
    };
  }
  return runs;
}

/**
 * @param withStatus also read `orchestration.workflowSteps`. Off by default: it is 5-9s on a wide
 * window against ~1s for everything else here. It adds the status word, the failure class and the
 * ecosystem name. Whether the account got its Buzz back comes from the ledger either way.
 * @param since ignore charges older than this (`YYYY-MM-DD HH:MM:SS`, UTC). Cost scales with the
 * width of the window, not with rows returned, so callers should pass the oldest row they display.
 */
export async function getTrainingOrchestration(
  userId: number,
  withStatus = false,
  since: string | null = null
): Promise<TrainingOrchestration> {
  try {
    const id = Math.trunc(userId);
    const sinceMs = since ? utcMs(since) : NaN;
    const charges = await getClickhouse().$query<{ id: string; date: string; workflowId: string }>(`
      SELECT
        transactionId AS id,
        toString(date) AS date,
        JSONExtractString(details, 'workflowId') AS workflowId
      FROM buzzTransactions
      WHERE type = 'training' AND fromAccountId = ${id}
        ${Number.isNaN(sinceMs) ? '' : `AND date >= '${ymdhms(sinceMs)}'`}
      ORDER BY date DESC
    `);

    const all: ChargeRef[] = charges.map((c) => ({
      id: c.id,
      date: c.date.slice(0, 19),
      workflowId: c.workflowId || null,
    }));
    const refs = all.slice(0, MAX_ENRICHED);
    const seconds = [...new Set(refs.flatMap((r) => submitSecond(r) ?? []))];
    if (!seconds.length) return { runs: {}, reachable: true, truncated: false, enrichedFrom: null };

    const times = seconds.map(utcMs);
    // Jobs are stamped at submit, so a minute of slack covers them; a step row is written when the
    // step ENDS, and a long training runs for days.
    const from = ymdhms(Math.min(...times) - 60_000);
    const jobsTo = ymdhms(Math.max(...times) + 60_000);
    const stepsTo = ymdhms(Math.max(...times) + 7 * 86_400_000);
    const stepsFrom = ymdhms(Math.max(utcMs(from), Date.now() - STEPS_RETENTION_DAYS * 86_400_000));
    const inSeconds = times
      .flatMap((ms) =>
        SECOND_OFFSETS.map((offset) => `toDateTime('${ymdhms(ms + offset * 1000)}')`)
      )
      .join(',');

    const [steps, jobs, refunds] = await Promise.all([
      withStatus
        ? getClickhouse().$query<{
            workflowId: string;
            type: string;
            status: string;
            jobs: string;
            cost: number;
            failureClass: string;
          }>(`
                SELECT workflowId, type, status, jobs, cost, failureClass
            FROM orchestration.workflowSteps
            WHERE createdAt BETWEEN '${stepsFrom}' AND '${stepsTo}'
              AND startsWith(workflowId, '${id}-')
              AND ${TRAINING_STEP_TYPES}
          `)
        : Promise.resolve([]),
      getClickhouse().$query<{
        second: string;
        jobType: string;
        jobs: string;
        cost: number;
        provider: string;
        lastCompletedAt: string;
        resources: number[];
      }>(`
        SELECT
          toString(toStartOfSecond(createdAt)) AS second,
          jobType,
          count() AS jobs,
          sum(cost) AS cost,
          anyIf(provider, provider != '') AS provider,
          toString(max(completedAt)) AS lastCompletedAt,
          arrayDistinct(arrayFlatten(groupArray(resourcesUsed))) AS resources
        FROM orchestration.jobs
        WHERE userId = ${id}
          AND createdAt BETWEEN '${from}' AND '${jobsTo}'
          AND jobType IN (${BUCKET_JOB_TYPES.map((t) => `'${t}'`).join(',')})
          AND toStartOfSecond(createdAt) IN (${inSeconds})
        GROUP BY second, jobType
      `),
      // Open above: a refund cannot precede its charge but can land long after. A row with no workflow
      // id joins to nothing — the join key IS the workflow id.
      getClickhouse().$query<{ workflowId: string; amount: string }>(`
        SELECT JSONExtractString(details, 'workflowId') AS workflowId, amount
        FROM buzzTransactions
        WHERE type = 'refund'
          AND toAccountId = ${id}
          AND date >= '${from}'
          AND JSONExtractString(details, 'workflowId') != ''
      `),
    ]);

    const jobRows: JobRow[] = jobs.map((r) => ({
      ...r,
      jobs: Number(r.jobs),
      cost: Number(r.cost),
    }));
    const stepRows: StepRow[] = steps.map((r) => ({ ...r, jobs: Number(r.jobs) }));
    const refundRows: RefundRow[] = refunds.map((r) => ({
      workflowId: r.workflowId,
      amount: Number(r.amount),
    }));
    const baseModels = await resolveBaseModels(
      jobRows.filter((r) => TRAINING_JOB_TYPES.includes(r.jobType)).flatMap((r) => r.resources)
    );

    return {
      runs: mergeOrchestratorRuns(refs, stepRows, jobRows, refundRows, baseModels),
      reachable: true,
      truncated: all.length > refs.length,
      enrichedFrom: clickhouseDate(refs[refs.length - 1].date),
    };
  } catch {
    return { runs: {}, reachable: false, truncated: false, enrichedFrom: null };
  }
}

/**
 * `resourcesUsed` on a training job is the base checkpoint's modelVersionId — the only surviving answer
 * to "what did they train on" once the run's own record is gone.
 *
 * Catches its own failure: it is the one Postgres read here and it runs last, so letting it reject
 * would discard the status, epochs and refund figures already in hand and report them as unreachable.
 */
async function resolveBaseModels(ids: number[]): Promise<Map<number, BaseModel>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  try {
    const rows = await dbRead
      .selectFrom('ModelVersion as mv')
      .innerJoin('Model as m', 'm.id', 'mv.modelId')
      .select([
        'mv.id as modelVersionId',
        'm.id as modelId',
        'm.name as modelName',
        'mv.name as versionName',
        sql<string | null>`mv."baseModel"`.as('baseModel'),
      ])
      .where('mv.id', 'in', unique)
      .execute();
    return new Map(rows.map((r) => [r.modelVersionId, r]));
  } catch {
    return new Map();
  }
}
