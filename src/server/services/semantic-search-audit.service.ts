import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import {
  CAPTURE_OFF,
  createSampledRowBuffer,
  parseCaptureConfig,
  type CaptureConfig,
  type SampledRowBuffer,
} from '~/server/clickhouse/sampled-row-buffer';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { readGuardStatus } from '~/server/services/semantic-guard-status';
import type { QueryRefusal } from '~/server/services/semantic-query-guard';
import {
  GUARD_UNKNOWN,
  type GuardRead,
  type SearchCollection,
} from '~/server/services/semantic-search-client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const SEMANTIC_SEARCH_AUDIT_TABLE = 'semanticSearchAudit';
const CONFIG_TTL_MS = 15_000;
/** Ids kept per row; also how many a refused search is run for. */
export const AUDIT_RESULT_IDS = 20;
// Refused searches run for review per process per minute; past it a refusal is recorded alone, so
// a client repeating refused queries cannot drive the extra search calls.
export const REFUSED_RUNS_PER_MINUTE = 30;
const MAX_QUERY_LENGTH = 1_000;
// Only a passed query or a minor-narrowed one keeps what was served. Every other verdict withholds
// the ids, including any added later; its row keeps the query, rule and level.
export function verdictKeepsServedIds(verdict: QueryRefusal) {
  return verdict === false || verdict === 'minor';
}

export type SemanticSearchPath =
  | 'served'
  | 'narrowed'
  | 'refused_query'
  | 'refused_correction'
  | 'refused_own_images';
export type RefusedSearchPath = Extract<SemanticSearchPath, `refused_${string}`>;

// The only verdicts whose refused searches are run anyway, for the ids they would have served.
// Everything else, minor-adjacent verdicts and any added later included, is never run.
export function verdictComputesRefusedIds(verdict: QueryRefusal) {
  return verdict === 'blocked' || verdict === 'poi';
}

const batchCounter = registerCounterWithLabels({
  name: 'semantic_search_audit_batches_total',
  help: 'semanticSearchAudit ClickHouse inserts by outcome',
  labelNames: ['outcome'] as const,
});
const rowCounter = registerCounterWithLabels({
  name: 'semantic_search_audit_rows_total',
  help: 'semanticSearchAudit rows sampled (buffered) or shed while an insert was in flight (dropped)',
  labelNames: ['outcome'] as const,
});

export type SemanticAuditEntry = {
  index: SearchCollection;
  viewer: { id: number; isModerator?: boolean } | undefined;
  query: string;
  /** After any narrowing. */
  browsingLevel: number;
  /** The first word refusal, of the query or its correction. */
  wordVerdict: QueryRefusal;
  /** Set when any verdict of this search was one whose served ids are never stored. */
  withholdIds: boolean;
  /** Set when any verdict of this search was one that is never run for its refused ids. */
  withholdComputedIds: boolean;
  /** False when `resultIds` were computed for a refused search and never served. */
  resultsServed: boolean;
  searchPath: SemanticSearchPath;
  guard: GuardRead;
  cacheHit: boolean;
  resultIds: number[];
};

export type SemanticAuditRow = {
  time: string;
  requestId: string;
  searchIndex: string;
  userId: number;
  viewerClass: 'mod' | 'user' | 'anon';
  browsingLevel: number;
  wordVerdict: string | null;
  guardOutcome: string;
  guardRules: string[];
  guardMode: string;
  guardVersion: string;
  cacheHit: boolean;
  resultIds: number[];
  query: string;
  searchPath: SemanticSearchPath;
  /** Sent only when false, so the writer works before the column (DEFAULT true) exists. */
  resultsServed?: false;
};

/**
 * `withheldRules` is the guard's list of rules whose rows keep no ids. Unknown (`null`), any rule
 * withholds: a rule the app cannot place is treated as the strictest.
 */
export function buildSemanticAuditRow(
  entry: SemanticAuditEntry,
  at: number,
  requestId: string,
  withheldRules: ReadonlySet<string> | null
): SemanticAuditRow {
  const { guard } = entry;
  const withheldByGuard = withheldRules
    ? guard.rules.some((r) => withheldRules.has(r))
    : guard.rules.length > 0;
  // A minor verdict keeps ids only on the narrowed path, never on a refused one.
  const idsAllowed = entry.resultsServed
    ? !entry.withholdIds &&
      verdictKeepsServedIds(entry.wordVerdict) &&
      (!entry.wordVerdict || entry.searchPath === 'narrowed')
    : !entry.withholdComputedIds && verdictComputesRefusedIds(entry.wordVerdict);
  // A refused search's ids are stored only past a guard read it can check rules against.
  const refusedUnchecked = !entry.resultsServed && guard.outcome === 'unknown';
  // A flag or unknown read that names no rule (one the service filled no rules for) withholds.
  const unnamedFlag =
    (guard.outcome === 'flag' || guard.outcome === 'unknown') && guard.rules.length === 0;
  const withhold = !idsAllowed || withheldByGuard || refusedUnchecked || unnamedFlag;
  const userId = entry.viewer?.id;
  return {
    time: formatClickhouseDateTime64(at),
    requestId,
    searchIndex: entry.index,
    userId: Number.isInteger(userId) && userId! > 0 ? Math.min(userId!, 4_294_967_295) : 0,
    viewerClass: !entry.viewer ? 'anon' : entry.viewer.isModerator ? 'mod' : 'user',
    browsingLevel: Math.min(Math.max(entry.browsingLevel | 0, 0), 65_535),
    wordVerdict: entry.wordVerdict || null,
    guardOutcome: guard.outcome,
    guardRules: guard.rules,
    guardMode: guard.mode,
    guardVersion: guard.version ?? '',
    cacheHit: entry.cacheHit,
    resultIds: withhold ? [] : entry.resultIds.slice(0, AUDIT_RESULT_IDS),
    query: entry.query.slice(0, MAX_QUERY_LENGTH),
    searchPath: entry.searchPath,
    ...(!entry.resultsServed && { resultsServed: false as const }),
  };
}

