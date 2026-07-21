// Shared (client + server) early-access shape and UI constraints. The server-only
// write client lives in $lib/server/monetization/early-access.ts; keep this file
// free of server imports so the editor UI can import it too.
//
// Constraints mirror the main app's modelVersionEarlyAccessConfigSchema — UI hints
// only; the /api/v1/model-versions/early-access endpoint is the source of truth.
export const MIN_DOWNLOAD_PRICE = 100;
export const MIN_GENERATION_PRICE = 50;
export const DEFAULT_GENERATION_TRIAL_LIMIT = 10;
export const MAX_GENERATION_TRIAL_LIMIT = 1000;

// Max early-access days unlock by the creator's *models* score — mirrors the main app's
// EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock (enforced by /api/v1/model-versions/early-access).
// The 30-day feature-flag tier is intentionally omitted here.
export const EARLY_ACCESS_SCORE_UNLOCK: ReadonlyArray<readonly [number, number]> = [
  [40000, 3],
  [65000, 5],
  [90000, 7],
  [125000, 9],
  [200000, 12],
  [250000, 15],
];

// Highest early-access duration (days) the given models score unlocks. 0 = early access unavailable.
export function earlyAccessDaysForScore(modelsScore: number): number {
  let days = 0;
  for (const [score, unlocked] of EARLY_ACCESS_SCORE_UNLOCK) {
    if (modelsScore >= score) days = unlocked;
  }
  return days;
}

// Permanent pay-for-access cap by Creator-Program tier (CU 868ke4949).
export const PERMANENT_ACCESS_LIMIT_BY_TIER: Record<string, number> = {
  bronze: 3,
  silver: 10,
  gold: Infinity,
};

export function maxPermanentAccessModels(tier: string | null | undefined): number {
  return tier ? (PERMANENT_ACCESS_LIMIT_BY_TIER[tier] ?? 0) : 0;
}

export type EarlyAccessConfig = {
  timeframe: number;
  permanent?: boolean;
  chargeForDownload: boolean;
  downloadPrice?: number;
  chargeForGeneration: boolean;
  generationPrice?: number;
  generationTrialLimit: number;
  donationGoalEnabled: boolean;
  donationGoal?: number;
  freeGeneration?: boolean;
};
