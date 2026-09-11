/** Run `task` over each item with at most `concurrency` in flight, index-cursor style. `task` owns its
 *  own errors — a rejection here aborts the whole pool, so per-item handling must not throw. */
export async function pool<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
