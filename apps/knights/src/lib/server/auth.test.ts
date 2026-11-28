import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RevocationCheckConfig } from '@civitai/auth';

const { captured } = vi.hoisted(() => ({ captured: {} as { config?: RevocationCheckConfig } }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@civitai/auth')>();
  return {
    ...actual,
    createRevocationCheck: (config: RevocationCheckConfig) => {
      captured.config = config;
      return actual.createRevocationCheck(config);
    },
  };
});
vi.mock('./metrics', () => ({ metrics: { revocationCheck: vi.fn(), sessionCookieSlot: vi.fn() } }));
vi.mock('./redis', () => ({ getSysRedis: vi.fn() }));

await import('./auth');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('revocation check logging', () => {
  it('logs one countable line with the reason and verdict, and nothing from the session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('READONLY key sess:secret-sid-123'), {
      name: 'RevocationReadTimeout',
    });
    const claims = { sub: '424242', sid: 'secret-sid-123' } as never;

    captured.config!.onError!(err, 'timeout', claims, 'allow_unknown');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[knights] sysredis-fail-open', {
      reason: 'timeout',
      verdict: 'allow_unknown',
      error: 'RevocationReadTimeout',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-sid-123');
    expect(logged).not.toContain('424242');
  });
});
