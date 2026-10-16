import {
  getLatestApprovedImageAppeals,
  holdSameReasonRemovals,
  type HeldRemoval,
  type RemovalRequest,
} from '@civitai/db-queries/image-removal-confirmation';
import { clickhouse } from '~/server/clickhouse/client';
import { ViolationType } from '~/server/common/enums';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { hasModeratorGrant } from '~/server/services/moderator-grants';

export type { HeldRemoval };

// 'other' says nothing about what the image showed, so two removals filed under it cannot be told apart.
const COMPARABLE_REASONS: ReadonlySet<string> = new Set(
  Object.values(ViolationType).filter((v) => v !== ViolationType.Other)
);

/**
 * Holds each removal that repeats the reason the image's approved appeal overturned, for a moderator
 * with `image.removal.confirm` to decide in the moderator app. Returns the ids to remove now. The
 * rule itself is `holdSameReasonRemovals`, shared with the moderator app's block.
 */
export function holdRemovals(requests: RemovalRequest[], requestedById: number, source: string) {
  return holdSameReasonRemovals({
    db: kyselyWrite,
    requests,
    requestedById,
    source,
    knownReasons: COMPARABLE_REASONS,
    clickhouse: clickhouse ? (query, ...values) => clickhouse!.$query(query, ...values) : undefined,
  });
}

/** Holders of `image.removal.confirm` are the second opinion, so their own re-removals apply. */
export function canConfirmReRemoval(user: { roles?: string[] }) {
  return hasModeratorGrant(user, 'image.removal.confirm');
}

/** The image's latest approved appeal, for the moderator about to remove it. Moderators only. */
export async function getApprovedImageAppeal(imageId: number) {
  const appeal = (await getLatestApprovedImageAppeals(kyselyRead, [imageId])).get(imageId);
  if (!appeal) return null;
  return {
    approvedAt: appeal.approvedAt,
    approvedByUsername: appeal.approvedByUsername,
    removalLabel: appeal.removalLabel,
  };
}

/** The held removals as the wire carries them: enough for the moderator to see why. */
export function heldRemovalSummary(held: HeldRemoval[]) {
  return held.map(({ imageId, created, appeal }) => ({
    imageId,
    created,
    approvedAt: appeal.approvedAt.toISOString(),
    approvedByUsername: appeal.approvedByUsername,
  }));
}
