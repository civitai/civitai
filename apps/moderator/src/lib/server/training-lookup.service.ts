import { sql } from 'kysely';
import { dbRead, dbWrite } from '$lib/server/db';
import { getClickhouse } from '$lib/server/clickhouse';
import { clickhouseDate } from '$lib/server/clickhouse-date';
import {
  mergeOrchestratorRuns,
  queryJobBuckets,
  type ChargeRef,
  type RefundRow,
  type UserJobRow,
} from '$lib/server/training-orchestration.service';
import { mapBounded } from '$lib/server/bounded';
import { parseWorkflowId } from '$lib/server/workflow-id';
import { isInt4Id } from '$lib/server/users.service';

export const MAX_TRAINING_IDS = 25;
export const MAX_TRAINING_ACCOUNTS = 25;
export const MAX_TRAINING_DAYS = 90;
const RUN_LIMIT = 500;
const CONCURRENCY = 5;
/** A lookup still running at this point reads as unreachable rather than holding the turn. */
const BUDGET_MS = 25_000;

/** Charges carry a workflow id only from here on, and `orchestration.jobs` starts earlier still, so a
 *  miss before either date is "not recorded", never "did not happen". */
const CHARGE_WORKFLOW_SINCE = Date.UTC(2024, 9, 1);
const JOBS_SINCE = Date.UTC(2024, 4, 1);

/** Slack either side of the submit stamp in the id for its charge, as in `training-provenance`. */
const CHARGE_SLACK_MS = 120_000;
const REFUND_HORIZON_MS = 30 * 86_400_000;

/** `notFound` means the source was read and had nothing; `beyondRetention` that it could not have. */
export type LookupStatus = 'found' | 'notFound' | 'beyondRetention' | 'unreachable';

export type ChargeLeg = { accountType: string; amount: number };

export type TrainingRun = {
  workflowId: string;
  /** The account that submitted the run, read from the workflow id. */
  submitterId: number;
  submittedAt: string;
  charge: {
    status: LookupStatus;
    source: 'buzzTransactions';
    /** The account charged. */
    payerId: number | null;
    chargedAt: string | null;
    /** One per Buzz account type the run was paid from. */
    legs: ChargeLeg[];
    buzz: number;
    /** Buzz refunded for this run; null when the refund read failed. */
    refunded: number | null;
  };
  completion: {
    status: LookupStatus;
    source: 'orchestration.jobs';
    /** When the run's last job finished; null for a run still going or stopped before any job. */
    lastJobAt: string | null;
    /** Another workflow was submitted in the same second, so this time may be the other one's. */
    ambiguous: boolean;
  };
  version: {
    status: LookupStatus;
    source: 'ModelVersion.meta' | 'ModelFile.metadata' | null;
    modelVersionId: number | null;
    modelId: number | null;
  };
};

type ParsedId = { workflowId: string; ownerId: number; submittedAt: Date };

/** A workflow id as given, or with the `training_` prefix moderators copy it with. Anything else is
 *  rejected, and nothing rejected reaches a query: ids are interpolated into ClickHouse. */
export function parseTrainingId(raw: string): ParsedId | null {
  const workflowId = raw.trim().replace(/^training_/, '');
  const parsed = parseWorkflowId(workflowId);
  return parsed ? { workflowId, ...parsed } : null;
}

const ymdhms = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const iso = (ms: number) => new Date(ms).toISOString();
const sqlList = (values: string[]) => values.map((v) => `'${v}'`).join(',');

/** Results line up with `items`; one cut off by the budget is undefined. */
const inBatches = <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
  mapBounded(items, fn, { concurrency: CONCURRENCY, budgetMs: BUDGET_MS });

type ChargeRow = { id: string; date: string; payer: string; accountType: string; amount: string };

type RunRow = {
  payer: string;
  workflowId: string;
  chargedAt: string;
  types: string[];
  amounts: string[];
};

function legsOf(rows: { accountType: string; amount: string }[]): ChargeLeg[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.accountType, (by.get(r.accountType) ?? 0) + Number(r.amount));
  return [...by].map(([accountType, amount]) => ({ accountType, amount }));
}

type VersionHit = {
  modelVersionId: number;
  modelId: number;
  source: TrainingRun['version']['source'];
};

/**
 * The model version each run trained, bounded by the submitters' own models. `ModelVersion.meta` is
 * read first; `ModelFile.metadata` only for the rest and through the WRITE connection, because the
 * replica drops that TOASTed jsonb on UPDATE (see `getTrainingVersionDetail`).
 */
