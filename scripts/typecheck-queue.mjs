/**
 * Whether a `pnpm run typecheck` should go through the dev-server queue.
 *
 * Its own module rather than a function inside scripts/typecheck.mjs, because that file runs tsc
 * at import: nothing could load it to test this rule without starting a multi-minute typecheck.
 */

/** Whether the queue flag is set to something that means yes. */
function queueFlagSet(env) {
  return Boolean(env.CIVITAI_TEST_QUEUE) && !/^(0|false|off|no)$/i.test(env.CIVITAI_TEST_QUEUE);
}

/**
 * Whether a `pnpm run typecheck:apps` should go through the dev-server queue.
 *
 * Deliberately NOT the rule below. The root typecheck's extra exits are about ITS env seams
 * (`TYPECHECK_TSC_PATH`, `TYPECHECK_HEAP_MB`), and honouring them here would mean a seam exported
 * for a root-typecheck test silently un-queued the app typechecks too.
 */
export function typecheckAppsQueueDecision(args, env) {
  if (env.CI) return { queue: false, why: 'CI runs the app typechecks directly' };
  if (!queueFlagSet(env)) return { queue: false, why: 'CIVITAI_TEST_QUEUE is not set' };
  // Same rule as the two queued runs beside this one: any argument means a narrowed run, and
  // telling a cheap narrow one from an expensive one by parsing its flags is a guess.
  if (args.length > 0) return { queue: false, why: 'arguments narrow the run' };
  return { queue: true };
}

export function typecheckQueueDecision(args, env) {
  if (env.CI) return { queue: false, why: 'CI runs the typecheck directly' };
  if (!queueFlagSet(env)) {
    return { queue: false, why: 'CIVITAI_TEST_QUEUE is not set' };
  }
  // The typecheck tests drive scripts/typecheck.mjs through this seam with a stub tsc. On a machine
  // with the queue flag set they would otherwise queue behind real typechecks and run the REAL tsc
  // in the daemon's child, never the stub — each case minutes long and asserting on the wrong run.
  if (env.TYPECHECK_TSC_PATH) return { queue: false, why: 'the tsc test seam is in use' };
  // A queued run is spawned with the DAEMON's environment, not the caller's, so an override set
  // here would silently not apply — the caller asked for a heap size and would get the default.
  if (env.TYPECHECK_HEAP_MB) return { queue: false, why: 'a heap override does not reach a queued run' };
  // Any argument at all means a narrowed run (`-p tsconfig.scripts.json`, a single project). Same
  // rule as scripts/test-component-run.mjs and for the same reason: telling a cheap narrow tsc
  // invocation from an expensive one by parsing its flags is a guess, and queueing a cheap one
  // turns a quick check into a wait behind a full run.
  if (args.length > 0) return { queue: false, why: 'arguments narrow the run' };
  return { queue: true };
}
