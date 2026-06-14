import { describe, it, expect, vi } from 'vitest';

/**
 * Unit coverage for the shared same-origin allowlist used by both the tRPC
 * context (createContext) and the raw /api/blocks/submit-version route. The
 * allowlist Set is built at module load, so the env + server-host inputs are
 * mocked via vi.hoisted before the module under test is imported.
 */

const { mockEnv, mockHosts } = vi.hoisted(() => ({
  mockEnv: {
    TRPC_ORIGINS: ['https://trpc-allowed.example'] as string[],
    NEXTAUTH_URL: 'https://auth.example',
  },
  mockHosts: ['civitai.com', 'Civitai.RED'] as string[],
}));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/server/utils/server-domain', () => ({
  getAllServerHosts: () => mockHosts,
}));

import { hostFromUrl, isAllowedOriginRequest } from '../origin-helpers';

function req(headers: { origin?: string; referer?: string }) {
  return { headers };
}

describe('hostFromUrl', () => {
  it('lowercases the host', () => {
    expect(hostFromUrl('https://Civitai.COM/path')).toBe('civitai.com');
  });

  it('returns undefined for undefined / invalid input', () => {
    expect(hostFromUrl(undefined)).toBeUndefined();
    expect(hostFromUrl('not a url')).toBeUndefined();
  });
});

describe('isAllowedOriginRequest', () => {
  it('accepts a request whose Origin host is in the allowlist', () => {
    expect(isAllowedOriginRequest(req({ origin: 'https://civitai.com' }))).toBe(true);
  });

  it('accepts hosts contributed by TRPC_ORIGINS and NEXTAUTH_URL', () => {
    expect(isAllowedOriginRequest(req({ origin: 'https://trpc-allowed.example' }))).toBe(true);
    expect(isAllowedOriginRequest(req({ origin: 'https://auth.example' }))).toBe(true);
  });

  it('rejects a foreign origin', () => {
    expect(isAllowedOriginRequest(req({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('rejects when both Origin and Referer are absent', () => {
    expect(isAllowedOriginRequest(req({}))).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(isAllowedOriginRequest(req({ referer: 'https://civitai.com/some/page' }))).toBe(true);
    expect(isAllowedOriginRequest(req({ referer: 'https://evil.example/x' }))).toBe(false);
  });

  it('prefers Origin over Referer', () => {
    // Foreign Origin must reject even when Referer would have passed.
    expect(
      isAllowedOriginRequest(
        req({ origin: 'https://evil.example', referer: 'https://civitai.com' })
      )
    ).toBe(false);
  });

  it('compares hosts case-insensitively (both sides lowercased)', () => {
    // Allowlist entry "Civitai.RED" is lowercased at build time; a mixed-case
    // request host must still match.
    expect(isAllowedOriginRequest(req({ origin: 'https://CIVITAI.red' }))).toBe(true);
  });
});
