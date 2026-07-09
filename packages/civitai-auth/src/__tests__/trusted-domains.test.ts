import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTrustedDomainRegistry, type TrustedDomain } from '../trusted-domains';

const rows = (...entries: [string, boolean][]): TrustedDomain[] =>
  entries.map(([domain, includeSubdomains]) => ({ domain, includeSubdomains }));

describe('createTrustedDomainRegistry', () => {
  describe('caching', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('loads at most once per TTL window, then re-queries after it elapses', async () => {
      const load = vi.fn(async () => rows(['civitai.com', false]));
      const reg = createTrustedDomainRegistry({ load, ttlMs: 1000 });

      await reg.list();
      await reg.list();
      expect(load).toHaveBeenCalledTimes(1); // second read served from cache

      vi.advanceTimersByTime(1001);
      await reg.list();
      expect(load).toHaveBeenCalledTimes(2); // TTL elapsed → re-query
    });

    it('coalesces concurrent refreshes into a single load', async () => {
      const load = vi.fn(async () => rows(['civitai.com', false]));
      const reg = createTrustedDomainRegistry({ load });
      await Promise.all([reg.list(), reg.list(), reg.list()]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces the next read to re-query', async () => {
      const load = vi.fn(async () => rows(['civitai.com', false]));
      const reg = createTrustedDomainRegistry({ load, ttlMs: 60_000 });
      await reg.list();
      reg.invalidate();
      await reg.list();
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('serves an empty list (fail-safe) when the loader throws and nothing is cached', async () => {
      const load = vi.fn(async () => {
        throw new Error('db down');
      });
      const reg = createTrustedDomainRegistry({ load });
      expect(await reg.list()).toEqual([]);
    });
  });

  describe('matchesHost (OAuth trust — no owned backstop)', () => {
    it('matches exact registry hosts and includeSubdomains, plus alwaysTrust hosts', async () => {
      const reg = createTrustedDomainRegistry({
        load: async () => rows(['civitai.com', false], ['civitaic.com', true]),
        alwaysTrustHosts: ['localhost'],
      });
      expect(await reg.matchesHost('civitai.com')).toBe(true); // exact
      expect(await reg.matchesHost('pr-1.civitaic.com')).toBe(true); // includeSubdomains
      expect(await reg.matchesHost('localhost')).toBe(true); // alwaysTrust
      expect(await reg.matchesHost('moderator.civitai.com')).toBe(false); // subdomain, but row is includeSubdomains:false
      expect(await reg.matchesHost('evil.com')).toBe(false);
    });
  });

  describe('ownedOriginCheck (redirect guard — registry ∪ owned-eTLD+1 backstop)', () => {
    it('allows registered hosts, owned-domain subdomains via the backstop, and dev loopback', async () => {
      const reg = createTrustedDomainRegistry({
        load: async () => rows(['civitai.xyz', false]), // a NEW domain, only in the registry (not in CIVITAI_OWNED_DOMAINS)
        alwaysTrustHosts: ['localhost'],
      });
      const allowed = await reg.ownedOriginCheck();
      expect(allowed('https://civitai.xyz')).toBe(true); // registry-only domain — the point of the consolidation
      expect(allowed('https://moderator.civitai.com')).toBe(true); // backstop (*.civitai.com), no registry row needed
      expect(allowed('https://civitai.red')).toBe(true); // backstop
      expect(allowed('http://localhost')).toBe(true); // alwaysTrust
    });

    it('still rejects the open-redirect look-alikes', async () => {
      const reg = createTrustedDomainRegistry({ load: async () => rows(['civitai.xyz', false]) });
      const allowed = await reg.ownedOriginCheck();
      expect(allowed('https://civitai.evil.com')).toBe(false);
      expect(allowed('https://evil-civitai.com')).toBe(false);
      expect(allowed('https://civitai.xyz.attacker.io')).toBe(false); // registry host as a left-label of an attacker domain
      expect(allowed('not a url')).toBe(false);
    });

    it('falls back to the owned backstop when the registry is empty (DB outage)', async () => {
      const reg = createTrustedDomainRegistry({
        load: async () => {
          throw new Error('db down');
        },
      });
      const allowed = await reg.ownedOriginCheck();
      expect(allowed('https://civitai.com')).toBe(true); // backstop keeps cross-origin redirects working
      expect(allowed('https://civitai.xyz')).toBe(false); // not owned, registry unavailable → rejected
    });
  });
});
