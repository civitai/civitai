import { RedeemableCodeType } from '@prisma/client';
import { z } from 'zod';

export type CreateRedeemableCodeInput = z.infer<typeof createRedeemableCodeSchema>;
export const createRedeemableCodeSchema = z.object({
  unitValue: z.number().min(1),
  type: z.nativeEnum(RedeemableCodeType),
  expiresAt: z.date().optional(),
  quantity: z.number().min(1).optional(),
});

export type DeleteRedeemableCodeInput = z.infer<typeof deleteRedeemableCodeSchema>;
export const deleteRedeemableCodeSchema = z.object({
  code: z.string(),
});

export type ConsumeRedeemableCodeInput = z.infer<typeof consumeRedeemableCodeSchema>;
export const consumeRedeemableCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .length(12)
    .toUpperCase()
    .regex(/^[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, { message: 'Invalid code format' }),
});
