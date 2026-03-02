import { RedeemableCodeType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';

export type CreateRedeemableCodeInput = z.infer<typeof createRedeemableCodeSchema>;
export const createRedeemableCodeSchema = z.object({
  unitValue: z.number().min(1),
  type: z.enum(RedeemableCodeType),
  expiresAt: z.date().optional(),
  quantity: z.number().min(1).optional(),
  priceId: z.string().optional(),
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
    .regex(/^[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, { error: 'Invalid code format' }),
});

export type GetCodeByOrderIdInput = z.infer<typeof getCodeByOrderIdSchema>;
export const getCodeByOrderIdSchema = z.object({
  orderId: z.string(),
});

export const giftNoticeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  minValue: z.number(),
  maxValue: z.number().nullable(),
  title: z.string(),
  message: z.string(),
  linkUrl: z.string(),
  linkText: z.string(),
});

export type GiftNotice = z.infer<typeof giftNoticeSchema>;

export const upsertGiftNoticeSchema = z.object({
  id: z.string().optional(),
  startDate: z.date(),
  endDate: z.date(),
  minValue: z.number().min(0),
  maxValue: z.number().min(0).nullable(),
  title: z.string().min(1),
  message: z.string().min(1),
  linkUrl: z
    .string()
    .min(1)
    .refine(
      (val) => val.startsWith('/') || val.startsWith('http://') || val.startsWith('https://'),
      {
        message: 'Must be a valid URL or relative path starting with /',
      }
    ),
  linkText: z.string().min(1),
});

export type UpsertGiftNoticeInput = z.infer<typeof upsertGiftNoticeSchema>;

export const deleteGiftNoticeSchema = z.object({
  id: z.string(),
});

export type DeleteGiftNoticeInput = z.infer<typeof deleteGiftNoticeSchema>;
