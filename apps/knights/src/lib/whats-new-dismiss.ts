import type { SubmitFunction } from '@sveltejs/kit';

/** The actions' own failure text, for when no answer comes back at all. */
export const DISMISS_FAILED = 'Could not close this. Try again.';

export type DismissState = { hidden: boolean; message: string | null };

/** Hides the "What's new" dialog on submit; brings it back if the action refuses or cannot be reached. */
export const dismissWhatsNew =
  (state: DismissState): SubmitFunction =>
  () => {
    state.hidden = true;
    state.message = null;
    return async ({ result, update }) => {
      if (result.type === 'error') {
        // update() would replace the page with the error screen; the dialog's own message line is enough.
        state.hidden = false;
        state.message = DISMISS_FAILED;
        return;
      }
      if (result.type === 'failure') state.hidden = false;
      await update();
    };
  };
