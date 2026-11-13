/**
 * Splits a `limit + 1` keyset fetch into the page to show and the cursor for the next one.
 *
 * For a query paged with an EXCLUSIVE predicate (`id < cursor`, `id > cursor`): the cursor is the
 * last row shown. Taking it from the extra look-ahead row skips that row at every page boundary.
 */
export function takePage<T, C>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => C
): { items: T[]; nextCursor?: C } {
  if (limit < 1 || rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[limit - 1]) };
}
