import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * 🔴 THE SEAM: does serving a scrape actually publish the App Blocks storage series?
 *
 * `seedAppBlockStorageMetrics` is inert on its own and has exactly ONE caller — the
 * `/api/metrics` handler. Deleting that call restores the defect this PR exists to fix (two of
 * the four counters go back to ABSENT in production) while `app-block-storage.metrics.test.ts`
 * stays entirely green, because that file calls the seeder itself. Two components, each fine
 * alone, broken together.
 *
 * Same pattern as `src/server/metrics/__tests__/metrics-endpoint-seeds-substitutions.test.ts`,
 * with one difference that is the whole reason this file is not a copy: the seeding is awaited
 * INSIDE the handler, not at module scope, so loading the page module is not enough — the
 * handler has to be invoked. Control 2 below is what pins that distinction.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper so the
// default export is the bare handler and none of that graph is needed.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const OPS = 'civitai_app_block_storage_ops_total';
const QUOTA_EXCEEDED = 'civitai_app_block_storage_quota_exceeded_total';
const USER_QUOTA_UNTRACKED = 'civitai_app_block_storage_user_quota_untracked_total';
const LATENCY = 'civitai_app_block_storage_latency_seconds';

async function seriesCount(name: string): Promise<number> {
  const metric = client.register.getSingleMetric(name) as
    | { get(): Promise<{ values: unknown[] }> | { values: unknown[] } }
    | undefined;
  if (!metric) return -1;
  const { values } = await metric.get();
  return values.length;
}

describe('/api/metrics publishes the App Blocks storage series', () => {
  it('CONTROL 1: the metrics are not even registered before the page module loads', () => {
    expect(client.register.getSingleMetric(OPS)).toBeUndefined();
    expect(client.register.getSingleMetric(QUOTA_EXCEEDED)).toBeUndefined();
    expect(client.register.getSingleMetric(USER_QUOTA_UNTRACKED)).toBeUndefined();
    expect(client.register.getSingleMetric(LATENCY)).toBeUndefined();
  });

  it('CONTROL 2: loading the module registers them but publishes NO series', async () => {
    await import('~/pages/api/metrics');

    // Registered (so the names resolve) and empty (so the next case is measuring the handler
    // call, not module evaluation). This is what fails if the seeding is moved back to module
    // scope without this file being updated.
    expect(await seriesCount(OPS)).toBe(0);
    expect(await seriesCount(QUOTA_EXCEEDED)).toBe(0);
    expect(await seriesCount(USER_QUOTA_UNTRACKED)).toBe(0);
    expect(await seriesCount(LATENCY)).toBe(0);
  });

  it('🔴 serving one scrape publishes all 90 of them', async () => {
    const mod = await import('~/pages/api/metrics');
    const handler = mod.default as unknown as (
      req: unknown,
      res: {
        setHeader: (k: string, v: string) => void;
        send: (body: string) => void;
      }
    ) => Promise<void>;

    let body = '';
    await handler({}, { setHeader: () => undefined, send: (b: string) => (body = b) });

    expect(await seriesCount(OPS)).toBe(22);
    expect(await seriesCount(QUOTA_EXCEEDED)).toBe(2);
    expect(await seriesCount(USER_QUOTA_UNTRACKED)).toBe(1);
    expect(await seriesCount(LATENCY)).toBe(65);

    // …and they reach the scrape BODY, not just the registry. The response is what Prometheus
    // reads; a series present in the registry but dropped from the response is still absent.
    expect(body).toContain(`${OPS}{op="set",outcome="quota_exceeded"} 0`);
    expect(body).toContain(`${QUOTA_EXCEEDED}{ceiling="user"} 0`);
    expect(body).toContain(`${USER_QUOTA_UNTRACKED} 0`);
    expect(body).toContain(`${LATENCY}_count{op="list"} 0`);
  });
});
