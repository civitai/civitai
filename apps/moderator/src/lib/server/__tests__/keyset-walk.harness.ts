type Page<C> = { items: { id: number }[]; nextCursor?: C | null };

/**
 * Follows `nextCursor` from the first page and returns every id served, in order.
 *
 * Bounded: a cursor that stops advancing must fail the caller's assertion, not hang the run.
 */
export async function walkPages<C>(
  fetchPage: (cursor: C | undefined) => Promise<Page<C>>,
  maxPages = 12
): Promise<number[]> {
  const seen: number[] = [];
  let cursor: C | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    seen.push(...result.items.map((i) => i.id));
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
  }
  return seen;
}
