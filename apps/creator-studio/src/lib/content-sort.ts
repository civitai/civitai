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
