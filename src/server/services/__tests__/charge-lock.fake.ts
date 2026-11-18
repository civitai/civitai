/**
 * Transaction-scoped advisory locks, in memory, for driving two requests through
 * `withChargeKeyLock` concurrently. A transaction run through `transaction(run, tx)` gets `tx`
 * plus a `$executeRaw` that, for `pg_advisory_xact_lock(hashtextextended(<key>, 0))`, waits until
 * no other open transaction holds `<key>`; every lock a transaction took is released when `run`
 * settles, as Postgres releases them at commit or rollback. Other raw statements go to `tx`'s own
 * `$executeRaw` when it has one (a record that runs its own UPDATE), and are no-ops otherwise.
 *
 * What this cannot show is Postgres's own behaviour (the hash, `lock_timeout`): it tests that the
 * code takes the lock, on which key, and around which work.
 */
export function createFakeAdvisoryLocks() {
  const holders = new Map<string, Promise<void>>();
  const taken: string[] = [];
  let open = 0;
  let onNextLock: (() => Promise<void> | void) | undefined;
  let expiredWhileRunning = 0;

  /**
   * `options.timeout` behaves like Prisma's interactive-transaction deadline: when it passes with
   * `run` still pending, the transaction is rolled back and its locks are released, while `run`
   * itself carries on (nothing cancels the work it is awaiting).
   */
  async function transaction<T>(
    run: (tx: unknown) => Promise<T>,
    tx: Record<string, unknown>,
    options?: { timeout?: number }
  ) {
    const mine: (() => void)[] = [];
    let settled = false;
    const releaseAll = () => {
      for (const release of mine.splice(0)) release();
    };
    const deadline =
      options?.timeout !== undefined
        ? setTimeout(() => {
            if (settled) return;
            expiredWhileRunning++;
            releaseAll();
          }, options.timeout)
        : undefined;
    const own = tx.$executeRaw as
      | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>)
      | undefined;
    const $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (!sql.includes('pg_advisory_xact_lock')) {
        const setup = sql.includes('set_config') || sql.includes('SET LOCAL');
        return own && !setup ? own(strings, ...values) : 0;
      }
      const key = String(values[0]);
      while (holders.has(key)) await holders.get(key);
      let release!: () => void;
      holders.set(key, new Promise<void>((resolve) => (release = resolve)));
      taken.push(key);
      const hook = onNextLock;
      onNextLock = undefined;
      await hook?.();
      mine.push(() => {
        holders.delete(key);
        release();
      });
      return 0;
    };
    open++;
    try {
      return await run({ ...tx, $executeRaw });
    } finally {
      settled = true;
      if (deadline) clearTimeout(deadline);
      open--;
      releaseAll();
    }
  }

  /** `open()`: transactions currently open, i.e. pooled connections held. */
  return {
    transaction,
    taken: () => [...taken],
    open: () => open,
    /** Transactions whose deadline passed while their work was still running (locks released). */
    expiredWhileRunning: () => expiredWhileRunning,
    /** Runs `fn` as the next lock is granted: what another request did just before this one got it. */
    onNextLock: (fn: () => Promise<void> | void) => {
      onNextLock = fn;
    },
  };
}

/** Lets pending promise callbacks run, so a concurrent request reaches the point it waits at. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
