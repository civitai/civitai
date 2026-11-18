import type { SubmitFunction } from '@sveltejs/kit';
import { DISMISS_FAILED } from './notice-copy';

/** The one-off notice the player closed, while the server records it, and the one whose dismissal was refused. Keyed, so
 * closing one notice never hides a later one. */
export type DismissState = { closed: string | null; failed: string | null };

/** Gone at once; the dismissal is recorded in the background. */
export function closeDismiss(state: DismissState, key: string) {
  state.closed = key;
}

/** The dismissal's answer. A refused or lost one brings the notice back, with its error, for the player to press again. */
export function settleDismiss(state: DismissState, key: string, stored: boolean) {
  state.failed = stored ? null : key;
  if (!stored && state.closed === key) state.closed = null;
}

/** Runs whenever the load sends another notice or none; the same notice sent again later shows again. */
export function syncDismiss(state: DismissState, key: string | null) {
  if (state.closed !== key) state.closed = null;
  if (state.failed !== key) state.failed = null;
}

/** The one answer to "is this notice up". */
export const dismissShowing = (key: string | null, state: DismissState) =>
  key !== null && state.closed !== key;

/** The refused dismissal's error belongs to its own notice; the action's `form` outlives it, as votes post outside it. */
export const dismissFailedOn = (state: DismissState, key: string | null) =>
  key !== null && state.failed === key;

type LostAnswer = { type: 'failure'; status: number; data: Record<string, unknown> };

/**
 * `use:enhance` for a one-off dismissal: hides the notice on submit and never waits on the page's reload, which on /play
 * re-runs the whole load. A refused answer brings it back with the action's error; a lost one with `DISMISS_FAILED` and
 * the action's `failure` flag, instead of the error page.
 */
export function optimisticDismiss(opts: {
  state: DismissState;
  key: () => string | null;
  failure: Record<string, unknown>;
  /** `applyAction`, passed in so the helper runs outside SvelteKit. */
  apply: (result: LostAnswer) => Promise<void>;
}): SubmitFunction {
  return () => {
    const key = opts.key();
    if (key) closeDismiss(opts.state, key);
    return async ({ result, update }) => {
      const stored = result.type === 'success' || result.type === 'redirect';
      if (key) settleDismiss(opts.state, key, stored);
      if (result.type === 'error') {
        await opts.apply({
          type: 'failure',
          status: 500,
          data: { message: DISMISS_FAILED, ...opts.failure },
        });
      } else if (stored) {
        void update();
      } else {
        await update();
      }
    };
  };
}
