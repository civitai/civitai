import type { SubmitFunction } from '@sveltejs/kit';

/**
 * A per-card queue action that marks its card before the server answers.
 *
 * `mark` applies the optimistic change and MUST return its undo — a required return type is what stops
 * the revert being forgotten, which is the whole failure this exists to prevent: a dim or a "handled"
 * tick left standing over a refusal makes the moderator's own record wrong, and the item they then skip
 * is the one that failed. It was hand-rolled on seven queues in three different shapes before this.
 *
 * Separate from `FormState` rather than an option on it: that one resets the form on success and holds
 * a single `submitting` flag — both wrong for a grid where fifty cards each own a button.
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
