import type { ActionResult, SubmitFunction } from '@sveltejs/kit';

/**
 * One form's submit state and the enhancer that fills it.
 *
 * Per form, not per page: SvelteKit's `form` prop is PAGE-level, so every panel saw every other panel's
 * failure and each had to filter by a `scope` the server stamped — miss the scope and a refusal
 * rendered in three panels, or in none. Holding the result here removes the routing question instead
 * of answering it, and the panel places the message wherever it belongs.
 */
export class FormState {
  /** The refusal from the last submit, or null. */
  error = $state<string | null>(null);
  /** True between submit and response — for disabling this form's own controls, not the page's. */
  submitting = $state(false);

  /**
   * @param opts.onSuccess Everything that follows a successful write: clearing this form's own state,
   * and the page's refresh where the panel displays data. REQUIRED, with `null` for a form that needs
   * neither — omitting it would leave the panel showing stale data after a write that worked, which is
   * the one failure here that surfaces no error.
   *
   * Receives what the ACTION returned. Worth reaching for when the server's answer differs from what
   * the form asked for — a bulk write that skipped rows, a count the server recomputed — because
   * reporting the request back to the operator instead of the result is a confirmation that can lie.
   * @param opts.reload Re-run the page `load` on success. Set ONLY when the page's own load data
   * changes: panels fed by `/api/*` refresh through `onSuccess`, and reloading them re-runs the whole
   * page query — including the account scan — behind every write.
   */
  constructor(
    private readonly opts: {
      onSuccess: ((data?: Record<string, unknown>) => void) | null;
      reload?: boolean;
      /**
       * Runs when the submit STARTS, before the server has answered.
       *
       * For the one thing `onSuccess` cannot do: read state that the response is about to replace.
       * `update({ invalidateAll })` is awaited before `onSuccess`, so by then the page's `load` has
       * re-run — a success handler reading `data` sees the NEW value. Anything that has to compare
       * against the old one (naming what a toggle just did, choosing the row to advance to) has to
       * capture it here.
       *
       * Receives `use:enhance`'s own argument, so a state shared by several forms can tell WHICH one
       * submitted (`action.search` is `?/approve`), and read what is being posted. Calling `cancel()`
       * stops the submit and leaves `submitting` false.
       */
      onSubmit?: (input: Parameters<SubmitFunction>[0]) => void;
      /**
       * For the rare form that must react to a FAILURE as well: a strike that recorded but could not
       * notify comes back as a failure whose row nonetheless exists, so the list still has to refetch.
       * Runs after `error` is set and after `onSuccess`.
       */
      onSettled?: (result: ActionResult) => void;
    }
  ) {}

  /**
   * Hand this to `use:enhance`. An arrow property, not a method: `use:enhance={state.enhance}` passes
   * the function by reference, and a prototype method would lose `this`.
   */
  readonly enhance: SubmitFunction = (input) => {
    // `onSubmit` runs BEFORE `submitting` is set, and a cancel returns without setting it. SvelteKit
    // does not invoke the response callback for a cancelled submit, so setting it first would leave the
    // form disabled for good.
    let cancelled = false;
    this.opts.onSubmit?.({
      ...input,
      cancel: () => {
        cancelled = true;
        input.cancel();
      },
    });
    if (cancelled) return;

    this.submitting = true;
    return async ({ result, update }) => {
      // Reset on success ONLY. Clearing the fields after a refusal throws away what the operator
      // typed, on the one path where they need it back to fix and resubmit.
      await update({
        reset: result.type === 'success',
        invalidateAll: this.opts.reload ?? false,
      });
      this.error =
        result.type === 'failure'
          ? (result.data?.error as string | undefined) ?? 'Something went wrong.'
          : null;
      if (result.type === 'success') this.opts.onSuccess?.(result.data);
      this.opts.onSettled?.(result);
      this.submitting = false;
    };
  };
}
