import { TRPCError } from '@trpc/server';

import { dbWrite } from '~/server/db/client';
import type { AppListingModerationAction } from '~/server/schema/blocks/offsite-moderation.schema';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

export const MODERATOR_EDIT_ACTION = 'moderator-edit' satisfies AppListingModerationAction;

export type ModeratorEditSurface = 'details' | 'media' | 'revision';

const SURFACE_REASON: Record<ModeratorEditSurface, string> = {
  details: "A moderator edited this listing's details.",
  media: "A moderator edited this listing's store media.",
  revision: 'A moderator submitted a revision of this listing for review.',
};

/**
 * Audit row for a moderator editing a listing they hold no seat on. Call it BEFORE the
 * write: until the action CHECK is widened the insert fails, which refuses the edit rather
 * than letting it land unrecorded. A shadow revision is recorded on its parent, where the
 * listing's history is read.
 */
export async function recordModeratorListingEdit(args: {
  appListingId: string;
  actorUserId: number;
  surface: ModeratorEditSurface;
}): Promise<void> {
  const listing = await dbWrite.appListing.findUnique({
    where: { id: args.appListingId },
    select: { id: true, slug: true, revisionOf: { select: { id: true, slug: true } } },
  });
  if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });
  const target = listing.revisionOf ?? listing;
  await dbWrite.appListingModerationEvent.create({
    data: {
      id: newAppListingModerationEventId(),
      appListingId: target.id,
      slug: target.slug,
      action: MODERATOR_EDIT_ACTION,
      actorUserId: args.actorUserId,
      reason: SURFACE_REASON[args.surface],
      detail: args.surface,
    },
  });
}
