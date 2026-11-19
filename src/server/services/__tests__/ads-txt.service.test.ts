import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADS_TXT_SOURCES,
  AdsTxtUnavailableError,
  buildAdsTxt,
  judgeAdsTxtBody,
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

const clock = { now: new Date('2026-11-17T20:00:00Z') };
const HOUR = 60 * 60 * 1000;
const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

function fakeDeps(overrides: Partial<AdsTxtDeps> & { bodies?: Record<string, string> } = {}) {
  const store = new Map<string, Parameters<AdsTxtDeps['setLastGood']>[1]>();
  const bodies = overrides.bodies ?? { [SNIGEL.url]: snigelBody, [SPARTEO.url]: sparteoBody };
  const deps: AdsTxtDeps = {
    fetchSource: async (url) =>
      url in bodies
        ? { status: 200, contentType: 'text/plain', body: bodies[url] }
        : { status: 500, contentType: 'text/plain', body: '' },
    getLastGood: async (name) => store.get(name),
    setLastGood: async (name, value) => void store.set(name, value),
    now: () => clock.now,
    log: vi.fn(),
    ...overrides,
  };
  return { deps, store };
}

const recordLines = (text: string) =>
  text.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes('='));

describe('mergeAdsTxt', () => {
  const merged = mergeAdsTxt([
    { name: 'snigel', body: snigelBody, note: 'fetched t1' },
    { name: 'sparteo', body: sparteoBody, note: 'fetched t2' },
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
    expect(merged.match(/^OWNERDOMAIN=.*$/gim)).toEqual(['OWNERDOMAIN=civitai.com']);
    expect(merged.match(/^MANAGERDOMAIN=.*$/gim)).toEqual(['MANAGERDOMAIN=snigelweb.com']);
    expect(merged).toContain('\nCONTACT=ads@partner-a.test\n');
  });
});

describe('judgeAdsTxtBody', () => {
  it('rejects an HTML page served with a 200', () => {
    expect(judgeAdsTxtBody('<!DOCTYPE html><html>google.com, 1, DIRECT</html>', 'text/plain')).toBe(
      'invalid'
    );
    expect(judgeAdsTxtBody(snigelBody, 'text/html; charset=utf-8')).toBe('invalid');
  });

  it('flags a body that lost more than half of its last good records', () => {
    expect(judgeAdsTxtBody('google.com, pub-111, DIRECT', 'text/plain', 3)).toBe('shrunk');
    expect(judgeAdsTxtBody(snigelBody, 'text/plain', 3)).toBe('ok');
    // Exactly half is kept.
    expect(judgeAdsTxtBody('a.com, 1, DIRECT\nb.com, 2, DIRECT', 'text/plain', 4)).toBe('ok');
  });
});

describe('buildAdsTxt', () => {
  beforeEach(() => {
    clock.now = new Date('2026-11-17T20:00:00Z');
  });

  const shrunkSnigel = 'google.com, pub-111, DIRECT';
  const withSnigel = (deps: AdsTxtDeps, response: { status: number; body: string }) => ({
    ...deps,
    fetchSource: async (url: string) =>
      url === SNIGEL.url ? { ...response, contentType: 'text/plain' } : deps.fetchSource(url),
  });

  it('keeps serving the stored copy when a source suddenly loses most of its records', async () => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const file = await buildAdsTxt(withSnigel(deps, { status: 200, body: shrunkSnigel }));
    expect(file).toContain('appnexus.com, 10040, RESELLER');
    expect(store.get('snigel')?.recordCount).toBe(3);
    expect(store.get('snigel')?.body).toBe(snigelBody);
  });

  it('accepts the smaller file once it has been served for a day', async () => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const shrunk = withSnigel(deps, { status: 200, body: shrunkSnigel });
    await buildAdsTxt(shrunk);
    advance(23 * HOUR);
    expect(recordLines(await buildAdsTxt(shrunk))).toContain('appnexus.com, 10040, RESELLER');
    advance(2 * HOUR);
    const file = await buildAdsTxt(shrunk);
    expect(file).not.toContain('rubiconproject.com');
    expect(store.get('snigel')?.recordCount).toBe(1);
  });

  it('restarts the day of grace when a full file comes back in between', async () => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const shrunk = withSnigel(deps, { status: 200, body: shrunkSnigel });
    expect(await buildAdsTxt(shrunk)).toContain(
      '# snigel (smaller file held back since 2026-11-17T20:00:00.000Z; last good copy confirmed'
    );
    advance(3 * HOUR);
    await buildAdsTxt(deps);
    advance(22 * HOUR);
    expect(recordLines(await buildAdsTxt(shrunk))).toContain('appnexus.com, 10040, RESELLER');
    expect(store.get('snigel')?.recordCount).toBe(3);
  });

  it('writes nothing over a stored copy it could not read', async () => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const blind = withSnigel(
      { ...deps, getLastGood: async () => Promise.reject(new Error('db down')) },
      { status: 200, body: shrunkSnigel }
    );
    await buildAdsTxt(blind);
    expect(store.get('snigel')?.body).toBe(snigelBody);
  });

  it('serves the stored copy when a source answers a non-200 that still looks like a file', async () => {
    const { deps } = fakeDeps();
    await buildAdsTxt(deps);
    const file = await buildAdsTxt(
      withSnigel(deps, { status: 404, body: `${snigelBody}\ngoogle.com, other, DIRECT` })
    );
    expect(file).toContain('appnexus.com, 10040, RESELLER');
    expect(file).not.toContain('google.com, other, DIRECT');
  });

  it('labels a replayed section as such', async () => {
    const { deps } = fakeDeps();
    await buildAdsTxt(deps);
    const file = await buildAdsTxt(withSnigel(deps, { status: 500, body: '' }));
    expect(file).toContain(
      '# snigel (upstream unavailable; last good copy confirmed 2026-11-17T20:00:00.000Z)'
    );
    expect(file).toContain('# sparteo (fetched ');
  });

  it('keeps a healthy, unchanged source confirmed, so its copy is never treated as abandoned', async () => {
    const { deps, store } = fakeDeps();
    await buildAdsTxt(deps);
    const firstFetchedAt = store.get('sparteo')?.fetchedAt;
    advance(7 * HOUR);
    await buildAdsTxt(deps);
    expect(store.get('sparteo')?.checkedAt).toBe(clock.now.toISOString());
    expect(store.get('sparteo')?.fetchedAt).toBe(firstFetchedAt);
    for (let day = 0; day < 8; day++) {
      advance(24 * HOUR);
      await buildAdsTxt(deps);
    }
    const sparteoDown = {
      ...deps,
      fetchSource: async (url: string) =>
        url === SPARTEO.url ? { status: 500, contentType: null, body: '' } : deps.fetchSource(url),
    };
    expect(await buildAdsTxt(sparteoDown)).toContain('flashb.id, f812656a, DIRECT');
  });

  it('drops an optional source gone for over a week, but never the primary seller', async () => {
    const { deps } = fakeDeps();
    await buildAdsTxt(deps);
    advance(8 * 24 * HOUR);
    const allDown = {
      ...deps,
      fetchSource: async () => ({ status: 500, contentType: null, body: '' }),
    };
    const file = await buildAdsTxt(allDown);
    expect(file).not.toContain('# sparteo');
    expect(file).toContain('appnexus.com, 10040, RESELLER');
  });

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
