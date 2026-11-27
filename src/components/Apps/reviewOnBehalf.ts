/**
 * The moderator review's STAFF ON-BEHALF line (pure, React-free), from the request's
 * `fileSummary.onBehalf` ({@link readOnBehalf}): the request's submitter is Civitai staff, and it
 * was filed for the app's owner.
 */
import { readOnBehalf } from '~/shared/utils/publish-request-on-behalf';

export const ON_BEHALF_LABEL = 'Staff submission';

export type ReviewOnBehalfLine = { heading: string; value: string };

const who = (username: string | null, userId: number | null) =>
  username ?? (userId !== null ? `user ${userId}` : 'an unknown account');

/** The line to show, or `null` when the request was not a staff submit on the owner's behalf. */
export function reviewOnBehalfLine(fileSummary: unknown): ReviewOnBehalfLine | null {
  const rec = readOnBehalf(fileSummary);
  if (!rec) return null;
  return {
    heading: ON_BEHALF_LABEL,
    value:
      `submitted by ${who(rec.staffUsername, rec.staffUserId)} for ` +
      `${who(rec.ownerUsername, rec.ownerUserId)} (platform update ${rec.platformUpdateId})`,
  };
}
