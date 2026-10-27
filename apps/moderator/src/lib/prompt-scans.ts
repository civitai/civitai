// Shared by the endpoint and the panel; the query lives in $lib/server/prompt-scans.service.

export const PROMPT_SCAN_DAYS = [7, 30, 90] as const;
export const PROMPT_SCAN_LIMITS = [100, 250, 500] as const;
export type PromptScanDays = (typeof PROMPT_SCAN_DAYS)[number];
export type PromptScanLimit = (typeof PROMPT_SCAN_LIMITS)[number];

export type PromptScan = {
  createdAt: string;
  prompt: string;
  negativePrompt: string | null;
  /** Highest first. */
  scores: { label: string; score: number }[];
};
