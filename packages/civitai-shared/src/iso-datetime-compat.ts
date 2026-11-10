import * as z from 'zod';

const MINUTE_PRECISION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;

/**
 * `z.iso.datetime(opts)` that also accepts minute precision (`2024-05-14T20:23Z`), read as `:00`.
 *
 * zod 4.0–4.4 accepted it; from 4.6 a datetime with a zone must carry seconds. Use this where the
 * value comes from outside our own code (an external caller, a hand-written config), so a zod
 * upgrade cannot start rejecting payloads that were valid yesterday.
 */
export const isoDatetimeCompat = (opts?: { offset?: boolean }) =>
  z
    .string()
    .meta({ format: 'date-time' })
    .transform((value) => value.replace(MINUTE_PRECISION, '$1:00$2'))
    .pipe(z.iso.datetime(opts));
