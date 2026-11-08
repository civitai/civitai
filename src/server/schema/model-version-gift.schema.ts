import * as z from 'zod';
import { GIFT_MINT_MAX_PER_CALL } from '~/server/services/model-version-gift.constants';

const expiresAt = z.coerce
  .date()
  .refine((d) => d.getTime() > Date.now(), 'expiresAt must be in the future')
  .nullish();
const label = z.string().trim().max(100).nullish();

export const createGiftLinkSchema = z.object({
  modelVersionId: z.number().int().positive(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullish(),
  expiresAt,
  label,
});

export const mintGiftCodesSchema = z.object({
  count: z.number().int().min(1).max(GIFT_MINT_MAX_PER_CALL),
  expiresAt,
  label,
});

export const giftLinksForVersionSchema = z.object({ modelVersionId: z.number().int().positive() });

export const revokeGiftLinksSchema = z
  .object({
    modelVersionId: z.number().int().positive(),
    id: z.number().int().positive().optional(),
    batchId: z.uuid().optional(),
  })
  .refine((v) => (v.id == null) !== (v.batchId == null), 'Pass exactly one of id or batchId');

export const claimGiftSchema = z.object({ code: z.string().trim().min(1).max(64) });
