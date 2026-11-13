/**
 * Transaction-scoped advisory locks, in memory, for driving two requests through
 * `withChargeKeyLock` concurrently. A transaction run through `transaction(run, tx)` gets `tx`
 * plus a `$executeRaw` that, for `pg_advisory_xact_lock(hashtextextended(<key>, 0))`, waits until
 * no other open transaction holds `<key>`; every lock a transaction took is released when `run`
 * settles, as Postgres releases them at commit or rollback. Other raw statements are no-ops.
 *
 * What this cannot show is Postgres's own behaviour (the hash, `lock_timeout`): it tests that the
 * code takes the lock, on which key, and around which work.
 */
export function createFakeAdvisoryLocks() {
  const holders = new Map<string, Promise<void>>();
  const taken: string[] = [];
  let open = 0;

  async function transaction<T>(run: (tx: unknown) => Promise<T>, tx: Record<string, unknown>) {
    const mine: (() => void)[] = [];
    const $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('').includes('pg_advisory_xact_lock')) return 0;
      const key = String(values[0]);
      while (holders.has(key)) await holders.get(key);
      let release!: () => void;
      holders.set(key, new Promise<void>((resolve) => (release = resolve)));
      taken.push(key);
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
      open--;
      for (const release of mine) release();
    }
  }

  /** `open()`: transactions currently open, i.e. pooled connections held. */
  return { transaction, taken: () => [...taken], open: () => open };
}

/** Lets pending promise callbacks run, so a concurrent request reaches the point it waits at. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
