import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import type { PromptScan, PromptScanDays, PromptScanLimit } from '$lib/prompt-scans';

/**
 * The orchestrator's XGuard verdict on generator prompts an account submitted, read from
 * `orchestration.xguardPromptResults` (the orchestrator's table). It is not a complete history, so the
 * panel must never present a missing prompt as one the account did not send.
 *
 * Read with FINAL so each row is read once, in its current state.
 *
 * Label names and any thresholds are deliberately absent from this file: the panel renders whatever
 * keys the scan wrote, and the moderator picks the cutoff.
 */

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

export async function getPromptScans(
  userId: number,
  { days, limit, signal }: { days: PromptScanDays; limit: PromptScanLimit; signal?: AbortSignal }
): Promise<PromptScan[]> {
  const resp = await getClickhouse().query({
    query: `
      SELECT toString(promptHash) AS promptHash, createdAt, positivePrompt, negativePrompt, scores
      FROM orchestration.xguardPromptResults FINAL
      WHERE userId = {userId:Int32}
        AND createdAt >= now() - toIntervalDay({days:UInt32})
      ORDER BY createdAt DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { userId, days, limit },
    format: 'JSONEachRow',
    // Every call scans the table; a closed tab or a stuck query must not hold a ClickHouse slot.
    clickhouse_settings: { max_execution_time: 20 },
    abort_signal: signal,
  });
  const rows = await resp.json<Row>();
  return rows.map((r) => ({
    id: r.promptHash,
    createdAt: clickhouseDate(r.createdAt),
    prompt: r.positivePrompt,
    negativePrompt: r.negativePrompt || null,
    scores: readScores(r.scores),
  }));
}
