import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import type { PromptScan, PromptScanDays, PromptScanLimit } from '$lib/prompt-scans';

/**
 * The orchestrator's XGuard verdict on generator prompts an account submitted, read from
 * `orchestration.xguardPromptResults` (the orchestrator's table). It is not a complete history, so the
 * panel must never present a missing prompt as one the account did not send.
 *
 * The table is ordered by promptHash alone, so a filter on userId scans all of it, and FINAL over the
 * prompt text made that scan 27-53 s. Two steps instead: find the account's hashes from the narrow
 * columns without FINAL, then read with FINAL only the granules the primary key places those hashes in
 * (measured 4-24 s; hashes are spread evenly, so at the 500 cap that is still about two thirds of the table).
 *
 * Label names and any thresholds are deliberately absent from this file: the panel renders whatever
 * keys the scan wrote, and the moderator picks the cutoff.
 */

export const PROMPT_SCAN_TIMEOUT_S = 45;

/** ClickHouse's TIMEOUT_EXCEEDED: the scan outran `max_execution_time`. */
export const isScanTimeout = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && String((e as { code?: unknown }).code) === '159';

type Row = {
  promptHash: string;
  createdAt: string;
  positivePrompt: string;
  negativePrompt: string;
  scores: Record<string, number>;
};

/** `__`-prefixed keys are bookkeeping the scan writes beside its labels, not scores. */
export function readScores(raw: Record<string, number> | null | undefined) {
  return Object.entries(raw ?? {})
    .filter(([label, score]) => !label.startsWith('__') && Number.isFinite(score))
    .map(([label, score]) => ({ label, score }))
    .sort((a, b) => b.score - a.score);
}

// A closed tab cancels either read.
const SCAN_SETTINGS = {
  // ClickHouse keeps running a query whose HTTP client went away unless the query is readonly and asks
  // to be cancelled; the app's user also writes, so these reads mark themselves readonly.
  readonly: '2',
  cancel_http_readonly_queries_on_client_close: 1,
} as const;

export async function getPromptScans(
  userId: number,
  { days, limit, signal }: { days: PromptScanDays; limit: PromptScanLimit; signal?: AbortSignal }
): Promise<{ items: PromptScan[]; truncated: boolean }> {
  const ch = getClickhouse();
  // The two reads share one budget, which stays under Cloudflare's 100 s with room for the request.
  const deadline = Date.now() + PROMPT_SCAN_TIMEOUT_S * 1000;
  // Without FINAL this also sees superseded versions of a row, which is why step 2 checks userId again.
  const hashes = await ch
    .query({
      query: `
        SELECT toString(promptHash) AS promptHash
        FROM orchestration.xguardPromptResults
        WHERE userId = {userId:Int32}
          AND createdAt >= now() - toIntervalDay({days:UInt32})
        GROUP BY promptHash
        ORDER BY max(createdAt) DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { userId, days, limit },
      format: 'JSONEachRow',
      clickhouse_settings: { ...SCAN_SETTINGS, max_execution_time: PROMPT_SCAN_TIMEOUT_S },
      abort_signal: signal,
    })
    .then((r) => r.json<{ promptHash: string }>());
  if (!hashes.length) return { items: [], truncated: false };
  // Step 2 can drop some of these, so a capped read may return fewer rows than the limit.
  const truncated = hashes.length >= limit;

  const resp = await ch.query({
    query: `
      SELECT toString(promptHash) AS promptHash, createdAt, positivePrompt, negativePrompt, scores
      FROM orchestration.xguardPromptResults FINAL
      WHERE promptHash IN {hashes:Array(Int64)}
        AND userId = {userId:Int32}
      ORDER BY createdAt DESC
      LIMIT {limit:UInt32}
    `,
    // BigInt so the client sends the hashes unquoted, as Int64 literals.
    query_params: { hashes: hashes.map((h) => BigInt(h.promptHash)), userId, limit },
    format: 'JSONEachRow',
    clickhouse_settings: {
      ...SCAN_SETTINGS,
      max_execution_time: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
    },
    abort_signal: signal,
  });
  const rows = await resp.json<Row>();
  const items = rows.map((r) => ({
    id: r.promptHash,
    createdAt: clickhouseDate(r.createdAt),
    prompt: r.positivePrompt,
    negativePrompt: r.negativePrompt || null,
    scores: readScores(r.scores),
  }));
  return { items, truncated };
}