async function getVersions(
  runs: { workflowId: string; ownerId: number }[]
): Promise<Map<string, VersionHit> | null> {
  const owners = [...new Set(runs.map((r) => r.ownerId))].filter(isInt4Id);
  const ids = [...new Set(runs.map((r) => r.workflowId))];
  if (!owners.length || !ids.length) return new Map();
  try {
    const out = new Map<string, VersionHit>();
    const fromMeta = await dbRead
      .selectFrom('ModelVersion as mv')
      .innerJoin('Model as m', 'm.id', 'mv.modelId')
      .select([
        'mv.id as modelVersionId',
        'm.id as modelId',
        sql<string>`mv.meta->>'trainingWorkflowId'`.as('workflowId'),
      ])
      .where('m.userId', 'in', owners)
      .where(sql<string>`mv.meta->>'trainingWorkflowId'`, 'in', ids)
      .execute();
    for (const r of fromMeta) out.set(r.workflowId, { ...r, source: 'ModelVersion.meta' as const });

    const missing = ids.filter((id) => !out.has(id));
    if (missing.length) {
      const fromFile = await dbWrite
        .selectFrom('ModelFile as mf')
        .innerJoin('ModelVersion as mv', 'mv.id', 'mf.modelVersionId')
        .innerJoin('Model as m', 'm.id', 'mv.modelId')
        .select([
          'mv.id as modelVersionId',
          'm.id as modelId',
          sql<string>`mf.metadata->'trainingResults'->>'workflowId'`.as('workflowId'),
        ])
        .where('m.userId', 'in', owners)
        .where('mf.type', '=', 'Training Data')
        .where(sql<string>`mf.metadata->'trainingResults'->>'workflowId'`, 'in', missing)
        .execute();
      for (const r of fromFile)
        if (!out.has(r.workflowId))
          out.set(r.workflowId, { ...r, source: 'ModelFile.metadata' as const });
    }
    return out;
  } catch {
    return null;
  }
}

function versionOf(
  workflowId: string,
  versions: Map<string, VersionHit> | null
): TrainingRun['version'] {
  if (!versions)
    return { status: 'unreachable', source: null, modelVersionId: null, modelId: null };
  const hit = versions.get(workflowId);
  return hit
    ? {
        status: 'found',
        source: hit.source,
        modelVersionId: hit.modelVersionId,
        modelId: hit.modelId,
      }
    : { status: 'notFound', source: null, modelVersionId: null, modelId: null };
}

type Completion = { lastJobAt: string | null; ambiguous: boolean } | undefined;

/** Completion per workflow id from the job buckets, one account at a time: buckets are keyed by
 *  second, and two accounts can submit in the same one. */
function completionsOf(
  runs: { workflowId: string; ownerId: number; submittedAt: Date }[],
  jobs: UserJobRow[]
): Map<string, Completion> {
  const out = new Map<string, Completion>();
  for (const ownerId of new Set(runs.map((r) => r.ownerId))) {
    const charges: ChargeRef[] = runs
      .filter((r) => r.ownerId === ownerId)
      .map((r) => ({
        id: r.workflowId,
        date: ymdhms(r.submittedAt.getTime()),
        workflowId: r.workflowId,
      }));
    const merged = mergeOrchestratorRuns(
      charges,
      [],
      jobs.filter((j) => j.userId === ownerId),
      [],
      new Map()
    );
    for (const [workflowId, run] of Object.entries(merged))
      out.set(workflowId, { lastJobAt: run.lastJobAt, ambiguous: run.ambiguous });
  }
  return out;
}

function completionOf(
  submittedAt: Date,
  completions: Map<string, Completion> | null,
  workflowId: string
): TrainingRun['completion'] {
  const base = { source: 'orchestration.jobs' as const, lastJobAt: null, ambiguous: false };
  if (!completions) return { ...base, status: 'unreachable' };
  const hit = completions.get(workflowId);
  if (hit) return { ...base, status: 'found', ...hit };
  return { ...base, status: submittedAt.getTime() < JOBS_SINCE ? 'beyondRetention' : 'notFound' };
}

async function safeJobs(runs: ParsedId[], payers: Map<string, number>) {
  try {
    return await queryJobBuckets(
      runs.flatMap((r) => [r.ownerId, payers.get(r.workflowId) ?? r.ownerId]),
      runs.map((r) => r.submittedAt.getTime())
    );
  } catch {
    return null;
  }
}

export type TrainingLookup = { runs: TrainingRun[]; invalid: string[] };

/**
 * Who submitted and who paid for each training run, when it was charged and finished, what Buzz paid
 * for it and the model version it trained. Each id is looked up in its own narrow window around the
 * submit stamp it carries: the ledger has no index on workflow, so a wide window is a full scan.
 */
