import type { Prisma } from '@prisma/client';
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
