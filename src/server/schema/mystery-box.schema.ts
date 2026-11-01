import * as z from 'zod';
import { INT4_MAX } from '~/server/schema/base.schema';

const MAX_BIGINT = '9223372036854775807';

/** A box's `Item.id`, a BIGINT sent as a decimal string. */
const boxItemIdString = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  // Compared as text, not with BigInt(): the check also runs on input the regex refused.
  .refine((id) => id.length < MAX_BIGINT.length || id <= MAX_BIGINT);

export const openMysteryBoxInput = z.object({
  boxItemId: boxItemIdString,
  // The box version whose contents and odds the holder was shown; an edited box refuses.
  expectedVersion: z.number().int().positive(),
});

export type OpenMysteryBoxInput = z.infer<typeof openMysteryBoxInput>;

export const getEventMysteryBoxesInput = z.object({ event: z.string().min(1).max(100) });

export type GetEventMysteryBoxesInput = z.infer<typeof getEventMysteryBoxesInput>;

export const getMysteryBoxOddsPageInput = z.object({
  boxDefinitionId: z.number().int().positive().max(INT4_MAX),
});

export type GetMysteryBoxOddsPageInput = z.infer<typeof getMysteryBoxOddsPageInput>;

export const getMysteryBoxOpeningsInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: boxItemIdString.optional(),
});

export type GetMysteryBoxOpeningsInput = z.infer<typeof getMysteryBoxOpeningsInput>;
