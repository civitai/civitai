import { z } from 'zod';

// Shared zod field factories for the app's multipart form schemas. Form values arrive as strings, so
// each coerces from the raw FormData value. Kept in one place so every form validates numbers and
// checkboxes identically.

/** HTML checkbox → boolean ('on'/'true' checked, absent/anything else = false). */
export const checkbox = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());

/** Empty or absent → undefined, anything else → Number. The one coercion every field below shares. */
export const numberish = (v: unknown) => (v === '' || v == null ? undefined : Number(v));

/** Optional buzz amount; empty/absent → undefined. */
export const optionalBuzz = z.preprocess(numberish, z.number().optional());

/** Optional whole-buzz amount with a minimum; empty/absent → undefined. */
export const optionalBuzzField = (min: number) =>
  z.preprocess(numberish, z.number().int().min(min).optional());

/** Required whole-buzz amount with a minimum + custom message; empty/absent fails the minimum. */
export const requiredBuzzField = (min: number, message: string) =>
  z.preprocess(numberish, z.number().int().min(min, { message }));

/** Free preview generations (trial limit). Empty = 0 (none) so clearing the field zeroes it. */
export const freePreviewsField = () =>
  z.preprocess((v) => numberish(v) ?? 0, z.number().int().min(0));
