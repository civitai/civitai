/** The rating guide on /play: reopened from the Guide button, and closed by the player while the server records it. */
export type GuideState = { reopened: boolean; dismissed: boolean };

/** `first` is the load's first-visit guide (`showGuide`). */
export const guideShowing = (first: boolean, state: GuideState) =>
  state.reopened || (first && !state.dismissed);

export function openGuide(state: GuideState) {
  state.reopened = true;
}

/** "I understand": gone at once; the dismissal is recorded in the background. Returns the state to restore if it is refused. */
export function closeGuide(state: GuideState): GuideState {
  const before = { ...state };
  state.reopened = false;
  state.dismissed = true;
  return before;
}

/** The dismissal's answer. A refused or lost one brings the guide back, with its error, for the player to press again. */
export function settleGuide(state: GuideState, stored: boolean, before: GuideState) {
  if (!stored) Object.assign(state, before);
}
