import { z } from 'zod';

export type PaypalPurchaseBuzzSchema = z.infer<typeof paypalPurchaseBuzzSchema>;
export const paypalPurchaseBuzzSchema = z.object({
  amount: z.number(),
});

export type PaypalOrderSchema = z.infer<typeof paypalOrderSchema>;
export const paypalOrderSchema = z.object({
  orderId: z.string(),
});
