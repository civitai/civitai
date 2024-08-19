import {
  CurrencyCode,
  Environment,
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

  if (customerCollection.estimatedTotal > 0) {
    const customers = await customerCollection.next();
    return customers[0];
  }

  return paddle.customers.create({
    email,
    customData: {
      userId,
    },
  });
};

export const createBuzzTransaction = async ({
  customerId,
  unitAmount,
  buzzAmount,
  currency = 'USD',
  metadata,
}: {
  customerId: string;
  unitAmount: number;
  buzzAmount: number;
  currency: string;
  metadata?: TransactionMetadataSchema;
}) => {
  const paddle = getPaddle();
  return paddle.transactions.create({
    customData: metadata,
    customerId: customerId,
    items: [
      {
        quantity: 1,
        price: {
          product: {
            name: `${buzzAmount} Buzz`,
            // TODO: This must be requested onto Paddle as digital-goods
            taxCategory: 'standard',
          },
          taxMode: 'account_setting',
          unitPrice: {
            amount: unitAmount.toString(),
            currencyCode: currency as CurrencyCode,
          },
          description: `Purchase of ${buzzAmount} Buzz`,
        },
      },
    ],
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
