import { Prisma, PurchasableRewardUsage } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  GetPaginatedPurchasableRewardsSchema,
  PurchasableRewardPurchase,
  PurchasableRewardUpsert,
} from '~/server/schema/purchasable-reward.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { createEntityImages } from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getPaginatedPurchasableRewards = async (
  input: GetPaginatedPurchasableRewardsSchema
) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.PurchasableRewardFindManyArgs['where'] = {};

  const items = await dbRead.purchasableReward.findMany({
    where,
    take,
    skip,
    select: {
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
      coverImage: {
        select: imageSelect,
      },
      _count: {
        select: {
          purchases: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.purchasableReward.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export const purchasableRewardUpsert = async ({
  userId,
  coverImage,
  ...input
}: PurchasableRewardUpsert & {
  userId: number;
}) => {
  const shouldCreateImage = coverImage && !coverImage.id;
  const [imageRecord] = shouldCreateImage
    ? await createEntityImages({
        userId,
        images: [coverImage],
      })
    : [];

  if (!input.id) {
    // Create:
    // Check that it has codes:
    if (!input.codes || input.codes.length === 0)
      throw throwBadRequestError('No codes/links provided. Please provide at least one code/link.');

    // Check that it has available count:
    if (input.availableCount !== undefined && input.availableCount <= 0)
      throw throwBadRequestError('Please provide a positive available count or leave it blank.');

    // Create item:
    const record = await dbWrite.purchasableReward.create({
      data: {
        ...input,
        addedById: userId,
        coverImageId:
          coverImage === null
            ? null
            : coverImage === undefined
            ? undefined
            : coverImage?.id ?? imageRecord?.id,
      },
    });

    return record;
  } else {
    const purchasableReward = await dbRead.purchasableReward.findUniqueOrThrow({
      where: { id: input.id },
      select: {
        id: true,
        unitPrice: true,
        _count: {
          select: {
            purchases: true,
          },
        },
      },
    });

    if (input.unitPrice !== purchasableReward.unitPrice && purchasableReward._count.purchases > 0) {
      throw throwBadRequestError('Cannot change the price of a reward that has been purchased.');
    }

    if (
      input.availableCount !== undefined &&
      input.availableCount < purchasableReward._count.purchases
    ) {
      throw throwBadRequestError(
        'Cannot reduce the available count below the number of purchases.'
      );
    }

    // Update the record:
    const record = await dbWrite.purchasableReward.update({
      where: { id: input.id },
      data: {
        ...input,
        coverImageId:
          coverImage === null
            ? null
            : coverImage === undefined
            ? undefined
            : coverImage?.id ?? imageRecord?.id,
      },
    });

    return record;
  }
};

export const purchasableRewardPurchase = async ({
  userId,
  purchasableRewardId,
}: PurchasableRewardPurchase & { userId: number }) => {
  const hasPurchasedReward = await dbRead.userPurchasedRewards.findFirst({
    where: {
      userId,
      purchasableRewardId,
    },
  });

  if (hasPurchasedReward) {
    throw throwBadRequestError('You have already purchased this reward.');
  }

  // Using dbWrite to avoid replication lag in case of codes.
  const reward = await dbWrite.purchasableReward.findUniqueOrThrow({
    where: { id: purchasableRewardId },
    select: {
      id: true,
      title: true,
      termsOfUse: true,
      about: true,
      redeemDetails: true,
      unitPrice: true,
      availableCount: true,
      availableFrom: true,
      availableTo: true,
      archived: true,
      codes: true,
      usage: true,
      coverImageId: true,
      _count: {
        select: {
          purchases: true,
        },
      },
    },
  });

  // Cover all our error cases:
  if (!!reward.availableCount && reward._count.purchases >= reward.availableCount) {
    throw throwBadRequestError('This reward is out of stock.');
  }

  if (reward.availableFrom && reward.availableFrom > new Date()) {
    throw throwBadRequestError('This reward is not yet available.');
  }

  if (reward.availableTo && reward.availableTo < new Date()) {
    throw throwBadRequestError('This reward is no longer available.');
  }

  if (reward.archived) {
    throw throwBadRequestError('This reward is no longer available.');
  }

  const code = (reward.codes ?? [])[0];

  if (!code) {
    // Safeguard in case we can't get a code
    throw throwBadRequestError('This reward is out of stock.');
  }

  // Pay for reward:
  const transaction = await createBuzzTransaction({
    fromAccountId: 0, // bank
    toAccountId: userId,
    amount: reward.unitPrice,
    type: TransactionType.Purchase,
    description: 'Refund due to rejection or cancellation of withdrawal request',
    // Safeguard in case the above check fails :shrug:
    externalTransactionId: `purchasable-reward-purchase-${userId}-${purchasableRewardId}`,
  });

  // Create record:
  const record = await dbWrite.userPurchasedRewards.create({
    data: {
      userId,
      purchasableRewardId,
      buzzTransactionId: transaction.transactionId,
      code,
      meta: {
        // Store core data for safekeeping in case the reward is ever deleted:
        usage: reward.usage,
        unitPrice: reward.unitPrice,
        title: reward.title,
        termsOfUse: reward.termsOfUse,
        about: reward.about,
        redeemDetails: reward.redeemDetails,
        coverImageId: reward.coverImageId,
      },
    },
  });

  if (reward.usage === PurchasableRewardUsage.SingleUse) {
    // update with new codes:
    await dbWrite.purchasableReward.update({
      where: { id: purchasableRewardId },
      data: {
        codes: reward.codes.slice(1),
      },
    });
  }

  return record;
};
