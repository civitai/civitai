import * as z from 'zod';
import { beforeAll, describe, expect, it } from 'vitest';

import { setEnv } from '~/__tests__/mocks/env.mock';
import { BLOCK_TOKEN_QUERY_PROCEDURES } from '~/shared/constants/block-token-transport.constants';
import { classifyBlockTokenProcedures, hasBlockTokenKey } from './block-token-input.harness';

/**
 * `BLOCK_TOKEN_QUERY_PROCEDURES` drives three things — POST-only routing in the browser link, a
 * forced `no-store` on the server, and the GET counter — so a token-bearing query missing from it
 * silently gets none of them. This derives the population from the REAL router at runtime and
 * compares it to the constant AS A SET, in both directions.
 *
 * The walk: import `appRouter`, load every lazy sub-router (the index mounts each one with
 * `lazy()`, so `_def.procedures` is empty until they load), then for every procedure whose
 * `_def.type === 'query'`, read its zod inputs (`_def.inputs`) and ask whether any object shape
 * reachable through them has a `blockToken` key.
 *
 * Fail-closed where the walk cannot see: a sub-router that fails to load, or an input schema whose
 * shape this walk does not know how to read, fails the test by name rather than being scored as
 * "no token".
 */

type Procedure = { _def: { type: string; inputs: unknown[] } };
type RouterDef = {
  procedures: Record<string, Procedure>;
  lazy: Record<string, { load: () => Promise<void> }>;
};

/**
 * Module-scope reads in three payment callers throw without these, which fails their routers'
 * lazy load. Placeholders only — nothing here calls a provider.
 */
const PLACEHOLDER_ENV = {
  COINBASE_API_URL: 'http://placeholder.invalid',
  COINBASE_API_KEY: 'placeholder',
  EMERCHANTPAY_WPF_URL: 'http://placeholder.invalid',
  EMERCHANTPAY_USERNAME: 'placeholder',
  EMERCHANTPAY_PASSWORD: 'placeholder',
  NOW_PAYMENTS_API_URL: 'http://placeholder.invalid',
  NOW_PAYMENTS_API_KEY: 'placeholder',
};

/** Load every lazy sub-router, nested ones included. Returns the keys that failed to load. */
async function loadAllRouters(def: RouterDef): Promise<string[]> {
  const failed: string[] = [];
  const tried = new Set<string>();
  for (;;) {
    const pending = Object.keys(def.lazy).filter((k) => !tried.has(k));
    if (!pending.length) return failed;
    await Promise.all(
      pending.map(async (key) => {
        tried.add(key);
        try {
          await def.lazy[key].load();
        } catch (error) {
          failed.push(`${key}: ${(error as Error).message}`);
        }
      })
    );
  }
}

describe('BLOCK_TOKEN_QUERY_PROCEDURES matches the routers (runtime walk)', () => {
  let procedures: Record<string, Procedure> = {};
  let loadFailures: string[] = [];

  beforeAll(async () => {
    setEnv(PLACEHOLDER_ENV);
    const { appRouter } = await import('~/server/routers');
    const def = (appRouter as unknown as { _def: RouterDef })._def;
    loadFailures = await loadAllRouters(def);
    procedures = def.procedures;
  }, 120_000);

  const queries = () => Object.entries(procedures).filter(([, p]) => p._def.type === 'query');

  /** Every query whose inputs carry `blockToken`, plus every query whose input is unreadable. */
  const derive = () => {
    const { takesToken, unreadable } = classifyBlockTokenProcedures(Object.fromEntries(queries()));
    return { tokenQueries: takesToken, unreadable };
  };

  it('every lazy sub-router loaded (the walk is not missing a router)', () => {
    expect(loadFailures).toEqual([]);
  });

  it('POSITIVE CONTROL: the walk sees the whole app, and a known non-token query', () => {
    // Hundreds of queries across the app; a walk that loaded nothing would read ~0 here and
    // every comparison below would be about an empty population.
    expect(queries().length).toBeGreaterThan(400);
    expect(procedures['model.getAll']?._def.type).toBe('query');
    expect(derive().tokenQueries).not.toContain('model.getAll');
  });

  it('every query input is a shape the walk can read (unreadable is not "no token")', () => {
    expect(derive().unreadable).toEqual([]);
  });

  it('the derived population equals the constant, in both directions', () => {
    expect(derive().tokenQueries).toEqual([...BLOCK_TOKEN_QUERY_PROCEDURES].sort());
  });

  it('CONTROL: hasBlockTokenKey reads merged, extended, wrapped and combined schemas', () => {
    const base = z.object({ blockToken: z.string() });
    const other = z.object({ key: z.string() });
    expect(hasBlockTokenKey(base.extend({ key: z.string() }))).toBe(true);
    expect(hasBlockTokenKey(other.merge(base))).toBe(true);
    expect(hasBlockTokenKey(base.optional().nullable().default({ blockToken: 'x' }))).toBe(true);
    expect(hasBlockTokenKey(z.intersection(other, base))).toBe(true);
    expect(hasBlockTokenKey(z.union([other, base]))).toBe(true);
    expect(hasBlockTokenKey(z.preprocess((v) => v, base))).toBe(true);
    expect(hasBlockTokenKey(base.transform((v) => v))).toBe(true);
    expect(hasBlockTokenKey(z.lazy(() => base))).toBe(true);
    // Negative: same machinery, no token anywhere.
    expect(hasBlockTokenKey(z.intersection(other, z.object({ id: z.number() })))).toBe(false);
    expect(hasBlockTokenKey({ notAZodSchema: true })).toBeNull();
  });
});