/** The ids a refused search would have served: its candidates, before hydration. */
export type RefusedCandidates = { ids: number[]; guard?: GuardRead; cacheHit?: boolean };

type SemanticAuditConfig = CaptureConfig & {
  /** Run refused searches for their ids; set only once the `resultsServed` column is live. */
  refusalCandidates: boolean;
};

export function parseSemanticAuditConfig(
  raw: Record<string, string> | null | undefined
): SemanticAuditConfig {
  return { ...parseCaptureConfig(raw), refusalCandidates: raw?.refusalCandidates === '1' };
}

export type SemanticSearchAudit = {
  /** Fire-and-forget at call sites; returns the settled promise for tests. */
  record: (entry: SemanticAuditEntry) => Promise<void>;
  /**
   * Records a refused search. While capture and `refusalCandidates` are on, it first runs
   * `compute` for the ids it would have served; a failed run records the refusal alone.
   */
  recordRefused: (
    entry: SemanticAuditEntry,
    compute: () => Promise<RefusedCandidates>
  ) => Promise<void>;
  flush: () => Promise<void>;
};

type AuditDeps = {
  getConfig: () => Promise<SemanticAuditConfig>;
  insert: (rows: SemanticAuditRow[]) => Promise<void>;
  withheldRules: () => Promise<ReadonlySet<string> | null>;
  now?: () => number;
  random?: () => number;
  flushIntervalMs?: number;
  onError?: (error: Error, rows: number) => void;
  refusedRunsPerMinute?: number;
};

export function createSemanticSearchAudit(
  deps: AuditDeps
): SemanticSearchAudit & Pick<SampledRowBuffer<SemanticAuditRow>, 'pending' | 'dropped'> {
  const rows = createSampledRowBuffer<SemanticAuditRow>({
    ...deps,
    table: SEMANTIC_SEARCH_AUDIT_TABLE,
    counters: { batches: batchCounter, rows: rowCounter },
  });
  const now = deps.now ?? Date.now;
  const runCap = deps.refusedRunsPerMinute ?? REFUSED_RUNS_PER_MINUTE;
  let runWindow = -1;
  let runsInWindow = 0;
  const takeRun = () => {
    const window = Math.floor(now() / 60_000);
    if (window !== runWindow) {
      runWindow = window;
      runsInWindow = 0;
    }
    if (runsInWindow >= runCap) return false;
    runsInWindow++;
    return true;
  };
  const record = async (entry: SemanticAuditEntry) => {
    let withheld: ReadonlySet<string> | null = null;
    if (entry.guard.rules.length) withheld = await deps.withheldRules().catch(() => null);
    // A refusal or a guard flag is what a review reads, so it is never sampled away.
    const unsampled = !!entry.wordVerdict || entry.guard.rules.length > 0;
    return rows.push((at, traceId) => buildSemanticAuditRow(entry, at, traceId, withheld), {
      unsampled,
    });
  };
  return {
    record,
    recordRefused: async (entry, compute) => {
      const config = await deps.getConfig().catch(() => undefined);
      const run =
        entry.resultsServed &&
        !entry.withholdComputedIds &&
        verdictComputesRefusedIds(entry.wordVerdict) &&
        !!config?.refusalCandidates &&
        config.sampleRate > 0 &&
        now() <= config.until &&
        takeRun();
      const computed = run ? await compute().catch(() => undefined) : undefined;
      if (!computed) return record(entry);
      return record({
        ...entry,
        resultsServed: false,
        resultIds: computed.ids,
        guard: computed.guard ?? GUARD_UNKNOWN,
        cacheHit: computed.cacheHit ?? false,
      });
    },
    flush: rows.flush,
    get pending() {
      return rows.pending;
    },
    get dropped() {
      return rows.dropped;
    },
  };
}

let instance: SemanticSearchAudit | undefined;

function semanticSearchAudit(): SemanticSearchAudit {
  if (instance) return instance;
  const client = clickhouse;
  if (!client)
    return (instance = {
      record: async () => undefined,
      recordRefused: async () => undefined,
      flush: async () => undefined,
    });
  return (instance = createSemanticSearchAudit({
    // A failed or slow read memoizes "off" for one TTL instead of re-reading per request.
    getConfig: createTtlMemo(async () => {
      try {
        return parseSemanticAuditConfig(
          await withSysReadDeadline(
            sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.SEMANTIC_SEARCH_AUDIT)
          )
        );
      } catch {
        return { ...CAPTURE_OFF, refusalCandidates: false };
      }
    }, CONFIG_TTL_MS),
    insert: async (values) => {
      await client.insert({ table: SEMANTIC_SEARCH_AUDIT_TABLE, values, format: 'JSONEachRow' });
    },
    // The status read is gated with the rest of the audit flag; off, every rule withholds.
    withheldRules: async () =>
      (await isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SEARCH_AUDIT))
        ? (await readGuardStatus()).withholdResults
        : null,
  }));
}

/** Writes one semanticSearchAudit row. Never throws and never delays the search. */
export function recordSemanticAudit(entry: SemanticAuditEntry): void {
  void semanticSearchAudit()
    .record(entry)
    .catch(() => undefined);
}

/** As recordSemanticAudit, for a refused search; the extra run happens after the response. */
export function recordRefusedSemanticAudit(
  entry: SemanticAuditEntry,
  compute: () => Promise<RefusedCandidates>
): void {
  void semanticSearchAudit()
    .recordRefused(entry, compute)
    .catch(() => undefined);
}
