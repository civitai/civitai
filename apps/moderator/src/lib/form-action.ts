import type { SubmitFunction } from '@sveltejs/kit';

/**
 * A per-card queue action that marks its card before the server answers.
 *
 * `mark` applies the optimistic change and MUST return its undo — a required return type is what stops
 * the revert being forgotten, which is the whole failure this exists to prevent: a dim or a "handled"
 * tick left standing over a refusal makes the moderator's own record wrong, and the item they then skip
 * is the one that failed. It was hand-rolled on seven queues in three different shapes before this.
 *
 * Separate from `writeEnhancer` rather than an option on it: that one's `reset: true` clears the form,
 * and its `busy` disables a panel — both wrong for a grid where fifty cards each own a button.
 */
export function optimisticEnhancer(
  mark: (input: Parameters<SubmitFunction>[0]) => () => void,
  opts: { reload?: boolean } = {}
): SubmitFunction {
  return (input) => {
    const undo = mark(input);
    return async ({ result, update }) => {
      if (result.type !== 'success') undo();
      // `update()` applies the result either way — that is what puts a `fail()` payload into `form`, so
      // a refusal renders instead of looking like a success. Reloading is success-only: re-running the
      // page load after a refusal costs the query and changes nothing.
      await update({
        invalidateAll: result.type === 'success' ? opts.reload ?? false : false,
      });
    };
  };
}

// One enhance callback for every write on this page. Five panels previously shared a page-level
// callback that called `applyAction` alone, which does NOT reset the form and does NOT track a busy
// state — so after a successful send the textarea still held its text and the button was still live,
// and pressing it again sent a second notification.
//
// `update({ reset: true, invalidateAll: false })` applies the result AND clears the form. The
// `invalidateAll: false` is load-bearing: the default reruns `load`, which rebuilds the derived
// `account` promise and re-runs the 744M-row reaction scan on every write, including ones that change
// nothing it displays.
export function writeEnhancer(opts: {
  /** Runs only on success — bump the refresh counter, close the form, clear local state. */
  onSuccess?: () => void;
  busy?: (value: boolean) => void;
  /** Set ONLY when the page's own `load` data changes — a report queue, an identity row. Panels fed
   *  by `/api/*` must leave this off, or every write re-runs the whole page load behind them. */
  reload?: boolean;
}): SubmitFunction {
  return () => {
    opts.busy?.(true);
    return async ({ result, update }) => {
      await update({ reset: true, invalidateAll: opts.reload ?? false });
      if (result.type === 'success') opts.onSuccess?.();
      opts.busy?.(false);
    };
  };
}
