const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops on a wall-clock deadline and reports the last observation, so a regression fails instead of hanging. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<{ done: true; value: T } | { done: false; observed: unknown }>,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    nudge?: { everyMs: number; run: () => Promise<unknown> };
  }
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastNudge = Date.now();
  let observed: unknown;
  while (Date.now() < deadline) {
    const r = await probe();
    if (r.done) return r.value;
    observed = r.observed;
    if (opts.nudge && Date.now() - lastNudge >= opts.nudge.everyMs) {
      await opts.nudge.run();
      lastNudge = Date.now();
    }
    await sleep(opts.intervalMs ?? 3_000);
  }
  throw new Error(
    `${label}: not reached within ${opts.timeoutMs}ms; last observed ${JSON.stringify(observed)}`
  );
}
