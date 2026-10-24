import {
  holdSameReasonRemovals,
  type ApprovedImageAppeal,
  type HeldRemoval,
  type RemovalRequest,
} from '@civitai/db-queries/image-removal-confirmation';
import { VIOLATION_TYPES } from '$lib/violations';
import { getClickhouse } from './clickhouse';
import { dbWrite } from './db';

export type { HeldRemoval };

// 'other' says nothing about what the image showed, so two removals filed under it cannot be told apart.
const COMPARABLE_REASONS: ReadonlySet<string> = new Set(
  VIOLATION_TYPES.filter((v) => v !== 'other')
);

/**
 * Holds each removal that repeats the reason the image's approved appeal overturned, for a moderator
 * with `image.removal.confirm` to decide on /images/re-removals. Returns the ids to remove now.
 */
export function holdRemovals(requests: RemovalRequest[], requestedById: number, source: string) {
  return holdSameReasonRemovals({
    db: dbWrite,
    requests,
    requestedById,
    source,
    knownReasons: COMPARABLE_REASONS,
    clickhouse: (query, ...values) => getClickhouse().$query(query, ...values),
  });
}

export type ApprovedAppealBadge = {
  approvedAt: Date;
  approvedByUsername: string | null;
  removalLabel: string | null;
} | null;

/** What a card shows of an image's approved appeal: history, not current state. */
export const approvedAppealOf = (appeal: ApprovedImageAppeal | undefined): ApprovedAppealBadge =>
  appeal
    ? {
        approvedAt: appeal.approvedAt,
        approvedByUsername: appeal.approvedByUsername,
        removalLabel: appeal.removalLabel,
      }
    : null;

/** A held removal as the main app's `/api/mod/remove-images` reports it. */
export type HeldSummary = {
  imageId: number;
  created: boolean;
  approvedAt: Date | string;
  approvedByUsername: string | null;
};

export const toHeldSummary = ({ imageId, created, appeal }: HeldRemoval): HeldSummary => ({
  imageId,
  created,
  approvedAt: appeal.approvedAt,
  approvedByUsername: appeal.approvedByUsername,
});

/** Said beside a held removal whose strike or flag was skipped: confirming does not apply them. */
export const HELD_FOLLOW_UPS_NOTE =
  'Strikes and flags were not applied to the held images; apply them once the removal is confirmed.';

/** What the removing moderator is told when a removal is held instead of applied. */
export function heldRemovalMessage(held: (HeldRemoval | HeldSummary)[]): string {
  if (!held.length) return '';
  if (held.length > 1)
    return `${held.length} images were not removed: each had an appeal approved for the same removal, so a second moderator must confirm. They are on Re-removals.`;
  const { imageId, created, approvedAt, approvedByUsername } =
    'appeal' in held[0] ? toHeldSummary(held[0]) : held[0];
  const by = approvedByUsername ? ` by ${approvedByUsername}` : '';
  const when = new Date(approvedAt).toISOString().slice(0, 10);
  return `Image ${imageId} was not removed: its appeal was approved on ${when}${by}, so a second moderator must confirm. ${
    created ? 'Sent to' : 'Already waiting on'
  } Re-removals.`;
}
