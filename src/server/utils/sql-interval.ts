import { Prisma } from '@prisma/client';

/**
 * `make_interval(days => n)` with `n` inlined rather than bound. Prisma binds a JS number as int8
 * and `make_interval` takes int4, so a bound parameter throws 42883 on every run (the
 * `no-bound-make-interval` ratchet). Pass only a value already known to be an integer (a constant,
 * or one the schema bounded): it is inlined into the SQL text.
 */
export const intervalDays = (days: number) =>
  Prisma.sql`make_interval(days => ${Prisma.raw(String(days))})`;
