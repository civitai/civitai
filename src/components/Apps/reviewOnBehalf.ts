/**
 * The moderator review's STAFF ON-BEHALF line (pure, React-free), from the `fileSummary.onBehalf`
 * a staff submit of a platform update records (`app-platform-update-submit.service.ts`): the
 * request's submitter is Civitai staff, and it was filed for the app's owner.
 *
 * Written only by the server's own submit path, never from anything a client sent.
 */

export const ON_BEHALF_LABEL = 'Staff submission';

export type ReviewOnBehalfLine = { heading: string; value: string };

type OnBehalfRecord = {
  platformUpdateId?: unknown;
  staffUserId?: unknown;
  staffUsername?: unknown;
  ownerUserId?: unknown;
  ownerUsername?: unknown;
};

const who = (username: unknown, userId: unknown) =>
  typeof username === 'string' && username
    ? username
    : typeof userId === 'number'
    ? `user ${userId}`
    : 'an unknown account';

/** The line to show, or `null` when the request was not a staff submit on the owner's behalf. */
export function reviewOnBehalfLine(fileSummary: unknown): ReviewOnBehalfLine | null {
  if (!fileSummary || typeof fileSummary !== 'object') return null;
  const rec = (fileSummary as { onBehalf?: unknown }).onBehalf as OnBehalfRecord | undefined;
  if (!rec || typeof rec !== 'object') return null;
  const update =
    typeof rec.platformUpdateId === 'string' ? ` (platform update ${rec.platformUpdateId})` : '';
  return {
    heading: ON_BEHALF_LABEL,
    value: `submitted by ${who(rec.staffUsername, rec.staffUserId)} for ${who(
      rec.ownerUsername,
      rec.ownerUserId
    )}${update}`,
  };
}
