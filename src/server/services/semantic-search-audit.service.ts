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
import type { GuardRead, SearchCollection } from '~/server/services/semantic-search-client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const SEMANTIC_SEARCH_AUDIT_TABLE = 'semanticSearchAudit';
const CONFIG_TTL_MS = 15_000;
const MAX_RESULT_IDS = 20;
const MAX_QUERY_LENGTH = 1_000;
// Only a query the audit passed keeps what was served. Every verdict withholds the ids, including
// any added later; its row keeps the query, rule and level.
export function verdictKeepsServedIds(verdict: QueryRefusal) {
  return verdict === false;
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
  const withhold =
    entry.withholdIds || !verdictKeepsServedIds(entry.wordVerdict) || withheldByGuard;
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
    resultIds: withhold ? [] : entry.resultIds.slice(0, MAX_RESULT_IDS),
    query: entry.query.slice(0, MAX_QUERY_LENGTH),
  };
}

export type SemanticSearchAudit = {
  /** Fire-and-forget at call sites; returns the settled promise for tests. */
  record: (entry: SemanticAuditEntry) => Promise<void>;
  flush: () => Promise<void>;
};

type AuditDeps = {
  getConfig: () => Promise<CaptureConfig>;
  insert: (rows: SemanticAuditRow[]) => Promise<void>;
  withheldRules: () => Promise<ReadonlySet<string> | null>;
  now?: () => number;
  random?: () => number;
  flushIntervalMs?: number;
  onError?: (error: Error, rows: number) => void;
};

export function createSemanticSearchAudit(
  deps: AuditDeps
): SemanticSearchAudit & Pick<SampledRowBuffer<SemanticAuditRow>, 'pending' | 'dropped'> {
  const rows = createSampledRowBuffer<SemanticAuditRow>({
    ...deps,
    table: SEMANTIC_SEARCH_AUDIT_TABLE,
    counters: { batches: batchCounter, rows: rowCounter },
  });
  return {
    record: async (entry) => {
      let withheld: ReadonlySet<string> | null = null;
      if (entry.guard.rules.length) withheld = await deps.withheldRules().catch(() => null);
      return rows.push((at, traceId) => buildSemanticAuditRow(entry, at, traceId, withheld));
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
  if (!client) return (instance = { record: async () => undefined, flush: async () => undefined });
  return (instance = createSemanticSearchAudit({
    // A failed or slow read memoizes "off" for one TTL instead of re-reading per request.
    getConfig: createTtlMemo(async () => {
      try {
        return parseCaptureConfig(
          await withSysReadDeadline(
            sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.SEMANTIC_SEARCH_AUDIT)
          )
        );
      } catch {
        return CAPTURE_OFF;
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
