import { z } from 'zod';

// Shared zod field factories for the multipart-form paid-access schemas (early-access + bulk). Form
// values arrive as strings, so each coerces from the raw FormData value. Kept in one place so the
// early-access editor and the bulk setter validate prices/checkboxes identically.

/** HTML checkbox → boolean ('on'/'true' checked, absent/anything else = false). */
export const checkbox = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());

/** Optional buzz amount; empty/absent → undefined. */
export const optionalBuzz = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().optional()
);

/** Optional whole-buzz amount with a minimum; empty/absent → undefined. */
export const optionalBuzzField = (min: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().int().min(min).optional()
  );

/** Required whole-buzz amount with a minimum + custom message; empty/absent fails the minimum. */
export const requiredBuzzField = (min: number, message: string) =>
  z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().int().min(min, { message })
  );

/** Free preview generations (trial limit). Empty = 0 (none) so clearing the field zeroes it. */
export const freePreviewsField = () =>
  z.preprocess((v) => (v === '' || v == null ? 0 : Number(v)), z.number().int().min(0));
