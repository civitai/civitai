/**
 * The `fileSummary.onBehalf` record of a STAFF SUBMIT ON THE OWNER'S BEHALF, read back (pure).
 *
 * Written by `submitVersion` when `app-platform-update-submit.service.ts` files a platform update
 * for an app's owner: the request's submitter (`submittedByUserId`) is the moderator, and this
 * names the owner it was filed for.
 */

import { APP_PLATFORM_UPDATE_SENDER } from '~/shared/constants/app-assistant.constants';

export type OnBehalfRecord = {
  platformUpdateId: string;
  staffUserId: number | null;
  staffUsername: string | null;
  ownerUserId: number;
  ownerUsername: string | null;
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** The raw `onBehalf` object, or `null` when there is none. */
function onBehalfObject(fileSummary: unknown): Record<string, unknown> | null {
  if (!fileSummary || typeof fileSummary !== 'object') return null;
  const rec = (fileSummary as { onBehalf?: unknown }).onBehalf;
  return rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : null;
}

/**
 * Whether the request is a staff submit on the owner's behalf at all: any `onBehalf` object
 * counts, including one {@link readOnBehalf} cannot fully parse. For the checks that must not
 * treat such a request as the owner's own (its approve ships no platform update; a pending one
 * refuses a second staff submit as a staff submission).
 */
export function hasOnBehalfRecord(fileSummary: unknown): boolean {
  return onBehalfObject(fileSummary) !== null;
}

/**
 * The record, or `null` when the request was not a staff submit on the owner's behalf. A record
 * without its update id or its owner is treated as absent: nothing it would drive can be done
 * without them.
 */
export function readOnBehalf(fileSummary: unknown): OnBehalfRecord | null {
  const r = onBehalfObject(fileSummary);
  if (!r) return null;
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

/**
 * What an owner-facing list carries for a staff submission: which update. Not the staff member:
 * the owner reads it as from {@link APP_PLATFORM_UPDATE_SENDER} (operator decision); moderator
 * views read the full record with {@link readOnBehalf}.
 */
export type StaffSubmission = { platformUpdateId: string };

/** The list label's projection of a request's `fileSummary`, or `null` for an ordinary submit. */
export function staffSubmissionOf(fileSummary: unknown): StaffSubmission | null {
  const rec = readOnBehalf(fileSummary);
  return rec ? { platformUpdateId: rec.platformUpdateId } : null;
}

/** The label an owner-facing list shows beside a staff submission. */
export const STAFF_SUBMISSION_LABEL = `Platform update submitted by ${APP_PLATFORM_UPDATE_SENDER}`;

/**
 * What a copy of a staff on-behalf request records in place of its `onBehalf`
 * (`fileSummary.stagedFromOnBehalf`): its bytes are still the staff build, so its approve must not
 * ship an update ({@link shipsNoPlatformUpdates}).
 */
export type StagedFromOnBehalf = { platformUpdateId: string | null };

function stagedFromOnBehalfObject(fileSummary: unknown): Record<string, unknown> | null {
  if (!fileSummary || typeof fileSummary !== 'object') return null;
  const rec = (fileSummary as { stagedFromOnBehalf?: unknown }).stagedFromOnBehalf;
  return rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : null;
}

/**
 * `fileSummary` for a copy of a request filed as the OWNER's (a moderator's reset-to-pending
 * clones the approved request): its `onBehalf` record is dropped, so the staff label, the
 * reject-withdraws-the-update behaviour and the owner notification do not carry onto it. When
 * there was one, `stagedFromOnBehalf` takes its place, because the bytes are still the staff
 * build. Every other key is kept (a `stagedFromOnBehalf` already there included); anything else is
 * returned unchanged.
 */
export function ownerCopyOf(fileSummary: unknown): unknown {
  if (!fileSummary || typeof fileSummary !== 'object' || Array.isArray(fileSummary))
    return fileSummary;
  if (!('onBehalf' in fileSummary)) return fileSummary;
  const rec = onBehalfObject(fileSummary);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { onBehalf: _dropped, ...rest } = fileSummary as Record<string, unknown>;
  if (!rec) return rest;
  const staged: StagedFromOnBehalf = { platformUpdateId: str(rec.platformUpdateId) };
  return { ...rest, stagedFromOnBehalf: staged };
}

/**
 * Whether approving the request ships NO platform update: its bytes are a staff build, either a
 * staff submit on the owner's behalf ({@link hasOnBehalfRecord}) or a copy of one
 * (`stagedFromOnBehalf`, {@link ownerCopyOf}). Only an owner's own build ships an update. Any
 * object under either key counts.
 */
export function shipsNoPlatformUpdates(fileSummary: unknown): boolean {
  return hasOnBehalfRecord(fileSummary) || stagedFromOnBehalfObject(fileSummary) !== null;
}
