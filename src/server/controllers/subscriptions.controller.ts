import { PaymentProvider } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { GetPlansSchema } from '~/server/schema/subscriptions.schema';
import { getPlans } from '~/server/services/subscriptions.service';

export const getPlansHandler = async ({ input }: { input: GetPlansSchema }) => {
  return await getPlans({
    paymentProvider: input.paymentProvider ?? (env.DEFAULT_PAYMENT_PROVIDER as PaymentProvider),
  });
};
