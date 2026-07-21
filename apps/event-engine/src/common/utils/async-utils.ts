/**
 * Creates an async batcher that collects items and flushes them in batches.
 * Useful for batching document updates to Meilisearch or other batch operations.
 *
 * @param batchSize - Maximum number of items to batch before flushing
 * @param flushFn - Async function to process batched items
 * @returns Object with enqueue and flush methods
 */
export function createAsyncBatcher<T>(
  batchSize: number,
  flushFn: (items: T[]) => Promise<void>
) {
  const buffer: T[] = [];
  let chain = Promise.resolve();

  async function doFlush() {
    if (buffer.length === 0) return;
    const toFlush = buffer.splice(0, buffer.length);
    await flushFn(toFlush).catch(console.error);
  }

  const enqueue = (items: T[]) => {
    chain = chain
      .then(async () => {
        buffer.push(...items);
        if (buffer.length >= batchSize) {
          await doFlush();
        }
      })
      .catch(console.error);
  };

  const flush = async () => {
    await chain; // waits for all enqueued flushes
    await doFlush(); // flush anything remaining
  };

  return { enqueue, flush };
}

/**
 * Runs async tasks with limited concurrency.
 * Each task is a function returning a Promise.
 *
 * @param tasks - Array of task functions
 * @param concurrency - Maximum number of concurrent tasks
 * @returns Promise resolving to array of results
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < tasks.length) {
      const i = currentIndex++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        console.error(`Task ${i} failed:`, err);
        // Optional: rethrow if you want failure to stop execution
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
    worker()
  );

  await Promise.all(workers);
  return results;
}
