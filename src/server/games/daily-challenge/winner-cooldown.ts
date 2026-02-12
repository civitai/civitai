/**
 * Filter winner candidates by removing users who recently won.
 * Pure function — no DB imports, fully testable.
 */
export function filterRecentWinners<T extends { userId: number }>(
  entries: T[],
  recentWinnerUserIds: Set<number>
): T[] {
  const eligible = entries.filter((e) => !recentWinnerUserIds.has(e.userId));

  // Fallback: if ALL candidates are on cooldown, return the full pool.
  // Better to allow a repeat winner than to have no winners at all.
  if (eligible.length === 0 && entries.length > 0) {
    return entries;
  }

  return eligible;
}
