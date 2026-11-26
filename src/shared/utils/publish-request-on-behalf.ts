/**
 * The `fileSummary.onBehalf` record of a STAFF SUBMIT ON THE OWNER'S BEHALF, read back (pure).
 *
 * Written only by `submitVersion` when `app-platform-update-submit.service.ts` files a platform
 * update for an app's owner: the request's submitter (`submittedByUserId`) is the moderator, and
 * this names the owner it was filed for. Never written from anything a client sent.
 *
 * Read through {@link readOnBehalf} by the review-outcome notifications (the owner is told as well
 * as the submitting moderator) and the owner's submission lists (the request is the owner's work,
 * listed for them and labelled as a staff submission).
 */

export type OnBehalfRecord = {
  platformUpdateId: string;
  staffUserId: number | null;
  staffUsername: string | null;
  ownerUserId: number;
  ownerUsername: string | null;
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * The record, or `null` when the request was not a staff submit on the owner's behalf. A record
 * without its update id or its owner is treated as absent: nothing it would drive can be done
 * without them.
 */
export function readOnBehalf(fileSummary: unknown): OnBehalfRecord | null {
  if (!fileSummary || typeof fileSummary !== 'object') return null;
  const rec = (fileSummary as { onBehalf?: unknown }).onBehalf;
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const platformUpdateId = str(r.platformUpdateId);
  const ownerUserId = int(r.ownerUserId);
  if (!platformUpdateId || ownerUserId === null) return null;
  return {
    platformUpdateId,
    staffUserId: int(r.staffUserId),
    staffUsername: str(r.staffUsername),
    ownerUserId,
    ownerUsername: str(r.ownerUsername),
  };
}

/** What an owner-facing list carries for a staff submission: who filed it, and which update. */
export type StaffSubmission = { staffUsername: string | null; platformUpdateId: string };

/** The list label's projection of a request's `fileSummary`, or `null` for an ordinary submit. */
export function staffSubmissionOf(fileSummary: unknown): StaffSubmission | null {
  const rec = readOnBehalf(fileSummary);
  return rec ? { staffUsername: rec.staffUsername, platformUpdateId: rec.platformUpdateId } : null;
}

/** The label an owner-facing list shows beside a staff submission. */
export function staffSubmissionLabel(s: StaffSubmission): string {
  return `Staff submission by ${s.staffUsername ?? 'Civitai staff'} (platform update)`;
}

/**
 * `fileSummary` without its `onBehalf` record, every other key kept; anything else unchanged. For
 * a copy of a request that is NOT a staff submit on the owner's behalf (a moderator's
 * reset-to-pending clones the approved request as the OWNER's), so the staff label and the
 * reject-withdraws-the-update behaviour do not carry onto it.
 */
export function withoutOnBehalf(fileSummary: unknown): unknown {
  if (!fileSummary || typeof fileSummary !== 'object' || Array.isArray(fileSummary))
    return fileSummary;
  if (!('onBehalf' in fileSummary)) return fileSummary;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { onBehalf: _dropped, ...rest } = fileSummary as Record<string, unknown>;
  return rest;
}
