// Shared (client + server) early-access shape and UI constraints. The server-only
// write client lives in $lib/server/monetization/early-access.ts; keep this file
// free of server imports so the editor UI can import it too.
//
// Constraints mirror the main app's paid-access form (formEarlyAccessConfigSchema) — UI hints only;
// the /api/v1/model-versions/early-access endpoint is the source of truth.
export const MIN_ACCESS_PRICE = 100;
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

// How many versions can be in early access *at the same time* — mirrors EARLY_ACCESS_CONFIG.scoreQuantityUnlock.
// Separate from the duration unlock above: score gates both how long and how many. 30-day flag tier omitted.
export const EARLY_ACCESS_QUANTITY_UNLOCK: ReadonlyArray<readonly [number, number]> = [
  [40000, 1],
  [65000, 2],
  [90000, 4],
  [125000, 6],
  [200000, 8],
  [250000, 20],
];

// Concurrent early-access slots the given models score unlocks. 0 = early access unavailable.
export function earlyAccessQuantityForScore(modelsScore: number): number {
  let quantity = 0;
  for (const [score, unlocked] of EARLY_ACCESS_QUANTITY_UNLOCK) {
    if (modelsScore >= score) quantity = unlocked;
  }
  return quantity;
}

// Per-tier paid-access caps. In @civitai/buzz because the onsite model-version form sets access too, and the
// main app enforces the caps server-side.
export { maxPermanentAccessModels, maxPaidAccessPrice } from '@civitai/buzz';

export type EarlyAccessConfig = {
  timeframe: number;
  permanent?: boolean;
  // "Price for access" — buying it unlocks download + generation (the bundle). Required when gating.
  accessPrice?: number;
  // Optional cheaper generation-only tier; defaults to the access price when unset.
  generationPrice?: number;
  // Free generations a non-buyer gets before purchase is required.
  freePreviewGenerations: number;
  donationGoalEnabled: boolean;
  donationGoal?: number;
};
