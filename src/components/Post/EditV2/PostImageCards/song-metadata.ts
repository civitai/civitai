/** The stored metadata with `changes` applied; an undefined value removes its key. */
export function withMetadata<T>(metadata: T, changes: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(metadata as Record<string, unknown> | null) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
