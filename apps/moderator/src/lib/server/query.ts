import { z } from 'zod';
import { escapeLike } from './like';
import { MAX_INT4 } from './users.service';

// Every lookup page takes the same search term the same way. Four routes had this line verbatim, and
// it is the ONLY part of a lookup `load` that is genuinely shared — the resolvers and the not-found
// semantics differ per page in ways that matter, so there is no `createLookupLoad` behind this.
export const lookupQuerySchema = z.object({ q: z.string().trim().catch('') });

/** A Postgres `integer` id from the client; see `userIdSchema` for why the bound matters. */
export const int4Id = z.coerce.number().int().positive().max(MAX_INT4);

/** `User.id` and friends are Postgres `integer`: a larger value ERRORS the comparison rather than
 *  missing, so an unbounded id 500s the action. The two hand-written copies of this had already
 *  drifted — one bounded, one not. */
export const userIdSchema = z.object({
  userId: int4Id,
});

/** A comma-separated id list from a hidden input. Same int4 bound as `userIdSchema`, and for the same
 *  reason. */
export const parseIdList = (value: string, max = 5000): number[] =>
  value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_INT4)
    .slice(0, max);

/** Free-text ids (commas, spaces, newlines), deduplicated. Over `max` returns a message instead of
 *  truncating, unlike `parseIdList`. */
export const parseIdPaste = (raw: string, max: number): number[] | string => {
  const ids = [...new Set(parseIdList(raw.replace(/[\s,]+/g, ','), Number.MAX_SAFE_INTEGER))];
  if (!ids.length) return 'Paste at least one id.';
  return ids.length > max ? `Paste at most ${max} ids at a time.` : ids;
};

/** `parseIdList` truncates SILENTLY, which on a destructive action means the screen reports a count it
 *  did not act on. Use this where the overflow must be told to the operator instead of dropped. */
export const parseIdListStrict = (value: string, max: number): number[] | string => {
  const ids = parseIdList(value, Number.MAX_SAFE_INTEGER);
  return ids.length > max
    ? `${ids.length} accounts exceeds the limit of ${max} per run. Split the list.`
    : ids;
};

/**
 * A checkbox as browsers actually submit one: absent when unchecked, and its VALUE is not a boolean.
 *
 * 🔴 Never use `z.coerce.boolean()` here. It maps "off", "false" and "0" to `true`, so the day a
 * checkbox is swapped for a hidden input carrying an explicit value — the shape used elsewhere in this
 * app — every ban silently purges the account's media. This accepts both shapes.
 */
export const checkboxField = z
  .string()
  .optional()
  .transform((v) => v === 'on' || v === 'true' || v === '1');

/** zod over FormData, with the first message rather than the full issue tree. The form-side twin of
 *  `parseQuery`. */
export function parseForm<T extends z.ZodType>(schema: T, form: FormData): z.infer<T> | string {
  const parsed = schema.safeParse(Object.fromEntries(form));
  return parsed.success ? parsed.data : parsed.error.issues[0]?.message ?? 'Invalid input.';
}

/** Malformed JSON fails with `message`, a schema failure with its first issue's message. */
export const jsonField = <T extends z.ZodType>(schema: T, message = 'Malformed form data.') =>
  z.string().transform((raw, ctx): z.infer<T> => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    ctx.addIssue({ code: 'custom', message: parsed.error.issues[0]?.message ?? message });
    return z.NEVER;
  });

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

/**
 * `parseQuery` for a load that must NOT rerun on params it does not use — a layout under a page with
 * its own params. SvelteKit tracks `searchParams.get`/`getAll`/`has` per key, but `keys()`, which
 * `parseQuery` walks, counts as reading the whole query string: every param change anywhere on the
 * page reruns the load. This reads the schema's own keys and nothing else.
 */
export function parseQueryKeys<T extends z.ZodObject>(
  url: URL,
  schema: T,
  multiKeys: string[] = []
): z.infer<T> {
  const obj: Record<string, string | string[]> = {};
  for (const key of Object.keys(schema.shape)) {
    if (!url.searchParams.has(key)) continue;
    obj[key] = multiKeys.includes(key) ? url.searchParams.getAll(key) : url.searchParams.get(key)!;
  }
  return schema.parse(obj);
}

/** A `%term%` operand with LIKE's own wildcards escaped. */
export const containsLike = (term: string) => `%${escapeLike(term)}%`;