export async function lookupTrainings(rawIds: string[]): Promise<TrainingLookup> {
  const invalid: string[] = [];
  const byId = new Map<string, ParsedId>();
  for (const raw of rawIds.slice(0, MAX_TRAINING_IDS)) {
    const parsed = parseTrainingId(raw);
    if (parsed) byId.set(parsed.workflowId, parsed);
    else invalid.push(raw);
  }
  const parsed = [...byId.values()];
  if (!parsed.length) return { runs: [], invalid };

  const ch = getClickhouse();
  const read = await inBatches(parsed, async (p) => {
    const at = p.submittedAt.getTime();
    try {
      const rows = await ch.$query<ChargeRow>(`
        SELECT transactionId AS id, toString(date) AS date, fromAccountId AS payer,
               fromAccountType AS accountType, amount
        FROM buzzTransactions
        WHERE type = 'training'
          AND JSONExtractString(details, 'workflowId') = '${p.workflowId}'
          AND date >= '${ymdhms(at - CHARGE_SLACK_MS)}'
          AND date <= '${ymdhms(at + CHARGE_SLACK_MS)}'
        LIMIT 20
      `);
      return { p, rows, ok: true };
    } catch {
      return { p, rows: [] as ChargeRow[], ok: false };
    }
  });

  const charges = parsed.map((p, i) => read[i] ?? { p, rows: [] as ChargeRow[], ok: false });
  const payers = new Map<string, number>();
  for (const c of charges) if (c.rows[0]) payers.set(c.p.workflowId, Number(c.rows[0].payer));

  const refunds = await inBatches(
    parsed.filter((p) => payers.has(p.workflowId)),
    async (p) => {
      const at = p.submittedAt.getTime();
      try {
        const rows = await ch.$query<{ amount: string }>(`
          SELECT amount
          FROM buzzTransactions
          WHERE type = 'refund'
            AND toAccountId = ${payers.get(p.workflowId)}
            AND JSONExtractString(details, 'workflowId') = '${p.workflowId}'
            AND date >= '${ymdhms(at - 60_000)}'
            AND date <= '${ymdhms(at + REFUND_HORIZON_MS)}'
        `);
        return [p.workflowId, rows.reduce((sum, r) => sum + Number(r.amount), 0)] as const;
      } catch {
        return [p.workflowId, null] as const;
      }
    }
  );
  const refundBy = new Map<string, number | null>(refunds.filter((r) => r !== undefined));

  const [jobs, versions] = await Promise.all([safeJobs(parsed, payers), getVersions(parsed)]);
  const completions = jobs ? completionsOf(parsed, jobs) : null;

  const runs = charges.map(({ p, rows, ok }): TrainingRun => {
    const at = p.submittedAt.getTime();
    const status: LookupStatus = !ok
      ? 'unreachable'
      : rows.length
      ? 'found'
      : at < CHARGE_WORKFLOW_SINCE
      ? 'beyondRetention'
      : 'notFound';
    const legs = legsOf(rows);
    return {
      workflowId: p.workflowId,
      submitterId: p.ownerId,
      submittedAt: iso(at),
      charge: {
        status,
        source: 'buzzTransactions',
        payerId: rows[0] ? Number(rows[0].payer) : null,
        chargedAt: rows[0] ? clickhouseDate(rows[0].date.slice(0, 19)) : null,
        legs,
        buzz: legs.reduce((sum, l) => sum + l.amount, 0),
        refunded: rows.length ? refundBy.get(p.workflowId) ?? null : null,
      },
      completion: completionOf(p.submittedAt, completions, p.workflowId),
      version: versionOf(p.workflowId, versions),
    };
  });
  return { runs, invalid };
}

export type AccountTrainingRun = TrainingRun & {
  /** Charged to a listed account but submitted by another listed account. */
  sharedWith: number | null;
};

export type AccountTrainings = {
  days: number;
  /** False when the ledger could not be read: no runs then means "did not look", not "none". */
  reachable: boolean;
  runs: AccountTrainingRun[];
  /** Charges without a workflow id (before about 2024-10) per account: counted, not listed. */
  unlinkedCharges: Record<number, number>;
  truncated: boolean;
};

/**
 * The training runs a set of accounts paid for over the window, newest first, one row per run with
 * the Buzz legs that paid for it. A run a listed account submitted but another account paid for is
 * not found from the submitter's side: the ledger is read by payer.
 */
