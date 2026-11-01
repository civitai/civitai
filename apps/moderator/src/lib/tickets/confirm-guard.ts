import type { SubmitFunction } from '@sveltejs/kit';

/** Enter in a text field submits the form without the confirm button; only that button's submit may go through. */
export function cancelUnlessConfirming(isConfirming: () => boolean) {
  return ({ cancel }: Parameters<SubmitFunction>[0]) => {
    if (!isConfirming()) cancel();
  };
}
