import { afterEach, describe, expect, it, vi } from 'vitest';
import client from 'prom-client';

// The parity gauge end to end through the real package probe: only the hub (fetch) is faked. The app's own
// credential is fixed, so a mismatch is modelled by the hub expecting a different one.
vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.AUTH_INTERNAL_TOKEN = 'app-secret';
});

import { probeInternalParity } from '@civitai/auth';
import { createInternalParityGauge } from '../auth-internal-parity.metrics';

function hubExpecting(secret: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      const status = init.headers.authorization === `Bearer ${secret}` ? 204 : 401;
      return new Response(null, { status });
    })
  );
}

async function scrape(registry: client.Registry) {
  const [metric] = await registry.getMetricsAsJSON();
  return metric.values.map((v) => ({ app: v.labels.app, value: v.value }));
}

afterEach(() => vi.unstubAllGlobals());

describe('auth_internal_parity', () => {
  it('is 1 when the hub accepts the credential', async () => {
    hubExpecting('app-secret');
    const registry = new client.Registry();
    const { refresh } = createInternalParityGauge(probeInternalParity, registry);
    await refresh();
    expect(await scrape(registry)).toEqual([{ app: 'main', value: 1 }]);
  });

  it('is 0 when the hub holds a different credential', async () => {
    hubExpecting('rotated-on-the-hub-only');
    const registry = new client.Registry();
    const { refresh } = createInternalParityGauge(probeInternalParity, registry);
    await refresh();
    expect(await scrape(registry)).toEqual([{ app: 'main', value: 0 }]);
  });

  it('is absent, not 0, while the hub gives no answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    const registry = new client.Registry();
    const { refresh } = createInternalParityGauge(probeInternalParity, registry);
    await refresh();
    expect(await scrape(registry)).toEqual([]);
  });
});
