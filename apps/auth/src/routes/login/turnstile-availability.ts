// Cloudflare's api.js is loaded `async defer`, so "no token, and no `turnstile` global" at a deadline is
// what a SLOW fetch looks like exactly as much as a blocked one. Absence is therefore never concluded
// from a single look: a verdict about the user's environment waits for a second one. An explicit
// Turnstile error callback is different evidence and does not come through here.

/** How long the second look waits. */
export const TURNSTILE_SCRIPT_GRACE_MS = 5000;

/**
 * Run `decide` one grace period from now, unless a token turns up first — a token falsifies any verdict
 * about the check being unable to run. Returns a teardown that cancels the pending decision.
 */
export function decideAfterGrace(opts: {
  tokenArrived: () => boolean;
  decide: () => void;
  graceMs?: number;
}): () => void {
  const timer = setTimeout(() => {
    if (opts.tokenArrived()) return;
    opts.decide();
  }, opts.graceMs ?? TURNSTILE_SCRIPT_GRACE_MS);
  return () => clearTimeout(timer);
}

export type TurnstileProbe = {
  /** Whether the Turnstile global is present. Called again at the second look. */
  scriptPresent: () => boolean;
  tokenArrived: () => boolean;
  onScriptPresent: () => void;
  onScriptAbsent: () => void;
  graceMs?: number;
};

/**
 * Resolve whether Turnstile's script is here. `onScriptPresent` may fire synchronously; `onScriptAbsent`
 * can only ever be reached from the second look.
 */
export function probeTurnstile(probe: TurnstileProbe): () => void {
  if (probe.scriptPresent()) {
    probe.onScriptPresent();
    return () => {};
  }
  return decideAfterGrace({
    tokenArrived: probe.tokenArrived,
    decide: () => (probe.scriptPresent() ? probe.onScriptPresent() : probe.onScriptAbsent()),
    graceMs: probe.graceMs,
  });
}
