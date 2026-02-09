import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { EntityType, StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';

export const createStrikeSchema = z.object({
  userId: z.number(),
  reason: z.nativeEnum(StrikeReason),
  points: z.number().min(1).max(3).default(1),
  description: z.string().min(1).max(1000),
  internalNotes: z.string().max(2000).optional(),
  entityType: z.nativeEnum(EntityType).optional(),
  entityId: z.number().optional(),
  reportId: z.number().optional(),
  expiresInDays: z.number().min(1).max(365).default(30),
});
export type CreateStrikeInput = z.infer<typeof createStrikeSchema>;

export const voidStrikeSchema = z.object({
  strikeId: z.number(),
  voidReason: z.string().min(1).max(1000),
});
export type VoidStrikeInput = z.infer<typeof voidStrikeSchema>;

export const getStrikesSchema = paginationSchema.extend({
  userId: z.number().optional(),
  username: z.string().optional(),
  status: z.nativeEnum(StrikeStatus).optional(),
  reason: z.nativeEnum(StrikeReason).optional(),
});
export type GetStrikesInput = z.infer<typeof getStrikesSchema>;

export const getMyStrikesSchema = z.object({
  includeExpired: z.boolean().default(false),
});
export type GetMyStrikesInput = z.infer<typeof getMyStrikesSchema>;
