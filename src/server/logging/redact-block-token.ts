/**
 * Replace every `blockToken` value in a tRPC input with a fixed marker before the input is
 * logged. A block token is a bearer credential: anyone holding it can act as the viewer it was
 * minted for until it expires, so it must never reach a log line.
 *
 * The KEY is kept so the log still shows a token was present; only the value is replaced. Keyed
 * on the field name, not on the procedure, because every procedure that carries a block token
 * spells it `blockToken` — mutations included, which the query-only transport set does not cover.
 *
 * Walks nested objects and arrays at any depth (a wrapped input still redacts). Deliberately
 * unbounded: a depth cap would either let a deep token through or truncate legitimately deep
 * inputs, and the `JSON.stringify` this feeds walks the whole input anyway. A cyclic input throws
 * here exactly as it would in `JSON.stringify`, so call it inside the same try. Never mutates its
 * argument (it is the object tRPC handed the procedure); returns the original reference when
 * nothing was redacted.
 */
export const REDACTED_BLOCK_TOKEN = '[redacted]';

export function redactBlockTokens<T>(input: T): T {
  return redact(input) as T;
}

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redact(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  // Only plain objects: a Date, Map or class instance is left as-is (JSON.stringify decides
  // how it renders, and none of them carries a `blockToken` field we produce).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  let out: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = key === 'blockToken' && child != null ? REDACTED_BLOCK_TOKEN : redact(child);
    if (next !== child) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}
