import type {
  CurrencyCode,
  ITransactionItemWithPrice,
  ITransactionItemWithPriceId,
  ListAdjustmentQueryParameters,
  UpdateSubscriptionRequestBody,
} from '@paddle/paddle-node-sdk';
import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { isDev } from '~/env/other';
import { env } from '~/env/server';
import type { TransactionMetadataSchema } from '~/server/schema/paddle.schema';
import { numberWithCommas } from '~/utils/number-helpers';

const paddle = env.PADDLE_SECRET_KEY
  ? new Paddle(env.PADDLE_SECRET_KEY, {
      environment: isDev ? Environment.sandbox : Environment.production,
    })
  : undefined;

export const getPaddle = () => {
  if (!paddle) {
    throw new Error('Paddle not initialized');
  }
  return paddle;
};

export const getOrCreateCustomer = async ({ email, userId }: { email: string; userId: number }) => {
  const paddle = getPaddle();
  const customerCollection = await paddle.customers.list({ email: [email] });
  const customers = await customerCollection.next();

  if (customers.length > 0) {
    return customers[0];
  }

  return paddle.customers.create({
    email,
    customData: {
      userId,
    },
  });
};

const createOneTimeUseBuzzProduct = ({
  buzzAmount,
  unitAmount,
  currency,
  metadata,
}: {
  unitAmount: number;
  buzzAmount: number;
  currency: string;
  metadata?: TransactionMetadataSchema;
}): ITransactionItemWithPrice => {
  const buzzAmountWithCommas = numberWithCommas(buzzAmount);
  return {
    quantity: 1,
    price: {
      product: {
        name: `${buzzAmountWithCommas} Buzz`,
        // TODO: This must be requested onto Paddle as digital-goods
        taxCategory: 'standard',
        imageUrl: '',
      },
      taxMode: 'account_setting',
      unitPrice: {
        amount: unitAmount.toString(),
        currencyCode: currency as CurrencyCode,
      },
      name: `One-time payment for ${buzzAmountWithCommas} Buzz`,
      description: `Purchase of ${buzzAmountWithCommas}`,
      quantity: {
        maximum: 1,
        minimum: 1,
      },
      customData: metadata,
    },
  };
};

export const createBuzzTransaction = async ({
  customerId,
  unitAmount,
  buzzAmount,
  currency = 'USD',
  metadata,
  includedItems,
}: {
  customerId: string;
  unitAmount: number;
  buzzAmount: number;
  currency: string;
  metadata?: TransactionMetadataSchema;
  includedItems?: ITransactionItemWithPriceId[];
}) => {
  const paddle = getPaddle();
  return paddle.transactions.create({
    customerId: customerId,
    items: [
      createOneTimeUseBuzzProduct({ unitAmount, buzzAmount, currency, metadata }),
      ...(includedItems ?? []),
    ],
  });
};

export const createOneTimeProductPurchaseTransaction = async ({
  customerId,
  priceId,
}: {
  customerId: string;
  priceId: string;
}) => {
  const paddle = getPaddle();
  return paddle.transactions.create({
    customerId: customerId,
    items: [
      {
        quantity: 1,
        priceId,
      },
    ],
  });
};

export const subscriptionBuzzOneTimeCharge = async ({
  subscriptionId,
  unitAmount,
  buzzAmount,
  currency = 'USD',
  metadata,
}: {
  subscriptionId: string;
  unitAmount: number;
  buzzAmount: number;
  currency: string;
  metadata?: TransactionMetadataSchema;
}) => {
  const paddle = getPaddle();
  return paddle.subscriptions.createOneTimeCharge(subscriptionId, {
    items: [createOneTimeUseBuzzProduct({ buzzAmount, currency, unitAmount, metadata })],
    effectiveFrom: 'immediately',
    onPaymentFailure: 'prevent_change',
  });
};

export const getTransactionById = async (transactionId: string) => {
  const transaction = await getPaddle().transactions.get(transactionId);
  return transaction;
};

export const updateTransaction = ({
  transactionId,
  metadata,
}: {
  transactionId: string;
  metadata: TransactionMetadataSchema;
}) => {
  const paddle = getPaddle();
  return paddle.transactions.update(transactionId, {
    customData: metadata,
  });
};

export const getPaddleCustomerSubscriptions = async ({ customerId }: { customerId: string }) => {
  const paddle = getPaddle();
  const collection = await paddle.subscriptions.list({
    customerId: [customerId],
    status: ['active'],
  });

  return collection.next();
};

export const getPaddleSubscription = ({ subscriptionId }: { subscriptionId: string }) => {
  const paddle = getPaddle();
  return paddle.subscriptions.get(subscriptionId);
};

export const updatePaddleSubscription = ({
  subscriptionId,
  ...data
}: {
  subscriptionId: string;
} & UpdateSubscriptionRequestBody) => {
  return paddle?.subscriptions.update(subscriptionId, data);
};

export const getCustomerLatestTransaction = async ({ customerId }: { customerId: string }) => {
  const paddle = getPaddle();
  const collection = await paddle.transactions.list({
    customerId: [customerId],
  });

  const data = await collection.next();

  if (data.length === 0) {
    return null;
  }

  return data[0];
};

export const cancelPaddleSubscription = (
  subscriptionId: string,
  effectiveFrom: 'next_billing_period' | 'immediately' = 'next_billing_period'
) => {
  const paddle = getPaddle();
  return paddle.subscriptions.cancel(subscriptionId, { effectiveFrom });
};

export const getPaddleAdjustments = async (params: ListAdjustmentQueryParameters) => {
  const paddle = getPaddle();
  const perPage = params.perPage ?? 50;
  const query = paddle.adjustments.list({
    ...params,
    perPage,
  });

  const data = await query.next();
  return data;
};

export const updatePaddleCustomerEmail = async ({
  customerId,
  email,
}: {
  customerId: string;
  email: string;
}) => {
  const paddle = getPaddle();
  return paddle.customers.update(customerId, {
    email,
  });
};

export const createAnnualSubscriptionDiscount = async ({
  amount,
  currency,
  userId,
}: {
  amount: string;
  currency?: string;
  userId: number | string;
}) => {
  const paddle = getPaddle();
  try {
    return paddle.discounts.create({
      amount,
      type: 'flat',
      currencyCode: (currency as CurrencyCode) ?? 'USD',
      recur: true,
      maximumRecurringIntervals: 1,
      usageLimit: 1,
      description: 'Discount for Annual subscription upgrade UserId: ' + userId,
    });
  } catch (e) {
    console.error('Error creating discount', e);
    throw e;
  }
};
