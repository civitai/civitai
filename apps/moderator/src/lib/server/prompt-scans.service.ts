import { getClickhouse } from './clickhouse';
import type { PromptScan, PromptScanDays, PromptScanLimit } from '$lib/prompt-scans';

/**
 * The orchestrator's XGuard verdict on each generator prompt an account submitted, read from
 * `orchestration.xguardPromptResults` — the orchestrator's table, written once per prompt scan.
 *
 * It is a ReplacingMergeTree keyed on the prompt hash ALONE, so a prompt keeps one row whoever sent it:
 * resubmitting it replaces the row, and if another account later submits the same text the row moves to
 * them. Scans that failed or expired are not written at all. Both mean a missing prompt is not evidence
 * the account never submitted it.
 *
 * Label names and any thresholds are deliberately absent from this file: the panel renders whatever
 * keys the scan wrote, and the moderator picks the cutoff.
 */

type Row = {
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
  { days, limit }: { days: PromptScanDays; limit: PromptScanLimit }
): Promise<PromptScan[]> {
  const resp = await getClickhouse().query({
    query: `
      SELECT createdAt, positivePrompt, negativePrompt, scores
      FROM orchestration.xguardPromptResults
      WHERE userId = {userId:Int32}
        AND createdAt >= now() - toIntervalDay({days:UInt32})
      ORDER BY createdAt DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { userId, days, limit },
    format: 'JSONEachRow',
  });
  const rows = await resp.json<Row>();
  return rows.map((r) => ({
    createdAt: r.createdAt,
    prompt: r.positivePrompt,
    negativePrompt: r.negativePrompt || null,
    scores: readScores(r.scores),
  }));
}
