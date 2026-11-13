import type { Prisma } from '@prisma/client';
import { ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * A run's model still counts unless its owner deleted it: that delete means start over, so the run
 * page drops the link and Publish makes a fresh draft. A moderator's delete still counts, so it
 * can't be routed around (a NULL deletedBy counts as not the owner; a bare `<>` would drop it).
 * The model-status check and Publish's lookup must share this, or the page offers a Publish that
 * reopens the same model.
 */
export function studioModelNotOwnerDeleted(userId: number): Prisma.ModelWhereInput {
  return {
    OR: [
      { status: { not: ModelStatus.Deleted } },
      { deletedBy: { not: userId } },
      { deletedBy: null },
    ],
  };
}
