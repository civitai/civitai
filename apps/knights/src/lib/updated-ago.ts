/** "Updated 3 min ago" for a board built at `builtAt`, as of `now` (both ms since the epoch). */
export function updatedAgo(builtAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - builtAt) / 60_000));
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
}
