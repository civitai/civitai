/**
 * A value that must not hold up the request that needs it — for an aggregate whose query has no index
 * of its own and whose caller would rather show nothing than wait.
 *
 * The race does NOT cancel the query: a timed-out call still holds its pool connection for its full
 * duration. Fine for a badge that runs once a minute behind a cache; not fine per-request.
 */
export const bounded = async <T>(run: () => Promise<T>, ms = 3_000): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `fn` over `items`, at most `concurrency` at a time, for at most `budgetMs` in total. A slot whose item
 * did not finish in time — or whose call rejected — is `undefined`: the caller decides what an unanswered
 * item means, and must not read it as an answer. Nothing new starts after the deadline.
 *
 * A rejection is held to its own slot rather than failing the whole map: letting it reject would end
 * this call (and clear the deadline) while the other workers kept starting calls with no deadline left.
 *
 * Like `bounded`, abandoning a call does not cancel it: an in-flight request runs to its own timeout.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  { concurrency, budgetMs }: { concurrency: number; budgetMs: number }
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
  });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const call = fn(items[i]).then(
        (value) => ({ value }),
        () => ({ value: undefined })
      );
      const outcome = await Promise.race([call, deadline]);
      if (outcome === 'expired') return;
      results[i] = outcome.value;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  return results;
}

/**
 * Whether `test` holds for ANY item, asked at most `concurrency` at a time for at most `budgetMs`.
 * Answers at the first `true` — without waiting for calls still in flight — and starts nothing after
 * it. `false` means none answered `true` in time, not that none would have. A rejected call counts as
 * not `true`.
 */
export async function someBounded<T>(
  items: readonly T[],
  test: (item: T) => Promise<boolean>,
  { concurrency, budgetMs }: { concurrency: number; budgetMs: number }
): Promise<boolean> {
  let found = false;
  let timer: NodeJS.Timeout | undefined;
  let announce: () => void = () => {};
  const foundOne = new Promise<void>((resolve) => (announce = resolve));
  const deadline = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
  });
  let next = 0;
  const worker = async () => {
    while (!found && next < items.length) {
      const call = test(items[next++]).catch(() => false);
      const outcome = await Promise.race([call, deadline]);
      if (outcome === 'expired') return;
      if (outcome) {
        found = true;
        announce();
      }
    }
  };
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)),
      foundOne,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return found;
}
