import { ACTIONS, EVENTS, STATUS } from 'react-joyride';
import type { TourEndReason } from '~/utils/faro/tour';

/**
 * TARGET_NOT_FOUND is deliberately absent: folded in here it was identical to a
 * click on Next, which is how a dead `data-tour` attribute stayed invisible for
 * over a year. It gets its own branch in the callback.
 */
export const nextEvents: string[] = [EVENTS.STEP_AFTER];

export function tourTargetKey(target: unknown): string {
  if (typeof target !== 'string') return 'unknown';
  return /^\[data-tour="([^"]+)"\]$/.exec(target)?.[1] ?? target;
}

export function endReasonFor(status: string, action: string): TourEndReason {
  if (action === ACTIONS.CLOSE) return 'closed';
  return status === STATUS.SKIPPED ? 'skipped' : 'finished';
}
