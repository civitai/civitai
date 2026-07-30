import type { z } from 'zod';

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
