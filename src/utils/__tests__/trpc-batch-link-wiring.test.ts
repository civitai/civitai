import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as TrpcClientModule from '@trpc/client';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';

/**
 * BEHAVIOURAL coverage for the options `src/utils/trpc.ts` hands the batch link.
 *
 * 🔴 WHY THIS FILE EXISTS. `maxItems: TRPC_MAX_BATCH_SIZE` used to be pinned by a regex over
 * `src/utils/trpc.ts`'s source. Wrapping that line in a block comment left the regex satisfied
 * and the suite green while the browser's item cap was gone — the client half of the same
 * walkable-guard class as `trpc-handler-wiring.test.ts`.
 *
 * Instead of reading the file, this spies on `httpBatchStreamLink` and reads the options object
 * the module ACTUALLY constructed. `~/utils/trpc` builds `trpcVanilla` at module scope, which
 * calls `terminatingLink` eagerly — so simply importing the module exercises the real call site.
 * The spy delegates to the real link, so nothing about the module's behaviour is faked.
 */

const h = vi.hoisted(() => ({ batchLinkOptions: [] as Record<string, unknown>[] }));

vi.mock('@trpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcClientModule>();
  return {
    ...actual,
    httpBatchStreamLink: (options: Record<string, unknown>) => {
      h.batchLinkOptions.push(options);
      return actual.httpBatchStreamLink(options as never);
    },
  };
});

describe('the browser batch link is built with the shared item cap', () => {
  beforeAll(async () => {
    await import('~/utils/trpc');
  });

  it('POSITIVE CONTROL: importing the module builds a batch link at all', () => {
    // A zero here would make every assertion below vacuously true — "no options recorded" and
    // "options recorded without maxItems" are indistinguishable otherwise.
    expect(h.batchLinkOptions.length).toBeGreaterThan(0);
  });

  it('passes maxItems from the shared constant, not a literal', () => {
    for (const options of h.batchLinkOptions) {
      expect(options.maxItems).toBe(TRPC_MAX_BATCH_SIZE);
    }
  });

  it('keeps the pre-existing URL budget, which is what actually binds today', () => {
    // `maxURLLength` is the bound that splits the app's real fan-out shapes (22-29 ops), below
    // `maxItems`. Losing it would move first-party safety onto the item cap alone, so it is
    // asserted here rather than left implicit — and it must not silently change with the cap.
    for (const options of h.batchLinkOptions) {
      expect(options.maxURLLength).toBe(2083);
    }
  });
});
