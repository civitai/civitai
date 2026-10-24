/**
 * Run a script's `main`, DRAIN stdout and stderr, then exit explicitly: 0 on success, 1 on
 * failure. Shared by the scripts that must exit on their own (a server-graph import leaves a
 * handle open — redis pings, a Flipt config poller — so the event loop never empties), so
 * the drain-before-exit rule lives in one place.
 *
 * 🔴 THE DRAIN IS NOT OPTIONAL. `process.exit()` does NOT wait for pending async writes, and
 * stdout to a PIPE is async: exiting straight after a large `console.log` TRUNCATES the
 * output whenever the reader is slower than the writer. Measured nondeterministic — see
 * `runAsScript` in scripts/label-resource-insights.ts for the replications and why the
 * figures are kept — and redirecting to a FILE is unaffected, which is what makes it easy to
 * miss. So the drain runs on every path, success and failure alike.
 *
 * `exit` and `flush` are injectable so a test can assert the ORDER (a drain after the exit
 * would be inert) without a real `process.exit` killing the test worker. Both defaults are
 * the production binding.
 */
export async function runScriptAndExit(
  run: () => Promise<void>,
  exit: (code: number) => void = process.exit,
  flush: () => Promise<void> = drainStdio
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(error);
    await flush();
    exit(1);
    return;
  }
  await flush();
  exit(0);
}

/**
 * Wait for stdout AND stderr to drain. Empty writes settle after pending ones.
 *
 * Exported so a test can hold the two write callbacks and watch this WAIT for them: a version
 * that issued the empty writes without awaiting them would satisfy every write assertion
 * and still let `process.exit` run before the pipe has flushed.
 */
export async function drainStdio(): Promise<void> {
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
}
