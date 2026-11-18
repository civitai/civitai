import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAGE_RENDER_METRIC,
  recordPageRender,
  recordTrpcCall,
  renderAuthedLabel,
  TRPC_CALLS_METRIC,
} from '~/server/prom/route-traffic.metrics';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

type Row = { value: number; labels: Record<string, string> };

async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

beforeEach(() => {
  usePagesManifestFixture();
  for (const name of [TRPC_CALLS_METRIC, PAGE_RENDER_METRIC]) {
    (instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined)?.reset();
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe(TRPC_CALLS_METRIC, () => {
  it('cannot be inflated by a client: 1,000 invented routes make one series', async () => {
    for (let i = 0; i < 1000; i++) recordTrpcCall({ 'x-page-route': `/models/${i}` }, false);
    expect(await rows(TRPC_CALLS_METRIC)).toEqual([
      { value: 1000, labels: { route: 'other', authed: 'false' } },
    ]);
  });
});

describe(PAGE_RENDER_METRIC, () => {
  it('buckets unknown routes and bot values, so label values stay bounded', async () => {
    for (let i = 0; i < 500; i++) {
      recordPageRender(`/invented/${i}`, {
        headers: { host: `h-${i}.example`, 'x-civitai-verified-bot': `bot-${i}` },
      });
    }
    expect(await rows(PAGE_RENDER_METRIC)).toEqual([
      { value: 500, labels: { route: 'other', authed: 'false', bot_class: 'none' } },
    ]);
  });
});

describe('label helpers', () => {
  it('renderAuthedLabel reports an unresolved session as unknown, never as anonymous', () => {
    expect(renderAuthedLabel({ headers: {}, session: { user: { id: 1 } } })).toBe('true');
    expect(renderAuthedLabel({ headers: {} })).toBe('false');
    expect(renderAuthedLabel({ headers: {}, session: null })).toBe('false');
    expect(renderAuthedLabel({ headers: {}, sessionUnresolved: true })).toBe('unknown');
    expect(renderAuthedLabel({ headers: {}, sessionUnresolved: false })).toBe('false');
  });
});
