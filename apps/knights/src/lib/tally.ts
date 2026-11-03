const DAY_MS = 86_400_000;

/** The next UTC midnight, when the cached leaderboard is rebuilt. */
export const nextTallyAt = (now: Date): Date =>
  new Date(now.getTime() - (now.getTime() % DAY_MS) + DAY_MS);

/** Whole hours and minutes left, e.g. `6h 12m`; empty at or past the instant. */
export function formatTally(msLeft: number): string {
  if (msLeft <= 0) return '';
  const minutes = Math.floor(msLeft / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
