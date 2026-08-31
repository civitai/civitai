/**
 * A DETERMINISTIC foothold inside React's commit→passive-effect window, for the
 * browser tier.
 *
 * ── WHAT WINDOW, AND WHY IT NEEDS REPRODUCING ───────────────────────────────────
 *
 * A host component gates a postMessage handler on a piece of state. React writes
 * commit-time output (a DOM attribute) during the COMMIT, but the `useEffect` that
 * re-registers the handler with the fresh state is a PASSIVE effect, flushed later.
 * A message arriving in between meets the PREVIOUS render's closure. Any guard for
 * that bug has to post its message inside the window, on purpose, every run.
 *
 * ── TWO OBVIOUS APPROACHES, BOTH MEASURED, BOTH WRONG ───────────────────────────
 *
 * 1. `MutationObserver` on the attribute. Its callback is a MICROTASK: it runs when
 *    the JS stack unwinds, i.e. at the END of the whole scheduler task. React's work
 *    loop keeps running callbacks inside that SAME MessageChannel task while
 *    `shouldYieldToHost()` is false, so the passive flush frequently happens BEFORE
 *    the checkpoint. Measured: a MutationObserver-driven guard killed its mutant
 *    2 / 2 / 3 times over three runs — each guard survived roughly one run in three.
 *    A guard that is a coin flip is not a regression test.
 *
 * 2. A SIBLING component with `useLayoutEffect`. Layout effects genuinely are ordered
 *    before the same commit's passive effects, so the ordering reasoning is sound —
 *    but the premise is not: the host's internal `setStatus` re-renders the HOST, not
 *    its sibling, so the sibling's layout effect never runs again after mount.
 *    Measured: exactly ONE layout tick, observing `data-block-ready="false"`, and the
 *    probe never fired at all.
 *
 * ── WHAT ACTUALLY WORKS: THE ATTRIBUTE WRITE ITSELF ─────────────────────────────
 *
 * React writes the attribute with `Element.prototype.setAttribute` during the
 * commit's MUTATION phase. Wrapping that method means the callback runs
 * SYNCHRONOUSLY, on React's own stack, at the exact instant the host publishes
 * readiness — strictly before the layout phase and therefore strictly before ANY of
 * this commit's passive effects. There is no scheduling involved, so there is
 * nothing to lose a race to: it is ordered by the call stack, not by a queue.
 *
 * That is deliberately invasive, and it is scoped accordingly: the patch is
 * installed for the duration of one drive and removed by the returned disposer,
 * which callers run in a `finally`.
 */

/**
 * Run `run()` exactly once, synchronously, the first time any element's
 * `data-block-ready` attribute is set to `"true"` — i.e. inside React's commit,
 * before this commit's passive effects flush.
 *
 * Returns a disposer that restores the original `setAttribute`. ALWAYS call it in a
 * `finally`: leaving a patched prototype behind would leak into every later test in
 * the file.
 */
export function onReadyAttributeWrite(run: () => void): () => void {
  const original = Element.prototype.setAttribute;
  let fired = false;
  Element.prototype.setAttribute = function patched(
    this: Element,
    name: string,
    value: string
  ): void {
    original.call(this, name, value);
    if (fired) return;
    if (name !== 'data-block-ready' || value !== 'true') return;
    fired = true;
    run();
  };
  return () => {
    Element.prototype.setAttribute = original;
  };
}
