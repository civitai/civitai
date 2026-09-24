// "Something is preventing the verification check from running in this browser" is a claim about the
// USER'S environment, and the evidence available when the invisible widget misses its deadline does not
// support it. No token — and no `turnstile` global — is exactly what a SLOW connection looks like: the
// Cloudflare api.js tag is `async defer`, so at the deadline it may simply not have executed yet.
// Concluding from that first look tells a user whose login completes a second later that it cannot
// complete at all, because the script then lands and the invisible widget auto-solves.
//
// So absence is never concluded from one look. `probeTurnstile` takes a second one after a grace period,
// by which time a slow script has arrived and a blocked one has not. An explicit Turnstile error callback
// is a different kind of evidence — the widget reporting its own failure — and callers act on that
// directly rather than coming through here.

/** How long the second look waits. Covers the tail of a slow script fetch without stranding a user. */
export const TURNSTILE_SCRIPT_GRACE_MS = 5000;

export type TurnstileProbe = {
  /** Whether the Turnstile global is present. Called again at the second look. */
  scriptPresent: () => boolean;
  /** Whether a widget produced a token meanwhile — a token falsifies the question entirely. */
  tokenArrived: () => boolean;
  /** The script is here. */
  onScriptPresent: () => void;
  /** The script is still absent after the grace period. */
  onScriptAbsent: () => void;
  graceMs?: number;
};

/**
 * Resolve whether Turnstile's script is present, and return a teardown that cancels a pending second
 * look. `onScriptPresent` can fire synchronously; `onScriptAbsent` never can — that is the invariant
 * the whole module exists for.
 */
export function probeTurnstile(probe: TurnstileProbe): () => void {
  if (probe.scriptPresent()) {
    probe.onScriptPresent();
    return () => {};
  }
  const timer = setTimeout(() => {
    if (probe.tokenArrived()) return;
    if (probe.scriptPresent()) probe.onScriptPresent();
    else probe.onScriptAbsent();
  }, probe.graceMs ?? TURNSTILE_SCRIPT_GRACE_MS);
  return () => clearTimeout(timer);
}
