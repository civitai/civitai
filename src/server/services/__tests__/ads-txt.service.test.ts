import { describe, expect, it, vi } from 'vitest';
import {
  ADS_TXT_SOURCES,
  AdsTxtUnavailableError,
  buildAdsTxt,
  isAcceptableBody,
  mergeAdsTxt,
  type AdsTxtDeps,
} from '~/server/services/ads-txt.service';

const [SNIGEL, SPARTEO] = ADS_TXT_SOURCES;

const snigelBody = [
  '# Ads by a partner',
  'ownerdomain=civitai.com',
  'managerdomain=snigelweb.com',
  'contact=ads@partner-a.test',
  'google.com, pub-111, DIRECT, f08c47fec0942fa0',
  'appnexus.com, 10040, RESELLER',
  'rubiconproject.com, 9999, RESELLER, 0bfd66d529a55807 # trailing comment',
].join('\n');

const sparteoBody = [
  '## START actirise.com ##',
  'MANAGERDOMAIN=sparteo.com',
  'OWNERDOMAIN=civitai.com',
  'APPNEXUS.COM, 10040, reseller',
  'flashb.id, f812656a, DIRECT',
  '## END actirise.com ##',
].join('\n');

function fakeDeps(overrides: Partial<AdsTxtDeps> & { bodies?: Record<string, string> } = {}) {
  const store = new Map<string, { body: string; fetchedAt: string; recordCount: number }>();
  const bodies = overrides.bodies ?? { [SNIGEL.url]: snigelBody, [SPARTEO.url]: sparteoBody };
  const deps: AdsTxtDeps = {
    fetchSource: async (url) =>
      url in bodies
        ? { status: 200, contentType: 'text/plain', body: bodies[url] }
        : { status: 500, contentType: 'text/plain', body: '' },
    getLastGood: async (name) => store.get(name),
    setLastGood: async (name, value) => void store.set(name, value),
    now: () => new Date('2026-11-17T20:00:00Z'),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, store };
}

const recordLines = (text: string) =>
  text.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes('='));

describe('mergeAdsTxt', () => {
  const merged = mergeAdsTxt([
    { name: 'snigel', body: snigelBody, fetchedAt: 't1' },
    { name: 'sparteo', body: sparteoBody, fetchedAt: 't2' },
  ]);

  it('keeps every record from both sources, a record in both once, under the first', () => {
    expect(recordLines(merged)).toEqual([
      'google.com, pub-111, DIRECT, f08c47fec0942fa0',
      'appnexus.com, 10040, RESELLER',
      'rubiconproject.com, 9999, RESELLER, 0bfd66d529a55807',
      'flashb.id, f812656a, DIRECT',
    ]);
    const sparteoSection = merged.slice(merged.indexOf('# sparteo'));
    expect(sparteoSection).not.toMatch(/appnexus/i);
  });

  it('declares one owner domain and one global manager, whatever case the sources use', () => {
    expect(merged.match(/^OWNERDOMAIN=/gim)).toEqual(['OWNERDOMAIN=']);
    expect(merged.match(/^MANAGERDOMAIN=.*$/gim)).toEqual(['MANAGERDOMAIN=snigelweb.com']);
    expect(merged).toContain('\nCONTACT=ads@partner-a.test\n');
  });
});

describe('isAcceptableBody', () => {
  it('rejects an HTML page served with a 200', () => {
    expect(
      isAcceptableBody('<!DOCTYPE html><html>google.com, 1, DIRECT</html>', 'text/plain')
    ).toBe(false);
    expect(isAcceptableBody(snigelBody, 'text/html; charset=utf-8')).toBe(false);
  });

  it('rejects a body that lost more than half of its last good records', () => {
    expect(isAcceptableBody('google.com, pub-111, DIRECT', 'text/plain', 3)).toBe(false);
    expect(isAcceptableBody(snigelBody, 'text/plain', 3)).toBe(true);
  });
});

describe('buildAdsTxt', () => {
  it('merges both sources and stores each as its last good copy', async () => {
    const { deps, store } = fakeDeps();
    const file = await buildAdsTxt(deps);
    expect(recordLines(file)).toHaveLength(4);
    expect(store.get('snigel')?.recordCount).toBe(3);
    expect(store.get('sparteo')?.recordCount).toBe(2);
  });

  it.each([
    ['a 500', async () => ({ status: 500, contentType: 'text/plain', body: '' })],
    [
      'an HTML 200',
      async () => ({ status: 200, contentType: 'text/html', body: '<html>maintenance</html>' }),
    ],
    [
      'a timeout',
      async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    ],
  ])('serves the last good copy of a source after %s', async (_label, failing) => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const failingDeps = {
      ...deps,
      fetchSource: (url: string) => (url === SNIGEL.url ? failing() : deps.fetchSource(url)),
    };
    const file = await buildAdsTxt(failingDeps);
    expect(file).toContain('google.com, pub-111, DIRECT');
    expect(store.get('snigel')?.recordCount).toBe(3);
  });

  it('refuses to build a file without the primary seller', async () => {
    const { deps } = fakeDeps({ bodies: { [SPARTEO.url]: sparteoBody } });
    await expect(buildAdsTxt(deps)).rejects.toBeInstanceOf(AdsTxtUnavailableError);
  });

  it('serves the primary seller alone when the second source has never answered', async () => {
    const { deps } = fakeDeps({ bodies: { [SNIGEL.url]: snigelBody } });
    const file = await buildAdsTxt(deps);
    expect(recordLines(file)).toHaveLength(3);
    expect(file).not.toContain('# sparteo');
  });

  it('still serves a fresh file when the last-good store is down', async () => {
    const { deps } = fakeDeps({
      getLastGood: async () => {
        throw new Error('db down');
      },
      setLastGood: async () => {
        throw new Error('db down');
      },
    });
    expect(recordLines(await buildAdsTxt(deps))).toHaveLength(4);
  });
});
