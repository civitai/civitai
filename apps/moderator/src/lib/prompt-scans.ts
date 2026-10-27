// Shared by the endpoint and the panel; the query lives in $lib/server/prompt-scans.service.

export const PROMPT_SCAN_DAYS = [7, 30, 90] as const;
export const PROMPT_SCAN_LIMITS = [100, 250, 500] as const;
export type PromptScanDays = (typeof PROMPT_SCAN_DAYS)[number];
export type PromptScanLimit = (typeof PROMPT_SCAN_LIMITS)[number];

export type PromptScan = {
  /** The prompt hash, which is the table's key: unique per row, and stable across re-sorts and reloads. */
  id: string;
  createdAt: string;
  prompt: string;
  negativePrompt: string | null;
  /** Highest first. */
  scores: { label: string; score: number }[];
};

const topScore = (s: PromptScan) => s.scores[0]?.score ?? 0;

/** The panel's filter and sort. A blank or non-numeric floor filters nothing. */
export function visibleScans(
  items: PromptScan[],
  { sort, minScore }: { sort: 'newest' | 'score'; minScore: string }
): PromptScan[] {
  const floor = Number(minScore);
  const kept =
    minScore.trim() && Number.isFinite(floor) ? items.filter((s) => topScore(s) >= floor) : items;
  return sort === 'score' ? [...kept].sort((a, b) => topScore(b) - topScore(a)) : kept;
}
