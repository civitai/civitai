import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `admin.ts` parses AUTH_ADMIN_USER_IDS once at module load and documents that it fails CLOSED — a missing or
 * unusable value must grant nobody, never everybody. Nothing exercised that: the guard suite always sets a
 * populated allowlist, so a "no admins configured means no restriction" regression passed every test there.
 *
 * Each case re-imports the module under a different env, since the allowlist is built at load.
 */
async function loadWith(value: string | undefined) {
  vi.resetModules();
  const previous = process.env.AUTH_ADMIN_USER_IDS;
  if (value === undefined) delete process.env.AUTH_ADMIN_USER_IDS;
  else process.env.AUTH_ADMIN_USER_IDS = value;
  try {
    return await import('$lib/server/auth/admin');
  } finally {
    if (previous === undefined) delete process.env.AUTH_ADMIN_USER_IDS;
    else process.env.AUTH_ADMIN_USER_IDS = previous;
  }
}

afterEach(() => vi.resetModules());

describe('hub admin allowlist', () => {
  // Positive control: proves this loader can produce a populated allowlist, so the empty results below are
  // a fact about the parsing and not about the harness.
  it('admits a listed id when the allowlist is populated', async () => {
    const { ADMIN_USER_IDS, isHubAdmin } = await loadWith('1,5');

    expect([...ADMIN_USER_IDS].sort()).toEqual([1, 5]);
    expect(isHubAdmin({ id: 5 })).toBe(true);
    expect(isHubAdmin({ id: 9 })).toBe(false);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['non-numeric', 'admin,root'],
    ['zero and negative', '0,-1'],
    ['separators only', ',,,'],
  ])('grants nobody when the allowlist is %s', async (_label, value) => {
    const { ADMIN_USER_IDS, isHubAdmin } = await loadWith(value);

    expect(ADMIN_USER_IDS.size).toBe(0);
    expect(isHubAdmin({ id: 1 })).toBe(false);
    expect(isHubAdmin({ id: 0 })).toBe(false);
  });

  it('keeps only the valid ids when the value is partly unusable', async () => {
    const { ADMIN_USER_IDS, isHubAdmin } = await loadWith('1,abc,-2,7');

    expect([...ADMIN_USER_IDS].sort()).toEqual([1, 7]);
    expect(isHubAdmin({ id: 1 })).toBe(true);
    expect(isHubAdmin({ id: 2 })).toBe(false);
  });

  it('admits nobody when there is no user, whatever the allowlist says', async () => {
    const { isHubAdmin } = await loadWith('1');

    expect(isHubAdmin(undefined)).toBe(false);
    expect(isHubAdmin(null)).toBe(false);
  });
});
