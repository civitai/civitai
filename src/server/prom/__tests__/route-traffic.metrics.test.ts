import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';

vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  getAllServerHosts: () => ['civitai.com', 'civitai.green', 'civitai.red'],
}));

import {
  botClassLabel,
  hostLabel,
  PAGE_RENDER_METRIC,
  recordPageRender,
  recordTrpcCall,
  TRPC_CALLS_METRIC,
} from '~/server/prom/route-traffic.metrics';

type Row = { value: number; labels: Record<string, string> };

async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

beforeEach(() => {
  (
    instrumentationRegistry.getSingleMetric(TRPC_CALLS_METRIC) as client.Counter | undefined
  )?.reset();
  (
    instrumentationRegistry.getSingleMetric(PAGE_RENDER_METRIC) as client.Counter | undefined
  )?.reset();
});

describe(TRPC_CALLS_METRIC, () => {
  it('labels a call with its known route pattern and sign-in state', async () => {
    recordTrpcCall({ 'x-page-route': '/models/[id]/[[...slug]]' }, true);
    recordTrpcCall({ 'x-page-route': '/models/[id]/[[...slug]]' }, true);
    recordTrpcCall({ 'x-page-route': '/images' }, false);
    recordTrpcCall(undefined, false);
    expect(await rows(TRPC_CALLS_METRIC)).toEqual(
      expect.arrayContaining([
        { value: 2, labels: { route: '/models/[id]/[[...slug]]', authed: 'true' } },
        { value: 1, labels: { route: '/images', authed: 'false' } },
        { value: 1, labels: { route: 'none', authed: 'false' } },
      ])
    );
    expect(await rows(TRPC_CALLS_METRIC)).toHaveLength(3);
  });

  it('cannot be inflated by a client: 1,000 invented routes make one series', async () => {
    for (let i = 0; i < 1000; i++) recordTrpcCall({ 'x-page-route': `/models/${i}` }, false);
    expect(await rows(TRPC_CALLS_METRIC)).toEqual([
      { value: 1000, labels: { route: 'other', authed: 'false' } },
    ]);
  });
});

describe(PAGE_RENDER_METRIC, () => {
  it('labels a render with route, sign-in state, verified-bot class and configured host', async () => {
    recordPageRender({
      route: '/models/[id]/[[...slug]]',
      authed: false,
      headers: { host: 'civitai.com', 'x-civitai-verified-bot': 'googlebot' },
    });
    recordPageRender({ route: '/', authed: true, headers: { host: 'CIVITAI.GREEN:443' } });
    expect(await rows(PAGE_RENDER_METRIC)).toEqual(
      expect.arrayContaining([
        {
          value: 1,
          labels: {
            route: '/models/[id]/[[...slug]]',
            authed: 'false',
            bot_class: 'googlebot',
            host: 'civitai.com',
          },
        },
        {
          value: 1,
          labels: { route: '/', authed: 'true', bot_class: 'none', host: 'civitai.green' },
        },
      ])
    );
  });

  it('buckets unknown hosts, unknown bot values and unknown routes, so label values stay bounded', async () => {
    for (let i = 0; i < 500; i++) {
      recordPageRender({
        route: `/invented/${i}`,
        authed: false,
        headers: { host: `attacker-${i}.example`, 'x-civitai-verified-bot': `bot-${i}` },
      });
    }
    expect(await rows(PAGE_RENDER_METRIC)).toEqual([
      { value: 500, labels: { route: 'other', authed: 'false', bot_class: 'none', host: 'other' } },
    ]);
  });
});

describe('label helpers', () => {
  it('hostLabel accepts only configured hosts', () => {
    expect(hostLabel('civitai.red')).toBe('civitai.red');
    expect(hostLabel('civitai.com:3000')).toBe('civitai.com');
    expect(hostLabel('evil.civitai.com')).toBe('other');
    expect(hostLabel(undefined)).toBe('other');
  });

  it('botClassLabel only reports the verified-bot classes', () => {
    expect(botClassLabel('bingbot')).toBe('bingbot');
    expect(botClassLabel(['googlebot'])).toBe('googlebot');
    expect(botClassLabel('Googlebot/2.1')).toBe('none');
    expect(botClassLabel(undefined)).toBe('none');
  });
});
