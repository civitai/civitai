// Newest-first ordering for the content tabs. `createdAt` is an ISO string; one that is missing (an article row
// without a timestamp) sorts last rather than first, and `id` breaks ties so equal timestamps keep a stable
// order across reloads instead of shuffling.
export function recentFirst<T extends { createdAt: string | null }>(
  rows: readonly T[],
  id: (row: T) => number
): T[] {
  const at = (r: T) => (r.createdAt ? Date.parse(r.createdAt) : Number.NEGATIVE_INFINITY);
  return [...rows].sort((a, b) => {
    const byTime = at(b) - at(a);
    // -Infinity - -Infinity is NaN, which a comparator must not return.
    return byTime || id(b) - id(a) || 0;
  });
}

// Items created on or between two inclusive 'YYYY-MM-DD' UTC days, newest first, at most `cap`.
export function recentInRange<T extends { createdAt: string | null }>(
  rows: readonly T[],
  from: string,
  to: string,
  id: (row: T) => number,
  cap = 100
): T[] {
  const inRange = rows.filter(
    (r) => r.createdAt && r.createdAt.slice(0, 10) >= from && r.createdAt.slice(0, 10) <= to
  );
  return recentFirst(inRange, id).slice(0, cap);
}
