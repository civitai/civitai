import { describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the store makes one vanilla query, and the stub must see its input
  trpcVanilla: { generation: { getResourceDataByIds: { query } } },
}));

import { requestResourceIds } from '~/store/resource-data.store';

describe('requestResourceIds', () => {
  // The form drops `canGenerate: false` resources at submit, so its read has to carry the same
  // boost-to-load opt-in as the whatIf, or a free account's boosted checkpoint never reaches the submit.
  it('asks with the boost-to-load opt-in', () => {
    requestResourceIds([101]);
    expect(query).toHaveBeenCalledWith({ ids: [101], acceptBoostRequired: true });
  });
});
