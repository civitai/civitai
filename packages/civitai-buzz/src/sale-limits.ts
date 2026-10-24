import { z } from 'zod';
import type { SaleLimitOverrides } from './paid-access';

// `KeyValue.value` is a Json column, so anything is representable — including shapes that would widen a
// limit by accident. Every field is validated and a bad one is DROPPED rather than coerced: falling back
// to the compiled default is the safe direction for a spend limit, and `.catch(undefined)` per field
// means one malformed entry can't discard the others.
const positiveInt = z.number().int().positive();

const overridesSchema = z
  .object({
    saleDaysByTier: z
      .record(z.string(), positiveInt)
      .catch(undefined as never)
      .optional(),
    minCreatorScore: z
      .number()
      .int()
      .nonnegative()
      .catch(undefined as never)
      .optional(),
    maxLeadDays: positiveInt.catch(undefined as never).optional(),
  })
  .catch({});

/**
 * The overrides a `SALE_LIMITS_KEY` row actually carries. One parser for every app that reads the row, so
 * the studio enforcing a sale floor and the main app describing it cannot disagree about which stored
 * values count.
 */
export const parseSaleLimitOverrides = (value: unknown): SaleLimitOverrides =>
  overridesSchema.parse(value) as SaleLimitOverrides;
