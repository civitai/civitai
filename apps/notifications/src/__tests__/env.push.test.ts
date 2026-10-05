import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `env.ts` reads process.env at MODULE SCOPE, so every case here has to re-import the module with
// a fresh registry — asserting against a single top-level import would only ever measure whatever
// the environment happened to hold when the suite started.
async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return await import('../env');
}

const TOUCHED = [
  'PUSH_DAILY_CAP',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'MAIN_APP_URL',
  'MAIN_APP_WEBHOOK_TOKEN',
  'DATABASE_URL',
  'NOTIFICATION_DB_URL',
  'DATABASE_REPLICA_URL',
  'NOTIFICATIONS_TOKEN',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe('pushDailyCap', () => {
  it('defaults to 20 when unset', async () => {
    const env = await loadEnv({ PUSH_DAILY_CAP: undefined });
    expect(env.pushDailyCap).toBe(20);
  });

  it('takes a valid non-negative integer', async () => {
    expect((await loadEnv({ PUSH_DAILY_CAP: '5' })).pushDailyCap).toBe(5);
    expect((await loadEnv({ PUSH_DAILY_CAP: '0' })).pushDailyCap).toBe(0);
    expect((await loadEnv({ PUSH_DAILY_CAP: '250' })).pushDailyCap).toBe(250);
  });

  // The whole point of the guard. `Number('twenty')` is NaN, and every comparison in checkQuota
  // against NaN is false — so the first push of the day falls through to 'skip' and EVERY push is
  // dropped under outcome="capped", for every user, with nothing logged.
  it.each([
    ['a non-numeric value', 'twenty'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a negative cap', '-1'],
    ['a fractional cap', '2.5'],
    ['a trailing-garbage value', '20abc'],
  ])('falls back to the default rather than disabling push on %s', async (_label, raw) => {
    const env = await loadEnv({ PUSH_DAILY_CAP: raw });
    expect(env.pushDailyCap).toBe(20);
    expect(Number.isInteger(env.pushDailyCap)).toBe(true);
  });
});

describe('assertRequiredEnv', () => {
  const pushConfigured = {
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    MAIN_APP_URL: 'http://main.test',
    MAIN_APP_WEBHOOK_TOKEN: 'tok',
    NOTIFICATION_DB_URL: 'postgres://x/y',
    DATABASE_REPLICA_URL: 'postgres://x/y',
    NOTIFICATIONS_TOKEN: 'n',
  };

  it('rejects a push-configured worker with no DATABASE_URL', async () => {
    const env = await loadEnv({ ...pushConfigured, DATABASE_URL: undefined });
    expect(env.pushEnabled).toBe(true);
    // Without this the worker boots Ready and every send succeeds, while all bookkeeping
    // (lastSuccessAt, the failure streak, deleting 410'd endpoints) silently no-ops — each call
    // swallowed by `bestEffort`.
    expect(() => env.assertRequiredEnv()).toThrow(/DATABASE_URL/);
  });

  it('accepts a push-configured worker that has DATABASE_URL', async () => {
    const env = await loadEnv({ ...pushConfigured, DATABASE_URL: 'postgres://x/y' });
    expect(env.pushEnabled).toBe(true);
    expect(() => env.assertRequiredEnv()).not.toThrow();
  });

  it('does not require DATABASE_URL when push is not configured', async () => {
    const env = await loadEnv({
      ...pushConfigured,
      VAPID_PRIVATE_KEY: undefined,
      DATABASE_URL: undefined,
    });
    expect(env.pushEnabled).toBe(false);
    expect(() => env.assertRequiredEnv()).not.toThrow();
  });
});
