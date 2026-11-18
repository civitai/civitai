import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `request-origin.ts` reads a request's region and client address with the site's own helpers.
 * The region rules are configured from `REGION_RESTRICTION_CONFIG` and `REGION_BLOCK_CONFIG`
 * when the site's module loads, so each case loads it afresh under the configuration it sets.
 */
async function load(config: string | undefined, blocked?: string) {
  vi.resetModules();
  // Empty is unset to the site's parser, which then takes its own default.
  vi.stubEnv('REGION_RESTRICTION_CONFIG', config ?? '');
  vi.stubEnv('REGION_BLOCK_CONFIG', blocked ?? '');
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
    // Unlike the site: a request whose region cannot be told is held to SFW (fail closed).
    ['no region headers', true, {}],
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

describe('🔴 a request whose country cannot be told is held to SFW (fail closed)', () => {
  it.each([
    ['no headers at all', {}],
    ['an empty cf-ipcountry', { 'cf-ipcountry': '' }],
    ['the edge’s XX, country unknown', { 'cf-ipcountry': 'XX' }],
    ['the edge’s XX, lowercase', { 'cf-ipcountry': 'xx' }],
    ['the edge’s T1, Tor', { 'cf-ipcountry': 'T1' }],
    ['a repeated header joined into one value', { 'cf-ipcountry': 'DE, FR' }],
    ['not a two-letter code', { 'cf-ipcountry': 'DEU' }],
    ['a region code with no country', { 'cf-region-code': 'CA' }],
    ['an x-isuk that is not set', { 'x-isuk': 'false' }],
  ])('%s: held', async (_name, headers) => {
    // No list names any of these, so only the no-country rule can hold them.
    const { regionRestricted } = await load('ZZ:2026-01-01', 'ZX:2026-01-01');
    expect(regionRestricted({ headers }, NOW)).toBe(true);
  });

  it.each([
    ['US', { 'cf-ipcountry': 'US' }],
    ['US with a state no list names', { 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }],
    ['DE', { 'cf-ipcountry': 'DE' }],
    ['de, lowercase', { 'cf-ipcountry': 'de' }],
  ])('positive control: a known country no list names (%s) is not held', async (_n, headers) => {
    const { regionRestricted } = await load('ZZ:2026-01-01', 'ZX:2026-01-01');
    expect(regionRestricted({ headers }, NOW)).toBe(false);
  });

  it('a restricted and a blocked country are still held', async () => {
    const { regionRestricted } = await load('ZZ:2026-01-01', 'ZX:2026-01-01');
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZZ' } }, NOW)).toBe(true);
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZX' } }, NOW)).toBe(true);
  });

  it('with no restriction list, no region is still held', async () => {
    const { regionRestricted } = await load(undefined);
    expect(regionRestricted({ headers: {} }, NOW)).toBe(true);
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'DE' } }, NOW)).toBe(false);
  });
});

describe('🔴 a region the site blocks is held to SFW as well', () => {
  it.each([
    // The site's default block list: GB from 2025-07-24, AU from 2026-03-15.
    ['GB, by default', true, { 'cf-ipcountry': 'GB' }, NOW],
    ['GB through the site’s x-isuk header', true, { 'x-isuk': 'true' }, NOW],
    ['AU, by default, after its date', true, { 'cf-ipcountry': 'AU' }, NOW],
    ['AU, by default, before its date', false, { 'cf-ipcountry': 'AU' }, new Date('2026-03-01')],
    ['another country', false, { 'cf-ipcountry': 'DE' }, NOW],
  ])('%s: held = %s', async (_name, held, headers, at) => {
    const { regionRestricted } = await load(undefined);
    expect(regionRestricted({ headers }, at)).toBe(held);
  });

  it('a configured block list replaces the default', async () => {
    const { regionRestricted } = await load(undefined, 'ZX:2026-01-01');
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'ZX' } }, NOW)).toBe(true);
    expect(regionRestricted({ headers: { 'cf-ipcountry': 'GB' } }, NOW)).toBe(false);
  });
});

