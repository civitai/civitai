import { isLiveStatus } from './snapshot';

/** Whether a write closed the ticket out: it asked for a status that ends it and the server says the change landed. */
export const closedOut = (data: Record<string, unknown> | undefined, requested: number | null) =>
  requested !== null && data?.statusChanged === true && !isLiveStatus(requested);
