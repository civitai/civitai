import type { NavigationType } from '@sveltejs/kit';

export const watchInProgress = ({ votes, watchDone }: { votes: number; watchDone: boolean }) =>
  votes > 0 && !watchDone;

/** `native`: page unload, where cancelling makes the browser ask, so the page must not also confirm. */
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
