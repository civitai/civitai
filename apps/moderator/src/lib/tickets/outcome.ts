import { isLiveStatus } from './snapshot';

/** True only when the server confirms the requested status landed and that status ends the ticket. */
export const closedOut = (data: Record<string, unknown> | undefined, requested: number | null) =>
  requested !== null && data?.statusChanged === true && !isLiveStatus(requested);
