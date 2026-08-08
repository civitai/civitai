import { z } from 'zod';
import { MAX_INT4 } from './users.service';

// Every lookup page takes the same search term the same way. Four routes had this line verbatim, and
// it is the ONLY part of a lookup `load` that is genuinely shared — the resolvers and the not-found
// semantics differ per page in ways that matter, so there is no `createLookupLoad` behind this.
export const lookupQuerySchema = z.object({ q: z.string().trim().catch('') });

/** `User.id` and friends are Postgres `integer`: a larger value ERRORS the comparison rather than
 *  missing, so an unbounded id 500s the action. The two hand-written copies of this had already
 *  drifted — one bounded, one not. */
export const userIdSchema = z.object({
  userId: z.coerce.number().int().positive().max(MAX_INT4),
});

/** A comma-separated id list from a hidden input. Same int4 bound as `userIdSchema`, and for the same
 *  reason. */
export const parseIdList = (value: string, max = 5000): number[] =>
  value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_INT4)
    .slice(0, max);

/** zod over FormData, with the first message rather than the full issue tree. The form-side twin of
 *  `parseQuery`. */
export function parseForm<T extends z.ZodType>(schema: T, form: FormData): z.infer<T> | string {
  const parsed = schema.safeParse(Object.fromEntries(form));
  return parsed.success ? parsed.data : parsed.error.issues[0]?.message ?? 'Invalid input.';
}

// Give every schema field a `.catch(default)`/`.optional()`: query params are user-controllable, so a bad
// value like `?page=abc` must degrade to the default, not throw a 500.
export function parseQuery<T extends z.ZodType>(
  url: URL,
  schema: T,
  multiKeys: string[] = []
): z.infer<T> {
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    obj[key] = multiKeys.includes(key) ? url.searchParams.getAll(key) : url.searchParams.get(key)!;
  }
  return schema.parse(obj);
}
