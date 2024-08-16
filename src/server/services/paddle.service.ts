import { Currency, PaymentProvider } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';
import { invalidateSession } from '~/server/utils/session-helpers';
import {
  createBuzzTransaction as createPaddleBuzzTransaction,
  getOrCreateCustomer,
  // updateTransaction,
} from '~/server/paddle/client';
import { TransactionCreateInput, TransactionMetadataSchema } from '~/server/schema/paddle.schema';
import {
  Product as PaddleProduct,
  Price as PaddlePrice,
  Transaction,
  ProductNotification,
  PriceNotification,
} from '@paddle/paddle-node-sdk';
import { createBuzzTransaction, getMultipliersForUser } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { number } from 'zod';

const baseUrl = getBaseUrl();
const log = createLogger('paddle', 'yellow');

export const createCustomer = async ({ id, email }: { id: number; email: string }) => {
  const user = await dbWrite.user.findUnique({ where: { id }, select: { paddleCustomerId: true } });
  if (!user?.paddleCustomerId) {
    const customer = await getOrCreateCustomer({ email, userId: id });

    await dbWrite.user.update({ where: { id }, data: { paddleCustomerId: customer.id } });
    await invalidateSession(id);

    return customer.id;
  } else {
    return user.paddleCustomerId;
  }
};

export const createTransaction = async ({
  unitAmount,
  currency = Currency.USD,
  customerId,
  user,
}: TransactionCreateInput & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  if (!user?.email && !customerId) {
    throw throwBadRequestError('Email is required to create a transaction');
  }

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  if (!customerId) {
    throw throwBadRequestError('We were unable to get or create a paddle customer');
  }

  const transaction = await createPaddleBuzzTransaction({
    customerId,
    unitAmount,
    buzzAmount: unitAmount * 10, // 10x
    currency,
    metadata: {
      type: 'buzzPurchase',
      unitAmount: unitAmount,
      buzzAmount: unitAmount * 10, // 10x
      userId: user.id,
    },
  });

  return {
    transactionId: transaction.id,
  };
};

export const processCompleteBuzzTransaction = async (transaction: Transaction) => {
  if (!transaction.customData) {
    throw throwBadRequestError('Custom data is required to complete a buzz transaction.');
  }

  const meta = transaction.customData as TransactionMetadataSchema;

  if (meta.type !== 'buzzPurchase') {
    throw throwBadRequestError('Only use this method to process buzz purchases.');
  }

  if (meta.buzzTransactionId) {
    // Already processed.
    return;
  }

  const { purchasesMultiplier } = await getMultipliersForUser(meta.userId);
  const amount = meta.buzzAmount;
  const buzzAmount = Math.ceil(amount * (purchasesMultiplier ?? 1));

  // Pay the user:
  const buzzTransaction = await createBuzzTransaction({
    amount: buzzAmount,
    fromAccountId: 0,
    toAccountId: meta.userId,
    externalTransactionId: transaction.id,
    type: TransactionType.Purchase,
    description: `Purchase of ${amount} buzz. ${
      purchasesMultiplier && purchasesMultiplier > 1 ? 'Multiplier applied due to membership. ' : ''
    }A total of ${buzzAmount} buzz was added to your account.`,
    details: {
      paddleTransactionId: transaction.id,
    },
  });

  // TODO: Ask paddle guys if it's possible to update customData after transaction completed.
  //  await updateTransaction({
  //   transactionId: transaction.id,
  //   metadata: { ...meta, buzzTransactionId: buzzTransaction.transactionId },
  // });
};

export const upsertProductRecord = async (product: ProductNotification) => {
  const productData = {
    id: product.id,
    active: product.status === 'active',
    name: product.name,
    description: product.description ?? null,
    metadata: product.customData ?? undefined,
    // Paddle doesn't have a concept of default price in the same way as Stripe.
    // We backfill when we receive a price with default metadata.
    defaultPriceId: undefined,
    provider: PaymentProvider.Paddle,
  };

  await dbWrite.product.upsert({
    where: { id: product.id },
    update: productData,
    create: {
      ...productData,
      metadata: productData.metadata ?? {},
    },
  });

  return productData;
};

export const upsertPriceRecord = async (price: PriceNotification) => {
  const priceMeta = (price.customData ?? {}) as { default?: boolean };

  const priceData = {
    id: price.id,
    productId: price.productId,
    active: price.status === 'active',
    currency: price.unitPrice.currencyCode,
    description: price.description ?? undefined,
    type: price.billingCycle ? 'recurring' : 'one_time',
    unitAmount: parseInt(price.unitPrice.amount, 10),
    interval: price.billingCycle?.interval,
    intervalCount: price.billingCycle?.frequency,
    metadata: price.customData ?? undefined,
    provider: PaymentProvider.Paddle,
  };

  await dbWrite.price.upsert({
    where: { id: price.id },
    update: priceData,
    create: {
      ...priceData,
      metadata: priceData.metadata ?? {},
    },
  });

  if (priceMeta.default) {
    // Update the product
    await dbWrite.product.update({
      where: { id: price.productId },
      data: { defaultPriceId: price.id },
    });
  }

  return priceData;
};
