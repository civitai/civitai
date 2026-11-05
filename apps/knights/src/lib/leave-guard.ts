import type { NavigationType } from '@sveltejs/kit';

/** A Watch is in progress from the day's first vote until it completes. */
export const watchInProgress = ({ votes, watchDone }: { votes: number; watchDone: boolean }) =>
  votes > 0 && !watchDone;

/**
 * What to do when the player tries to leave `/play`: `native` is a page unload, where cancelling makes the browser
 * ask; `confirm` is an in-app navigation, which the page has to ask about itself.
 */
export function leaveAction({
  inProgress,
  type,
  toPath,
}: {
  inProgress: boolean;
  type: NavigationType;
  toPath: string | null;
}): 'allow' | 'native' | 'confirm' {
  if (!inProgress) return 'allow';
  if (type === 'leave') return 'native';
  return toPath === '/play' ? 'allow' : 'confirm';
}
