import type { z } from 'zod';

// Parse URL search params through a zod schema. Repeated keys (`?k=a&k=b`) named in `multiKeys` are
// collected via getAll into an array; every other key is a single string. Absent keys are omitted so the
// schema's defaults apply.
//
// Give every field a `.catch(default)` (or `.optional()`): query params are user-controllable, so a bad
// value like `?page=abc` should degrade to the default, not throw a 500. With `.catch` on each field this
// never rejects.
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
