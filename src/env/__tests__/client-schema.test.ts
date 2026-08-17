import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `clientEnv` restates every key by hand because Next.js inlines only the
 * `process.env.NEXT_PUBLIC_*` references it can see literally. A key that names a
 * variable other than its own is therefore permanently undefined, and the schema's
 * default hides it — which is how `NEXT_PUBLIC_LOG_TRPC` spent its life reading
 * `NEXT_PUBLIC_LOG_TRP`.
 */

// Resolved from a ternary, not from a variable of the same name.
const NOT_A_PASSTHROUGH = new Set(['NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER']);

describe('env/client-schema', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('reads each key from the env var of the same name', async () => {
    const { clientSchema } = await import('../client-schema');
    const keys = Object.keys(clientSchema.shape);
    expect(keys.length).toBeGreaterThan(10);

    const next = { ...originalEnv };
    for (const key of keys) next[key] = `sentinel::${key}`;
    process.env = next;

    vi.resetModules();
    const { clientEnv } = await import('../client-schema');

    for (const key of keys) {
      if (NOT_A_PASSTHROUGH.has(key)) continue;
      expect({ [key]: clientEnv[key as keyof typeof clientEnv] }).toEqual({
        [key]: `sentinel::${key}`,
      });
    }
  });

  it('declares the same keys in the schema and in clientEnv', async () => {
    const { clientSchema, clientEnv } = await import('../client-schema');
    expect(Object.keys(clientEnv).sort()).toEqual(Object.keys(clientSchema.shape).sort());
  });

  it('names every key with the NEXT_PUBLIC_ prefix', async () => {
    const { clientSchema } = await import('../client-schema');
    const keys = Object.keys(clientSchema.shape);
    expect(keys.filter((key) => !key.startsWith('NEXT_PUBLIC_'))).toEqual([]);
  });
});
