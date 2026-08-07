/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Paid-access writes go one-per-version through the main app's REST endpoint, so a bulk operation is N
 * round-trips. Sequentially that's minutes for a large selection — alexds9's script covered 346 versions —
 * and the spoke request times out long before it finishes. A bounded fan-out turns that into ~N/limit
 * waves without opening 346 sockets at the endpoint.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * How many main-app writes to keep in flight. Low enough not to look like a burst to the endpoint,
 * high enough that a few hundred versions finish inside a request.
 */
export const MAIN_APP_WRITE_CONCURRENCY = 10;
