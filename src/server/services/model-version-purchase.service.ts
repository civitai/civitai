import { dbWrite, dbRead } from '~/server/db/client';
import {
  ModelVersionPurchaseTransactionDetailsSchema,
  PurchaseModelVersionInput,
} from '~/server/schema/model-version-purchase.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { Currency, ModelVersionMonetizationType } from '@prisma/client';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';

export const purchaseModelVersion = async ({
  modelVersionId,
  userId,
}: PurchaseModelVersionInput & { userId: number }) => {
  const modelVersion = await dbRead.modelVersion.findUniqueOrThrow({
    where: { id: modelVersionId },
    select: {
      id: true,
      name: true,
      files: {
        select: {
          id: true,
        },
      },
      model: {
        select: {
          name: true,
        },
      },
      monetization: {
        select: {
          type: true,
          currency: true,
          unitAmount: true,
        },
      },
      purchases: {
        select: {
          transactionDetails: true,
        },
        where: {
          userId,
        },
      },
    },
  });

  const { monetization, purchases } = modelVersion;

  if (!monetization) {
    throw throwBadRequestError('Model version does not have monetization options selected.');
  }

  if (
    ![
      ModelVersionMonetizationType.PaidAccess,
      ModelVersionMonetizationType.PaidGeneration,
      ModelVersionMonetizationType.PaidEarlyAccess,
    ].some((i) => i === monetization.type)
  ) {
    throw throwBadRequestError('Model version is not available for purchase.');
  }

  const { unitAmount } = monetization;
  // Now, attempt to charge the user:

  if (!unitAmount) {
    throw throwBadRequestError('Model version does not have a price set.');
  }

  if (
    purchases.length > 0 &&
    purchases.some((p) => {
      const details = p.transactionDetails as ModelVersionPurchaseTransactionDetailsSchema;
      return details?.monetizationType === monetization.type;
    })
  ) {
    throw throwBadRequestError('Model version has already been purchased.');
  }

  await dbWrite.$transaction(async (tx) => {
    const currency = monetization.currency ?? Currency.BUZZ;

    await tx.modelVersionPurchase.create({
      data: {
        modelVersionId: modelVersion.id,
        userId,
        transactionDetails: {
          monetizationType: monetization.type,
          unitAmount,
          currency,
        },
        files: {
          connect: modelVersion.files.map((f) => ({ id: f.id })),
        },
      },
    });

    switch (currency) {
      case Currency.BUZZ:
        await createBuzzTransaction({
          fromAccountId: userId,
          toAccountId: 0,
          amount: unitAmount,
          type: TransactionType.Purchase,
          description: `Model Version Purchase: ${modelVersion.name ?? modelVersion.model?.name}`,
        });

        break;
      default: // Do no checks
        break;
    }
  });
};
