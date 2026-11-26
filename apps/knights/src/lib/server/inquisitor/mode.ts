import { skillChecks } from '../skill-check/runtime';

type Viewer = { isModerator?: boolean } | null | undefined;

/** Moderators are the Inquisitors, whether or not the in-game queue is on. */
export const isInquisitor = (user: Viewer): boolean => user?.isModerator === true;

/** The in-game queue is live for this viewer. `/play`, the header and `/home` all switch on this, so they cannot drift apart. */
export async function inquisitorQueueOpen(user: Viewer): Promise<boolean> {
  return isInquisitor(user) && (await skillChecks()).enabled;
}