export async function getAccountTrainings(
  userIds: number[],
  days: number
): Promise<AccountTrainings> {
  const window = Math.min(MAX_TRAINING_DAYS, Math.max(1, Math.trunc(days)));
  const ids = [...new Set(userIds)].filter(isInt4Id).slice(0, MAX_TRAINING_ACCOUNTS);
  const empty = { days: window, runs: [], unlinkedCharges: {}, truncated: false };
  if (!ids.length) return { ...empty, reachable: true };
  const set = ids.join(',');
  const since = `date >= now() - INTERVAL ${window} DAY`;
  const ch = getClickhouse();

  // Grouped in ClickHouse so the cap counts runs, not the legs a run was paid in.
  let rows: RunRow[];
  try {
    rows = await ch.$query<RunRow>(`
      SELECT fromAccountId AS payer,
             JSONExtractString(details, 'workflowId') AS workflowId,
             toString(min(date)) AS chargedAt,
             groupArray(fromAccountType) AS types,
             groupArray(amount) AS amounts
      FROM buzzTransactions
      PREWHERE fromAccountId IN (${set})
      WHERE type = 'training' AND ${since}
      GROUP BY payer, workflowId, if(workflowId = '', transactionId, '') AS unlinked
      ORDER BY chargedAt DESC
      LIMIT ${RUN_LIMIT + 1}
    `);
  } catch {
    return { ...empty, reachable: false };
  }
  const truncated = rows.length > RUN_LIMIT;

  const unlinkedCharges: Record<number, number> = {};
  const runsIn: { parsed: ParsedId; row: RunRow }[] = [];
  for (const row of rows.slice(0, RUN_LIMIT)) {
    // Ledger text reaches the later queries by interpolation: only a well-formed id goes on.
    const workflow = parseWorkflowId(row.workflowId);
    if (!workflow) {
      const payer = Number(row.payer);
      unlinkedCharges[payer] = (unlinkedCharges[payer] ?? 0) + 1;
      continue;
    }
    runsIn.push({ parsed: { workflowId: row.workflowId, ...workflow }, row });
  }
  const parsed = runsIn.map((g) => g.parsed);
  const workflowIds = runsIn.map((g) => g.parsed.workflowId);

  // Separate from the charges: the combined OR form times out (see training-orchestration.service).
  const refundsRead = workflowIds.length
    ? ch
        .$query<{ workflowId: string; amount: string }>(
          `
          SELECT JSONExtractString(details, 'workflowId') AS workflowId, amount
          FROM buzzTransactions
          PREWHERE toAccountId IN (${set})
          WHERE type = 'refund' AND ${since}
            AND JSONExtractString(details, 'workflowId') IN (${sqlList(workflowIds)})
        `
        )
        .then((r) =>
          r.map((x): RefundRow => ({ workflowId: x.workflowId, amount: Number(x.amount) }))
        )
        .catch(() => null)
    : Promise.resolve([] as RefundRow[]);

  const payers = new Map(runsIn.map((g) => [g.parsed.workflowId, Number(g.row.payer)]));
  const [refunds, jobs, versions] = await Promise.all([
    refundsRead,
    parsed.length ? safeJobs(parsed, payers) : Promise.resolve([] as UserJobRow[]),
    getVersions(parsed),
  ]);
  const refundBy = new Map<string, number>();
  for (const r of refunds ?? [])
    refundBy.set(r.workflowId, (refundBy.get(r.workflowId) ?? 0) + r.amount);
  const completions = jobs ? completionsOf(parsed, jobs) : null;
  const listed = new Set(ids);

  const runs = runsIn.map(({ parsed: p, row }): AccountTrainingRun => {
    const payerId = Number(row.payer);
    const legSums = legsOf(
      row.types.map((accountType, i) => ({ accountType, amount: row.amounts[i] }))
    );
    return {
      workflowId: p.workflowId,
      submitterId: p.ownerId,
      submittedAt: iso(p.submittedAt.getTime()),
      charge: {
        status: 'found',
        source: 'buzzTransactions',
        payerId,
        chargedAt: clickhouseDate(row.chargedAt.slice(0, 19)),
        legs: legSums,
        buzz: legSums.reduce((sum, l) => sum + l.amount, 0),
        refunded: refunds ? refundBy.get(p.workflowId) ?? 0 : null,
      },
      completion: completionOf(p.submittedAt, completions, p.workflowId),
      version: versionOf(p.workflowId, versions),
      sharedWith: p.ownerId !== payerId && listed.has(p.ownerId) ? p.ownerId : null,
    };
  });

  return { days: window, reachable: true, runs, unlinkedCharges, truncated };
}
