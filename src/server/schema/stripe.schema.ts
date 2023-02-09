import { z } from 'zod';

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const createCustomerSchema = z.object({ id: z.number(), email: z.string().email() });

export type CreateSubscribeSessionInput = z.infer<typeof createSubscribeSessionSchema>;
export const createSubscribeSessionSchema = z.object({ priceId: z.string() });

export type GetUserSubscriptionInput = z.infer<typeof getUserSubscriptionSchema>;
export const getUserSubscriptionSchema = z.object({ userId: z.number() });

export type CreateDonateSessionInput = z.infer<typeof createDonateSessionSchema>;
export const createDonateSessionSchema = z.object({ returnUrl: z.string() });
