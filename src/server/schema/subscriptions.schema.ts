import { z } from 'zod';
import { Currency, PaymentProvider } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { booleanString } from '~/utils/zod-helpers';

export type GetPlansSchema = z.infer<typeof getPlansSchema>;
export const getPlansSchema = z.object({
  paymentProvider: z.nativeEnum(PaymentProvider).optional(),
});
