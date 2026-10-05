import { describe, expect, it } from 'vitest';
import client from 'prom-client';
import { recordDevTunnelDnsGc } from '~/server/prom/dev-tunnel.metrics';

// Real-registry check: the service tests mock this module, so only this file proves
// the counter is registered under the exact scraped name (prefix applied once) and
// keyed by the `outcome` label.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

async function countFor(outcome: string): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_dev_tunnel_dns_gc_total') as
    | { get: () => Promise<MetricJSON> }
    | undefined;
  if (!metric) throw new Error('civitai_app_dev_tunnel_dns_gc_total is not registered');
  const data = await metric.get();
  return data.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

describe('civitai_app_dev_tunnel_dns_gc_total', () => {
  it('counts each outcome under its own label value', async () => {
    const before = {
      deleted: await countFor('deleted'),
      failed: await countFor('failed'),
      none_found: await countFor('none_found'),
    };
    recordDevTunnelDnsGc('deleted');
    recordDevTunnelDnsGc('failed');
    recordDevTunnelDnsGc('failed');
    expect(await countFor('deleted')).toBe(before.deleted + 1);
    expect(await countFor('failed')).toBe(before.failed + 2);
    expect(await countFor('none_found')).toBe(before.none_found);
  });
});
