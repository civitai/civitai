import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';

export const imageId = z.coerce.number().int().positive();

// Restricted to real bitflag values rather than any non-negative int — passing e.g. `3` or `999`
// silently corrupted the row.
const validNsfwLevels = Object.values(NsfwLevel).filter((v): v is number => typeof v === 'number');
export const nsfwLevel = z.coerce
  .number()
  .int()
  .refine((v) => validNsfwLevels.includes(v), {
    message: `nsfwLevel must be one of [${validNsfwLevels.join(', ')}]`,
  });
