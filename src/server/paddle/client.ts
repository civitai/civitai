import { CurrencyCode, Paddle } from '@paddle/paddle-node-sdk';
import { env } from '~/env/server.mjs';

const paddle = env.PADDLE_SECRET_KEY ? new Paddle(env.PADDLE_SECRET_KEY) : undefined;

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
  currency = 'USD',
}: {
  customerId: string;
  unitAmount: number;
  currency: string;
}) => {
  const paddle = getPaddle();
  return paddle.transactions.create({
    customerId: customerId,
    items: [
      {
        quantity: unitAmount,
        price: {
          product: {
            name: 'Buzz',
            taxCategory: 'digital-goods',
          },
          taxMode: 'account_setting',
          unitPrice: {
            amount: '0.1',
            currencyCode: currency as CurrencyCode,
          },
          description: 'Buzz',
        },
      },
    ],
  });
};
