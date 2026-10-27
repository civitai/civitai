import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts reads process.env at module scope, so each case re-imports it with the env stubbed.
async function assertWith(vars: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('NOTIFICATION_DB_URL', 'postgres://x');
  vi.stubEnv('DATABASE_REPLICA_URL', 'postgres://y');
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  const { assertRequiredEnv } = await import('../env');
  return () => assertRequiredEnv();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('assertRequiredEnv: notices token', () => {
  it('boots in production with two distinct tokens', async () => {
    const run = await assertWith({
      NODE_ENV: 'production',
      NOTIFICATIONS_TOKEN: 'a',
      NOTIFICATIONS_NOTICES_TOKEN: 'b',
    });
    expect(run).not.toThrow();
  });

  it('refuses to boot in production without the notices token', async () => {
    const run = await assertWith({
      NODE_ENV: 'production',
      NOTIFICATIONS_TOKEN: 'a',
      NOTIFICATIONS_NOTICES_TOKEN: '',
    });
    expect(run).toThrow(/NOTIFICATIONS_NOTICES_TOKEN/);
  });

  it('refuses to boot when the notices token equals the producer token', async () => {
    const run = await assertWith({
      NODE_ENV: 'development',
      NOTIFICATIONS_TOKEN: 'same',
      NOTIFICATIONS_NOTICES_TOKEN: 'same',
    });
    expect(run).toThrow(/must differ/);
  });
});
