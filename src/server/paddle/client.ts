import {
  CurrencyCode,
  Environment,
  ITransactionItemWithPrice,
  ITransactionItemWithPriceId,
  Paddle,
  UpdateSubscriptionRequestBody,
} from '@paddle/paddle-node-sdk';
import { isDev } from '~/env/other';
import { env } from '~/env/server.mjs';
import { TransactionMetadataSchema } from '~/server/schema/paddle.schema';

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
}): ITransactionItemWithPrice => ({
  quantity: 1,
  price: {
    product: {
      name: `${buzzAmount} Buzz`,
      // TODO: This must be requested onto Paddle as digital-goods
      taxCategory: 'standard',
      imageUrl: '',
    },
    taxMode: 'account_setting',
    unitPrice: {
      amount: unitAmount.toString(),
      currencyCode: currency as CurrencyCode,
    },
    name: `One-time payment for ${buzzAmount} Buzz`,
    description: `Purchase of ${buzzAmount}`,
    quantity: {
      maximum: 1,
      minimum: 1,
    },
    customData: metadata,
  },
});

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
    customData: metadata,
    customerId: customerId,
    items: [
      createOneTimeUseBuzzProduct({ unitAmount, buzzAmount, currency }),
      ...(includedItems ?? []),
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
