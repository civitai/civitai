import { describe, it, expect, vi, beforeEach } from 'vitest';

// Production mode: dev mode always-trusts localhost, which would hide the localhost-row path.
vi.mock('$app/environment', () => ({ dev: false }));

const h = vi.hoisted(() => ({
  rows: [] as { domain: string; includeSubdomains: boolean }[],
  logToAxiom: vi.fn((data: Record<string, unknown>) => Promise.resolve(data)),
}));

vi.mock('$lib/server/db/db', () => {
  const qb: Record<string, unknown> = {};
  qb.select = () => qb;
  qb.where = () => qb;
  qb.execute = async () => h.rows;
  return { db: { selectFrom: () => qb } };
});
vi.mock('$lib/server/axiom', () => ({ logToAxiom: h.logToAxiom }));

import { firstPartyClientForOrigin, invalidateDomainCache } from '../first-party';
import { register } from '$lib/server/metrics';

async function originCount(labels: Record<string, string>): Promise<number> {
  const metric = (await register.getMetricsAsJSON()).find(
    (m) => m.name === 'hub_first_party_origin_total'
  );
  const sample = metric?.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels?.[k] === val)
  );
  return sample?.value ?? 0;
}

describe('hub_first_party_origin_total', () => {
  beforeEach(() => {
    h.rows = [
      { domain: 'civitai.red', includeSubdomains: false },
      { domain: 'civitaic.com', includeSubdomains: true },
      { domain: 'localhost', includeSubdomains: false },
    ];
    invalidateDomainCache();
    h.logToAxiom.mockClear();
  });

  it('counts a preview subdomain under its parent row, labeled by call site and scheme', async () => {
    const labels = { entry: 'civitaic.com', use: 'code_exchange', scheme: 'https' };
    const before = await originCount(labels);
    expect(
      await firstPartyClientForOrigin('https://pr-2468.civitaic.com', 'code_exchange')
    ).toBeDefined();
    expect(await originCount(labels)).toBe(before + 1);
    expect(await originCount({ entry: 'pr-2468.civitaic.com' })).toBe(0);
  });

  it('labels each call site separately', async () => {
    const before = await originCount({ entry: 'civitai.red', use: 'post_login' });
    await firstPartyClientForOrigin('https://civitai.red', 'post_login');
    expect(await originCount({ entry: 'civitai.red', use: 'post_login' })).toBe(before + 1);
  });

  it('counts nothing for a refused origin', async () => {
    const before = await originCount({ entry: 'civitai.red' });
    expect(await firstPartyClientForOrigin('http://civitai.red', 'authorize')).toBeUndefined();
    expect(await firstPartyClientForOrigin('https://other.example', 'authorize')).toBeUndefined();
    expect(await originCount({ entry: 'civitai.red' })).toBe(before);
  });

  it('logs only the call site and port for the localhost row', async () => {
    const before = await originCount({ entry: 'localhost', use: 'authorize', scheme: 'http' });
    expect(await firstPartyClientForOrigin('http://localhost:5173', 'authorize')).toBeDefined();
    expect(await originCount({ entry: 'localhost', use: 'authorize', scheme: 'http' })).toBe(
      before + 1
    );
    expect(h.logToAxiom).toHaveBeenCalledTimes(1);
    expect(h.logToAxiom.mock.calls[0][0]).toEqual({
      event: 'first_party_localhost_origin',
      payload: { use: 'authorize', port: '5173' },
    });
  });

  it('logs nothing for any other row', async () => {
    await firstPartyClientForOrigin('https://civitai.red', 'authorize');
    expect(h.logToAxiom).not.toHaveBeenCalled();
  });
});
