import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `request-origin.ts` reads a request's region and client address with the site's own helpers.
 * The region rule is configured from `REGION_RESTRICTION_CONFIG` when the site's module loads,
 * so each case loads it afresh under a configuration it sets.
 */
async function load(config: string | undefined) {
  vi.resetModules();
  // Empty is unset to the site's parser, which then takes its own default.
  vi.stubEnv('REGION_RESTRICTION_CONFIG', config ?? '');
  return import('~/server/registry-adapter/request-origin');
}

const NOW = new Date('2026-06-01T12:00:00Z');

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('🔴 regionRestricted is the site’s region-restriction rule', () => {
  it.each([
    ['a configured country', true, { 'cf-ipcountry': 'ZZ' }],
    ['a configured US state', true, { 'cf-ipcountry': 'US', 'cf-region-code': 'NY' }],
    ['another country', false, { 'cf-ipcountry': 'DE' }],
    ['another US state', false, { 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }],
    // As on the site: a request whose region cannot be told is not restricted.
    ['no region headers', false, {}],
  ])('%s: restricted = %s', async (_name, restricted, headers) => {
    const { regionRestricted } = await load('ZZ:2026-01-01,US:NY:2026-01-01');
    expect(regionRestricted({ headers }, NOW)).toBe(restricted);
  });

  it('before its effective date a configured country is not restricted yet', async () => {
    const { regionRestricted } = await load('ZZ:2026-01-01');
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZZ' } }, new Date('2025-12-31'))).toBe(
      false
    );
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZZ' } }, NOW)).toBe(true);
  });

  it('with no configuration nothing is restricted (the site’s default list is empty)', async () => {
    const { regionRestricted } = await load(undefined);
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZZ' } }, NOW)).toBe(false);
  });
});

describe('clientAddress is the site’s rate-limit key', () => {
  it.each([
    [
      'the edge’s address first',
      { 'cf-connecting-ip': '192.0.2.7', 'x-forwarded-for': '198.51.100.1' },
      '192.0.2.7',
    ],
    [
      'then the forwarded chain',
      { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' },
      '198.51.100.1',
    ],
    ['then the peer', {}, '203.0.113.20'],
  ])('%s', async (_name, headers, address) => {
    const { clientAddress } = await load(undefined);
    expect(clientAddress({ headers, remoteAddress: '203.0.113.20' })).toBe(address);
  });

  it('no address at all is the shared unresolved label', async () => {
    const { clientAddress } = await load(undefined);
    expect(clientAddress({ headers: {} })).toBe('unknown');
  });
});

describe('peerAddress reads a gRPC peer string', () => {
  it.each([
    ['192.0.2.7:50123', '192.0.2.7'],
    ['ipv4:192.0.2.7:50123', '192.0.2.7'],
    ['[2001:db8::1]:50123', '2001:db8::1'],
    ['ipv6:[2001:db8::1]:50123', '2001:db8::1'],
    ['unix:/tmp/socket', undefined],
    ['', undefined],
  ])('%j → %j', async (peer, address) => {
    const { peerAddress } = await load(undefined);
    expect(peerAddress(peer)).toBe(address);
  });
});
