import * as z from 'zod';

const MAX_BIGINT = BigInt('9223372036854775807');

export const openMysteryBoxInput = z.object({
  /** The held box's `Item.id`, a BIGINT sent as a decimal string. */
  boxItemId: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((id) => BigInt(id) <= MAX_BIGINT),
  // The box version whose contents and odds the holder was shown; an edited box refuses.
  expectedVersion: z.number().int().positive(),
});

export type OpenMysteryBoxInput = z.infer<typeof openMysteryBoxInput>;
