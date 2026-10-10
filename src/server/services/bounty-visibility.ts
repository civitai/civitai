import type { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { Availability } from '~/shared/utils/prisma/enums';

export type BountyViewer = { id?: number; isModerator?: boolean } | null | undefined;

export function canViewBounty(
  bounty: { availability: Availability; userId: number | null },
  viewer: BountyViewer
): boolean {
  if (bounty.availability !== Availability.Private) return true;
  if (viewer?.isModerator) return true;
  return !!viewer?.id && viewer.id === bounty.userId;
}

export function bountyVisibilityWhere(viewer: BountyViewer): Prisma.BountyWhereInput {
  if (viewer?.isModerator) return {};
  const OR: Prisma.BountyWhereInput[] = [{ availability: { not: Availability.Private } }];
  if (viewer?.id) OR.push({ userId: viewer.id });
  return { OR };
}

export async function assertBountyVisible(
  target: { bountyId: number } | { entryId: number },
  viewer: BountyViewer
) {
  if (viewer?.isModerator) return;
  const bounty =
    'bountyId' in target
      ? await dbRead.bounty.findUnique({
          where: { id: target.bountyId },
          select: { availability: true, userId: true },
        })
      : (
          await dbRead.bountyEntry.findUnique({
            where: { id: target.entryId },
            select: { bounty: { select: { availability: true, userId: true } } },
          })
        )?.bounty;
  if (bounty && !canViewBounty(bounty, viewer)) throw throwNotFoundError();
}
