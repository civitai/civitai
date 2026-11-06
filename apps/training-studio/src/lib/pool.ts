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

/** Resolve after `ms`, or reject with an AbortError as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Aborted', 'AbortError');
    if (signal.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    // A poll loop calls this once per interval on the same signal, so a listener left behind on
    // every timeout would pile up for the life of the poll.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
