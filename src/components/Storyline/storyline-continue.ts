/**
 * Opens the "continue with a post you made" flow. The flow itself (its modal, the post picker,
 * the submit) is the storyline creator work; until it is on the integration branch this opener
 * is not ready and the end card hides the button rather than showing one that does nothing.
 * Once it lands, this becomes a re-export of `openStorylineContinueModal`, and the price the end
 * card shows must travel with it as `expectedPrice`, so a reader is never charged a price they
 * did not see.
 */
export const STORYLINE_CONTINUE_READY = false;

export function openStorylineContinue(props: { parentPostId: number }) {
  void props;
}
