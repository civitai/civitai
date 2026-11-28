import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * `seedAppBlockStorageMetrics` is inert on its own and its only caller is the `/api/metrics`
 * handler, which awaits it per scrape: without that call two of the counters are ABSENT in
 * production while `app-block-storage.metrics.test.ts` (which calls the seeder itself) stays green.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper so the
// default export is the bare handler and none of that graph is needed.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ProbeEndpoint: (handler: unknown) => handler,
}));

const OPS = 'civitai_app_block_storage_ops_total';
const QUOTA_EXCEEDED = 'civitai_app_block_storage_quota_exceeded_total';
const USER_QUOTA_UNTRACKED = 'civitai_app_block_storage_user_quota_untracked_total';
const LATENCY = 'civitai_app_block_storage_latency_seconds';
const SHARED_OPS = 'civitai_app_block_shared_storage_ops_total';
const SHARED_LATENCY = 'civitai_app_block_shared_storage_latency_seconds';

async function scrape(): Promise<string> {
  const mod = await import('~/pages/api/metrics');
  const handler = mod.default as unknown as (
    req: unknown,
    res: { setHeader: (k: string, v: string) => void; send: (body: string) => void }
  ) => Promise<void>;
  let body = '';
  await handler({}, { setHeader: () => undefined, send: (b: string) => (body = b) });
  return body;
}

describe('/api/metrics publishes the App Blocks storage series', () => {
  it('🔴 serving one scrape publishes them at 0', async () => {
    // The response is what Prometheus reads; a series present in the registry but dropped from
    // the response is still absent.
    const body = await scrape();
    expect(body).toContain(`${OPS}{op="set",outcome="quota_exceeded"} 0`);
    expect(body).toContain(`${QUOTA_EXCEEDED}{ceiling="user"} 0`);
    expect(body).toContain(`${USER_QUOTA_UNTRACKED} 0`);
    expect(body).toContain(`${LATENCY}_count{op="list"} 0`);
  });

  it('🔴 the same scrape publishes the shared storage series at 0', async () => {
    const body = await scrape();
    expect(body).toContain(`${SHARED_OPS}{op="increment",outcome="moderation_unavailable"} 0`);
    expect(body).toContain(`${SHARED_LATENCY}_count{op="getTop"} 0`);
  });
});
