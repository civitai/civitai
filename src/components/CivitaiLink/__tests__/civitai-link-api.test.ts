import { afterEach, describe, expect, it, vi } from 'vitest';

// `civitai-link-api` reads `env.NEXT_PUBLIC_CIVITAI_LINK` at call time. Stub the
// client env module before importing so we don't trip the zod schema check in
// `~/env/client`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_CIVITAI_LINK: 'https://link.civitai.com',
  },
}));

import { getCivitaiLinkBaseUrl } from '~/components/CivitaiLink/civitai-link-api';

const setHostname = (hostname: string | undefined) => {
  // Emulate window/SharedWorker `globalThis.location.hostname`.
  Object.defineProperty(globalThis, 'location', {
    value: hostname === undefined ? undefined : { hostname },
    configurable: true,
    writable: true,
  });
};

describe('getCivitaiLinkBaseUrl', () => {
  afterEach(() => {
    setHostname(undefined);
  });

  it('uses the .com Link host on civitai.com', () => {
    setHostname('civitai.com');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.com');
  });

  it('rewrites to the .red Link host on civitai.red', () => {
    setHostname('civitai.red');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.red');
  });

  it('rewrites to the .red Link host on a .red subdomain', () => {
    setHostname('internal.civitai.red');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.red');
  });

  it('is case-insensitive about the host', () => {
    setHostname('Civitai.Red');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.red');
  });

  it('does not match a lookalike host that merely contains civitai.red', () => {
    setHostname('civitai.red.evil.com');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.com');
  });

  it('falls back to the baked .com host when no location is available', () => {
    setHostname(undefined);
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.com');
  });
});
