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

/** The one answer to "is the What's new dialog up": the layout renders by it and /play blocks its keys by it. */
export const whatsNewShowing = (sent: boolean, state: DismissState) => sent && !state.hidden;

/** Once the load stops sending the copy, the flag that hid it goes too, so a later copy shows. */
export const forgetDismissal = (state: DismissState, sent: boolean) => {
  if (!sent) state.hidden = false;
};
