import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * `clientEnv` restates every key by hand because Next.js inlines only the
 * `process.env.NEXT_PUBLIC_*` references it can see literally. A key that names a
 * variable other than its own is therefore permanently undefined, and the schema's
 * default hides it — which is how `NEXT_PUBLIC_LOG_TRPC` spent its life reading
 * `NEXT_PUBLIC_LOG_TRP`.
 */

// Resolved from an expression rather than from a variable of the same name, so the
// sentinel sweep cannot reach it. Each one is asserted on its own below instead.
const NOT_A_PASSTHROUGH = ['NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER'];

async function importWith(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }
  return import('../client-schema');
}

describe('env/client-schema', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads each key from the env var of the same name', async () => {
    const { clientSchema } = await importWith({});
    const keys = Object.keys(clientSchema.shape);
    expect(keys.length).toBeGreaterThan(10);

    const sentinels = Object.fromEntries(keys.map((key) => [key, `sentinel::${key}`]));
    const { clientEnv } = await importWith(sentinels);

    for (const key of keys) {
      if (NOT_A_PASSTHROUGH.includes(key)) continue;
      expect({ [key]: clientEnv[key as keyof typeof clientEnv] }).toEqual({
        [key]: `sentinel::${key}`,
      });
    }
  });

  it('exempts only keys that genuinely are not passthroughs', async () => {
    const { clientSchema } = await importWith({});
    expect(NOT_A_PASSTHROUGH.filter((key) => !(key in clientSchema.shape))).toEqual([]);
  });

  it('declares the same keys in the schema and in clientEnv', async () => {
    const { clientSchema, clientEnv } = await importWith({});
    expect(Object.keys(clientEnv).sort()).toEqual(Object.keys(clientSchema.shape).sort());
  });

  it('names every key with the NEXT_PUBLIC_ prefix', async () => {
    const { clientSchema } = await importWith({});
    const keys = Object.keys(clientSchema.shape);
    expect(keys.filter((key) => !key.startsWith('NEXT_PUBLIC_'))).toEqual([]);
  });

  describe('NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER', () => {
    it('is Paddle only when the variable says Paddle', async () => {
      const { clientEnv } = await importWith({ NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER: 'Paddle' });
      expect(clientEnv.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER).toBe('Paddle');
    });

    it('falls back to Stripe when unset or unrecognised', async () => {
      const unset = await importWith({ NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER: undefined });
      expect(unset.clientEnv.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER).toBe('Stripe');

      const junk = await importWith({ NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER: 'Coinbase' });
      expect(junk.clientEnv.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER).toBe('Stripe');
    });
  });

  describe('NEXT_PUBLIC_BASE_URL', () => {
    /**
     * The `NEXTAUTH_URL` fallback resolves server-side only: Next inlines nothing
     * without the `NEXT_PUBLIC_` prefix, so an environment setting only `NEXTAUTH_URL`
     * leaves the browser with `undefined`. Pinned rather than removed — see PR #4035.
     */
    it('prefers its own variable', async () => {
      const { clientEnv } = await importWith({
        NEXT_PUBLIC_BASE_URL: 'https://own.test',
        NEXTAUTH_URL: 'https://fallback.test',
      });
      expect(clientEnv.NEXT_PUBLIC_BASE_URL).toBe('https://own.test');
    });

    it('falls back to the server-only NEXTAUTH_URL when its own is unset', async () => {
      const { clientEnv } = await importWith({
        NEXT_PUBLIC_BASE_URL: undefined,
        NEXTAUTH_URL: 'https://fallback.test',
      });
      expect(clientEnv.NEXT_PUBLIC_BASE_URL).toBe('https://fallback.test');
    });
  });

  describe('NEXT_PUBLIC_LOG_TRPC', () => {
    it('parses a boolean token', async () => {
      const { clientSchema } = await importWith({});
      expect(clientSchema.parse({ NEXT_PUBLIC_LOG_TRPC: 'true' }).NEXT_PUBLIC_LOG_TRPC).toBe(true);
    });

    it('treats an empty value as unset rather than as a parse error', async () => {
      const { clientSchema } = await importWith({});
      expect(clientSchema.parse({ NEXT_PUBLIC_LOG_TRPC: '' }).NEXT_PUBLIC_LOG_TRPC).toBe(false);
    });

    it('still rejects a value it cannot parse', async () => {
      const { clientSchema } = await importWith({});
      expect(() => clientSchema.parse({ NEXT_PUBLIC_LOG_TRPC: 'verbose' })).toThrow();
    });
  });
});
