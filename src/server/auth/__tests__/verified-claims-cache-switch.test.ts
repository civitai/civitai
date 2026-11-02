import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// The main app's wiring of the verification cache switch: `sessionClient` hands the package a switch that reads
// the AUTH_VERIFIED_CLAIMS_CACHE Flipt flag with NO entity id (one cached global evaluation per process), and
// anything other than a definite `true` — including an unwarmed client's null — reads as off.
const h = vi.hoisted(() => ({
  isFliptSync: vi.fn<(flag: string, ...rest: unknown[]) => boolean | null>(),
  getFliptClientSync: vi.fn<() => object | null>(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  sessionClientConfigs: [] as unknown[],
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { AUTH_VERIFIED_CLAIMS_CACHE: 'auth-verified-claims-cache' },
  isFliptSync: h.isFliptSync,
  getFliptClientSync: h.getFliptClientSync,
  ensureFliptInitialized: h.ensureFliptInitialized,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: { set: vi.fn() },
  REDIS_SYS_KEYS: { SESSION: { LEGACY_UPGRADE_LOCK: 'session:legacy-upgrade-lock' } },
  withSysReadDeadline: (p: Promise<unknown>) => p,
}));
vi.mock('../session-verifier', () => ({ isRevoked: vi.fn() }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return {
    ...actual,
    createSessionClient: (config: unknown) => {
      h.sessionClientConfigs.push(config);
      return actual.createSessionClient(config as CivitaiAuth.SessionClientConfig);
    },
  };
});

import { isVerifiedClaimsCacheOn } from '../session-client';
import { isRevoked } from '../session-verifier';

beforeEach(() => {
  h.isFliptSync.mockReset();
  h.getFliptClientSync.mockReset().mockReturnValue({});
  h.ensureFliptInitialized.mockClear();
});

describe('AUTH_VERIFIED_CLAIMS_CACHE wiring', () => {
  it('sessionClient is built with the switch AND the revocation check', () => {
    expect(h.sessionClientConfigs).toHaveLength(1);
    const config = h.sessionClientConfigs[0] as CivitaiAuth.SessionClientConfig;
    expect(config.claimsCache?.enabled).toBe(isVerifiedClaimsCacheOn);
    expect(config.isRevoked).toBe(isRevoked);
  });

  it('reads the flag by its key with no entity id or context', () => {
    h.isFliptSync.mockReturnValue(true);
    isVerifiedClaimsCacheOn();
    expect(h.isFliptSync).toHaveBeenCalledTimes(1);
    expect(h.isFliptSync.mock.calls[0]).toEqual(['auth-verified-claims-cache']);
  });

  it.each([
    [true, true],
    [false, false],
    [null, false], // unwarmed Flipt client
  ] as const)('flag %s → cache %s', (flag, expected) => {
    h.isFliptSync.mockReturnValue(flag);
    expect(isVerifiedClaimsCacheOn()).toBe(expected);
  });

  it('an uninitialised Flipt client reads off AND starts initialising, so the switch is not inert', () => {
    h.isFliptSync.mockReturnValue(null);
    h.getFliptClientSync.mockReturnValue(null);
    expect(isVerifiedClaimsCacheOn()).toBe(false);
    expect(h.ensureFliptInitialized).toHaveBeenCalledTimes(1);
  });

  it('a live client does not re-trigger initialisation', () => {
    h.isFliptSync.mockReturnValue(false);
    isVerifiedClaimsCacheOn();
    expect(h.ensureFliptInitialized).not.toHaveBeenCalled();
  });
});
