/**
 * The two rules `scripts/queued-check.mjs` needs, in a module that runs no checks at import.
 *
 * Its own file for the same reason `typecheck-queue.mjs` is: the wrapper beside it spawns a real
 * suite at module scope, so nothing could load it to test these rules without paying for one.
 */

/** Whether the queue flag is set to something that means yes. */
function queueFlagSet(env) {
  return Boolean(env.CIVITAI_TEST_QUEUE) && !/^(0|false|off|no)$/i.test(env.CIVITAI_TEST_QUEUE);
}

/**
 * Whether a wrapped suite should go through the dev-server queue.
 *
 * Unlike `typecheck:apps`, an argument here narrows a run that CAN be narrowed - a filename, a
 * `--project`, a reporter - so the rule the unit suite uses transfers intact: a narrowed run is
 * cheap, and making it wait behind a full one pushes callers toward batching work into fewer,
 * bigger runs, which is the opposite of what the queue is for. The direct path forwards the
 * arguments, so nothing is discarded on the way.
 */
export function queuedCheckDecision(args, env) {
  if (env.CI) return { queue: false, why: 'CI runs the suite directly' };
  if (!queueFlagSet(env)) return { queue: false, why: 'CIVITAI_TEST_QUEUE is not set' };
  if (args.length > 0) return { queue: false, why: 'arguments narrow the run' };
  return { queue: true };
}

/**
 * What each wrapped lane runs when it is NOT going through the queue.
 *
 * `component` keeps its own runner rather than calling vitest here: that script pairs the run with
 * `assert-component-suite-ran.mjs`, which is what stops a browser project that collected nothing
 * from reporting as a pass. Losing that would be a silent hole exactly where the suite is least
 * able to complain.
 */
export const DIRECT_COMMANDS = {
  component: { cmd: 'node', args: ['scripts/test-component-run.mjs'] },
  packages: { cmd: 'pnpm', args: ['exec', 'vitest', 'run', '--project', '@civitai/*'] },
  apps: { cmd: 'pnpm', args: ['exec', 'vitest', 'run', '--project', 'app:*'] },
  geometry: { cmd: 'pnpm', args: ['exec', 'vitest', 'run', '--project', 'geometry'] },
  // `narrowedArgs` is the command to run INSTEAD when the caller named something. eslint takes its
  // target as a positional, so appending one to a command that already names `src/` lints both -
  // the caller waits for everything and gets their file checked as a side effect. vitest needs no
  // such variant: its positional filters the project rather than adding to it.
  lint: {
    cmd: 'pnpm',
    args: ['exec', 'eslint', 'src/', '--cache', '--cache-strategy', 'metadata'],
    narrowedArgs: ['exec', 'eslint', '--cache', '--cache-strategy', 'metadata'],
  },
  lintPackages: {
    cmd: 'pnpm',
    args: ['exec', 'eslint', 'packages', '--ext', '.ts'],
    narrowedArgs: ['exec', 'eslint', '--ext', '.ts'],
  },
};

/**
 * The exact command a lane runs directly, for the arguments it was given. Here rather than inline
 * in the wrapper because the wrapper spawns a suite at module scope, so nothing could load it to
 * check which base was chosen.
 */
export function directCommandFor(kind, args = []) {
  const direct = DIRECT_COMMANDS[kind];
  if (!direct) return null;
  // 🔴 EVERY argument must be a target, not merely one of them. Two rounds of this:
  //
  //   `args.length`                  -> `pnpm run lint --fix` dropped `src/` and handed eslint
  //                                     only flags, which lints ZERO files and exits 0.
  //   `args.some(a => !flag(a))`     -> `pnpm run lint --max-warnings 0` did the same, because
  //                                     `0` is a flag's VALUE and looks exactly like a path.
  //
  // Classifying argv is how both of those happened, so this does not try: the default target is
  // dropped only when the caller passed nothing but bare words, which cannot be a flag's value
  // because there is no flag. Anything with a flag in it keeps the default target and lints more
  // than asked, which is slow and correct - the failure this replaces was fast and wrong.
  const named = args.length > 0 && args.every((a) => !String(a).startsWith('-'));
  const base = named && direct.narrowedArgs ? direct.narrowedArgs : direct.args;
  return { cmd: direct.cmd, argv: [...base, ...args] };
}
