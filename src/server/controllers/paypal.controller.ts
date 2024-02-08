import { createBuzzOrder, processBuzzOrder } from './../services/paypal.service';
import { Context } from '~/server/createContext';

import { PaypalPurchaseBuzzSchema, PaypalOrderSchema } from '../schema/paypal.schema';

export const createBuzzOrderHandler = async ({
  input,
  ctx,
}: {
  input: PaypalPurchaseBuzzSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  return await createBuzzOrder({ userId: ctx.user.id, ...input });
};

export const processBuzzOrderHandler = async ({ input }: { input: PaypalOrderSchema }) => {
  return await processBuzzOrder(input.orderId);
};
