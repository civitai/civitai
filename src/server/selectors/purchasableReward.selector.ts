import { Prisma } from '@prisma/client';

import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from './image.selector';

export const purchasableRewardDetails = Prisma.validator<Prisma.PurchasableRewardSelect>()({
  id: true,
  title: true,
  unitPrice: true,
  about: true,
  redeemDetails: true,
  termsOfUse: true,
  usage: true,
  availableFrom: true,
  availableTo: true,
  availableCount: true,
  archived: true,
  createdAt: true,
  addedBy: {
    select: userWithCosmeticsSelect,
  },
  coverImage: {
    select: imageSelect,
  },
  _count: {
    select: {
      purchases: true,
    },
  },
});

export const purchasableRewardDetailsModerator = Prisma.validator<Prisma.PurchasableRewardSelect>()(
  {
    ...purchasableRewardDetails,
    codes: true,
  }
);
