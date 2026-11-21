import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

// setup.ts stubs this module wholesale; the bridge publish only happens in the real one.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
}));

async function loadBridge(): Promise<Record<string, unknown>> {
  await import('~/server/prom/client');
  return (globalThis as unknown as { __civitaiRedisMetrics: Record<string, unknown> })
    .__civitaiRedisMetrics;
}

describe('the redis metrics bridge this app publishes on globalThis', () => {
  it('the published per-command handles write to the scraped inflight gauge and duration histogram', async () => {
    const bridge = await loadBridge();
    const inflight = bridge.redisCommandsInflight as {
      inc: (labels: { client: string }) => void;
      dec: (labels: { client: string }) => void;
    };
    const duration = bridge.redisCommandDuration as {
      observe: (labels: { client: string }, value: number) => void;
    };
    const probe = 'bridge-seam-probe';

    inflight.inc({ client: probe });
    inflight.inc({ client: probe });
    inflight.dec({ client: probe });
    duration.observe({ client: probe }, 0.0125);

    const after = await client.register.metrics();
    expect(after).toContain(`civitai_app_redis_commands_inflight{client="${probe}"} 1`);
    expect(after).toContain(
      `civitai_app_redis_command_duration_seconds_count{client="${probe}"} 1`
    );
  });
});