describe('🔴 meta is ignored until REGISTRY_ADAPTER_TRUST_META is 1', () => {
  it.each([
    ['unset', undefined],
    ['0', '0'],
    ['true (only "1" turns it on)', 'true'],
  ])(
    'flag %s: meta DE does not release the header GB, nor an origin with no headers',
    async (_name, flag) => {
      vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', flag);
      const { regionRestricted } = await load(undefined);
      expect(
        regionRestricted({ headers: { 'cf-ipcountry': 'GB' }, meta: { country: 'DE' } }, NOW)
      ).toBe(true);
      expect(regionRestricted({ headers: {}, meta: { country: 'DE' } }, NOW)).toBe(true);
    }
  );

  it('positive control: with the flag at 1 the same meta DE releases both', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { regionRestricted } = await load(undefined);
    expect(
      regionRestricted({ headers: { 'cf-ipcountry': 'GB' }, meta: { country: 'DE' } }, NOW)
    ).toBe(false);
    expect(regionRestricted({ headers: {}, meta: { country: 'DE' } }, NOW)).toBe(false);
  });
});

describe('🔴 a region value in the request’s meta is judged as its header is', () => {
  beforeEach(() => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
  });

  it.each([
    ['meta GB, no headers: held', true, { country: 'GB' }, {}],
    // `x-isuk` comes from no edge the gateway sits behind, so it has no meta key: a caller's own
    // `isuk` is not read.
    [
      'meta isuk is not read: meta DE with isuk is not held',
      false,
      { country: 'DE', isuk: 'true' },
      {},
    ],
    ['positive control: meta DE, no headers: not held', false, { country: 'DE' }, {}],
    [
      'meta XX, header DE: meta wins and names no country',
      true,
      { country: 'XX' },
      { 'cf-ipcountry': 'DE' },
    ],
    ['meta DE wins over the header GB', false, { country: 'DE' }, { 'cf-ipcountry': 'GB' }],
    ['meta GB wins over the header DE', true, { country: 'GB' }, { 'cf-ipcountry': 'DE' }],
    ['no meta: the header GB decides', true, undefined, { 'cf-ipcountry': 'GB' }],
    ['no meta: the header DE decides', false, undefined, { 'cf-ipcountry': 'DE' }],
    [
      'meta without the key: the header GB decides',
      true,
      { locale: 'en' },
      { 'cf-ipcountry': 'GB' },
    ],
    ['a country that is not a string, no headers: held', true, { country: 5 }, {}],
    [
      'a country that is not a string: the header DE decides',
      false,
      { country: ['GB'] },
      { 'cf-ipcountry': 'DE' },
    ],
  ])('%s', async (_name, held, meta, headers) => {
    const { regionRestricted } = await load(undefined);
    expect(regionRestricted({ headers, meta }, NOW)).toBe(held);
  });

  it.each([
    ['a configured US state', true, 'NY'],
    ['another US state', false, 'CA'],
  ])('meta region, %s: held = %s', async (_name, held, region) => {
    const { regionRestricted } = await load('US:NY:2026-01-01');
    expect(regionRestricted({ headers: {}, meta: { country: 'US', region } }, NOW)).toBe(held);
  });

  it.each([
    ['not JSON', '{"country":"DE"'],
    ['an array', '["DE"]'],
    ['a number', '7'],
    ['null', 'null'],
  ])('meta that is %s is none: held with no headers', async (_name, raw) => {
    const { regionRestricted } = await load(undefined);
    const { subscribeRequest } = await import('~/server/registry-adapter/protocol');
    const { meta } = subscribeRequest({ schema: 's', cursor: '', urns: [], filter: '', meta: raw });
    expect(meta).toBeUndefined();
    expect(regionRestricted({ headers: {}, meta }, NOW)).toBe(true);
  });

  it('positive control: the same request with object meta DE, as text or bytes, is not held', async () => {
    const { regionRestricted } = await load(undefined);
    const { subscribeRequest } = await import('~/server/registry-adapter/protocol');
    for (const raw of ['{"country":"DE"}', Buffer.from('{"country":"DE"}', 'utf8')]) {
      const { meta } = subscribeRequest({
        schema: 's',
        cursor: '',
        urns: [],
        filter: '',
        meta: raw,
      });
      expect(regionRestricted({ headers: {}, meta }, NOW)).toBe(false);
    }
  });
});

