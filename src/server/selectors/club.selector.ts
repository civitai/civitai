import { Prisma } from '@prisma/client';

import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from './image.selector';

export const clubMembershipDetailSelect = Prisma.validator<Prisma.ClubMembershipSelect>()({
  id: true,
  startedAt: true,
  nextBillingAt: true,
  unitAmount: true,
  expiresAt: true,
  cancelledAt: true,
  billingPausedAt: true,
  currency: true,
  downgradeClubTierId: true,
  user: {
    select: userWithCosmeticsSelect,
  },
  club: {
    select: {
      id: true,
      name: true,
    },
  },
  clubTier: {
    select: {
      id: true,
      name: true,
      unitAmount: true,
      currency: true,
      clubId: true,
      oneTimeFee: true,
      coverImage: {
        select: imageSelect,
      },
    },
  },
  downgradeClubTier: {
    select: {
      id: true,
      name: true,
      unitAmount: true,
      currency: true,
      coverImage: {
        select: imageSelect,
      },
    },
  },
});
