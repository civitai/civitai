import { Prisma } from '@prisma/client';

import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from './image.selector';

export const buzzWithdrawalRequestDetails = Prisma.validator<Prisma.BuzzWithdrawalRequestSelect>()({
  id: true,
  status: true,
  createdAt: true,
  metadata: true,
  platformFeeRate: true,
  requestedBuzzAmount: true,
  user: { select: userWithCosmeticsSelect },
  history: {
    select: {
      id: true,
      note: true,
      status: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
});

export const buzzWithdrawalRequestModerationDetails =
  Prisma.validator<Prisma.BuzzWithdrawalRequestSelect>()({
    ...buzzWithdrawalRequestDetails,
    buzzWithdrawalTransactionId: true,
    transferId: true,
    requestedToId: true,
    requestedToProvider: true,
    transferredAmount: true,
    platformFeeRate: true,
    history: {
      select: {
        id: true,
        note: true,
        status: true,
        metadata: true,
        createdAt: true,
        updatedBy: {
          select: userWithCosmeticsSelect,
        },
      },
      orderBy: { createdAt: 'desc' },
    },
  });