describe('🔴 describeRegion: the decision each subscription logs', () => {
  // Header CA and meta DE are distinct, so a source read from the wrong place shows.
  const CA_DE = { headers: { 'cf-ipcountry': 'CA' }, meta: { country: 'DE' } };

  it('flag on: meta wins over the header', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load(undefined);
    expect(describeRegion(CA_DE, NOW)).toEqual({
      country: 'DE',
      region: undefined,
      source: 'meta',
      restricted: false,
    });
  });

  it('flag off: meta is ignored and the header decides', async () => {
    const { describeRegion } = await load(undefined);
    expect(describeRegion(CA_DE, NOW)).toEqual({
      country: 'CA',
      region: undefined,
      source: 'header',
      restricted: false,
    });
  });

  it('flag on, meta without a country: the header decides', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load(undefined);
    expect(
      describeRegion({ headers: { 'cf-ipcountry': 'CA' }, meta: { locale: 'en' } }, NOW).source
    ).toBe('header');
  });

  it('no country anywhere: none, held', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load(undefined);
    expect(describeRegion({ headers: {}, meta: { locale: 'en' } }, NOW)).toEqual({
      country: 'none',
      source: 'none',
      restricted: true,
    });
  });

  it.each([
    ['the edge’s XX', 'XX'],
    ['a value that is not a code is never echoed', 'DE, FR'],
  ])('%s: country none from the header, held', async (_name, value) => {
    const { describeRegion } = await load(undefined);
    expect(describeRegion({ headers: { 'cf-ipcountry': value } }, NOW)).toEqual({
      country: 'none',
      source: 'header',
      restricted: true,
    });
  });

  it('a restricted region from the header: held, with its region code', async () => {
    const { describeRegion } = await load('US:NY:2026-01-01');
    expect(
      describeRegion({ headers: { 'cf-ipcountry': 'US', 'cf-region-code': 'NY' } }, NOW)
    ).toEqual({ country: 'US', region: 'NY', source: 'header', restricted: true });
  });

  it('a restricted region from meta: held, meta over the header FR', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load('US:NY:2026-01-01');
    expect(
      describeRegion(
        { headers: { 'cf-ipcountry': 'FR' }, meta: { country: 'US', region: 'NY' } },
        NOW
      )
    ).toEqual({ country: 'US', region: 'NY', source: 'meta', restricted: true });
  });

  it('positive control: another US state from meta is not held', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load('US:NY:2026-01-01');
    expect(describeRegion({ headers: {}, meta: { country: 'US', region: 'CA' } }, NOW)).toEqual({
      country: 'US',
      region: 'CA',
      source: 'meta',
      restricted: false,
    });
  });

  it('a region code that is not one is left out', async () => {
    const { describeRegion } = await load(undefined);
    expect(
      describeRegion({ headers: { 'cf-ipcountry': 'US', 'cf-region-code': 'New York' } }, NOW)
        .region
    ).toBeUndefined();
  });

  it('the site’s x-isuk over a meta country is the header’s GB', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion } = await load(undefined);
    expect(describeRegion({ headers: { 'x-isuk': 'true' }, meta: { country: 'DE' } }, NOW)).toEqual(
      { country: 'GB', region: undefined, source: 'header', restricted: true }
    );
  });

  it('flag on, meta with an empty country: meta overrides the header CA, none, held', async () => {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', '1');
    const { describeRegion, regionLine } = await load(undefined);
    const decision = describeRegion(
      { headers: { 'cf-ipcountry': 'CA' }, meta: { country: '' } },
      NOW
    );
    expect(decision).toEqual({ country: 'none', source: 'meta', restricted: true });
    expect(regionLine('http', decision)).toBe(
      'subscription region: binding=http country=none region=none source=meta restricted=true'
    );
  });
});

describe('regionLine: the logged line', () => {
  it('pins the format, a region code included', async () => {
    const { regionLine } = await load(undefined);
    expect(
      regionLine('grpc', { country: 'US', region: 'NY', source: 'header', restricted: true })
    ).toBe('subscription region: binding=grpc country=US region=NY source=header restricted=true');
  });
});

describe('describeRegionConfig: the startup lines', () => {
  it('names both lists, with no warning when a region is restricted', async () => {
    const { describeRegionConfig } = await load('ZZ:2026-01-01,US:NY:2026-02-01');
    expect(describeRegionConfig()).toEqual({
      info: [
        'SFW-restricted regions (2): ZZ from 2026-01-01, US:NY from 2026-02-01',
        'blocked regions, held to SFW (2): GB from 2025-07-24, AU from 2026-03-15',
      ],
      warn: [],
    });
  });

  it('warns when the restriction list is empty', async () => {
    const { describeRegionConfig } = await load(undefined, 'ZX:2026-01-01');
    expect(describeRegionConfig()).toEqual({
      info: [
        'SFW-restricted regions (0): none',
        'blocked regions, held to SFW (1): ZX from 2026-01-01',
      ],
      warn: [
        'REGION_RESTRICTION_CONFIG is empty or unset: no region is restricted to SFW ' +
          '(blocked regions, and requests with no region, still are); set it as the site does',
      ],
    });
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
