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

export type EarlyAccessConfig = {
  timeframe: number;
  chargeForDownload: boolean;
  downloadPrice?: number;
  chargeForGeneration: boolean;
  generationPrice?: number;
  generationTrialLimit: number;
  donationGoalEnabled: boolean;
  donationGoal?: number;
  freeGeneration?: boolean;
};
