// Permanent pay-for-access caps (CU 868ke4949). Shared because two surfaces set permanent access — the onsite
// model-version form and Creator Studio — and they must agree on the limit. The server-side assertion in the
// main app is the enforcement point; these constants also drive the "X of Y set" capacity hints in both UIs.

export const PERMANENT_ACCESS_LIMIT_BY_TIER: Record<string, number> = {
  bronze: 3,
  silver: 10,
  gold: Infinity,
};

/** Concurrent permanent-access versions allowed for a Creator-Program tier. 0 = not permitted (no/free tier). */
export function maxPermanentAccessModels(tier: string | null | undefined): number {
  return tier ? PERMANENT_ACCESS_LIMIT_BY_TIER[tier] ?? 0 : 0;
}
