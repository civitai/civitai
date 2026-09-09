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

  it('uses the .com Link host on a .com subdomain', () => {
    setHostname('internal.civitai.com');
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

  // Pins the NARROWNESS of the .red matcher, on a host that stays on civitai.com
  // so the same-registrable-domain check cannot mask the result. Widening
  // `endsWith('.civitai.red')` to `includes('civitai.red')` sends this host to
  // link.civitai.red, which is then refused as cross-domain and returns
  // undefined — so this case, and only this case, goes red for that mutant.
  it('does not treat a .com host containing "civitai.red" as a .red host', () => {
    setHostname('civitai.redirect.civitai.com');
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.com');
  });

  it('falls back to the baked .com host when no location is available (SSR)', () => {
    setHostname(undefined);
    expect(getCivitaiLinkBaseUrl()).toBe('https://link.civitai.com');
  });

  // The Link service authenticates only via the civitai session cookie, which is
  // Domain-scoped to the page's registrable domain. On any other registrable
  // domain no credential is sent and the service answers 401 — which is what
  // surfaced as "Error loading instances: Civitai Link request failed (401 )".
  // Returning undefined lets the provider disable the feature instead.
  describe('refuses an origin whose cookie cannot reach the Link host', () => {
    it('returns undefined on a PR preview host', () => {
      setHostname('pr-4251.civitaic.com');
      expect(getCivitaiLinkBaseUrl()).toBeUndefined();
    });

    it('returns undefined on the bare preview domain', () => {
      setHostname('civitaic.com');
      expect(getCivitaiLinkBaseUrl()).toBeUndefined();
    });

    // No link.civitai.green host exists, and the .red rewrite does not cover it.
    it('returns undefined on civitai.green', () => {
      setHostname('civitai.green');
      expect(getCivitaiLinkBaseUrl()).toBeUndefined();
    });

    // Doubles as the lookalike guard: the .red rewrite must not fire for a host
    // that merely CONTAINS civitai.red, and the resulting .com base must then be
    // refused because evil.com is a different registrable domain.
    it('returns undefined for a lookalike host that merely contains civitai.red', () => {
      setHostname('civitai.red.evil.com');
      expect(getCivitaiLinkBaseUrl()).toBeUndefined();
    });
  });
});
