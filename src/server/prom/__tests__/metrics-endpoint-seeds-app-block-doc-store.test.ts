import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * 🔴 THE SEAM: does serving a scrape publish the document store's series?
 *
 * `seedAppBlockDocStoreMetrics` and `refreshDocStoreEnabled` are inert on their own and their
 * only production caller is the `/api/metrics` handler. Deleting either call leaves
 * `app-block-doc-store.metrics.test.ts` green (it calls them itself) while the review counters go
 * back to ABSENT and the enabled gauge stops tracking the store. Same pattern as
 * `metrics-endpoint-seeds-app-block-storage.test.ts`.
 *
 * The store here has a connection whose role is confirmed, so the gauge must read 1: a 0 could
 * equally be the registry default, which proves nothing about the handler.
 */

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/db/appdataDb', () => ({
  appdataDb: {
    connect: async () => ({
      query: async () => ({
        rows: [{ rolname: 'r', rolsuper: false, rolbypassrls: false }],
        rowCount: 1,
      }),
      release: () => undefined,
    }),
  },
}));

describe('/api/metrics publishes the document-store series', () => {
  it('🔴 one scrape publishes the seeded counters and the evaluated enabled gauge', async () => {
    const mod = await import('~/pages/api/metrics');
    const handler = mod.default as unknown as (
      req: unknown,
      res: { setHeader: (k: string, v: string) => void; send: (body: string) => void }
    ) => Promise<void>;

    let body = '';
    await handler({}, { setHeader: () => undefined, send: (b: string) => (body = b) });

    expect(body).toContain('civitai_app_block_review_storage_cleanup_total{outcome="failed"} 0');
    expect(body).toContain('civitai_app_block_review_storage_cleanup_total{outcome="purged"} 0');
    expect(body).toContain('civitai_app_block_review_storage_sweep_total{outcome="failed"} 0');
    expect(body).toContain(
      'civitai_app_block_doc_store_errors_total{endpoint="storage_read",code="storage_disabled"} 0'
    );
    expect(body).toMatch(/^civitai_app_block_doc_store_enabled 1$/m);
  });
});
