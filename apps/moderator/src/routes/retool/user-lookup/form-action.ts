import type { SubmitFunction } from '@sveltejs/kit';

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
}): SubmitFunction {
  return () => {
    opts.busy?.(true);
    return async ({ result, update }) => {
      await update({ reset: true, invalidateAll: false });
      if (result.type === 'success') opts.onSuccess?.();
      opts.busy?.(false);
    };
  };
}
