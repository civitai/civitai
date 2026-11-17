import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blockImageUpload.generationSourceUsesScannedRows` — which path the host's generation-source
 * upload takes. It answers the SAME flag the generation gate reads
 * (`app-block-source-scanned-rows`), evaluated the same way (global, no entity), so the picker
 * writes a scanned row exactly when the gate would refuse the blob.
 */

const h = vi.hoisted(() => ({ isFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows' },
  isFlipt: (...a: unknown[]) => h.isFlipt(...a),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blockImageUploadRouter } from '../block-image-upload.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function caller(user: { id: number } | null) {
  return blockImageUploadRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

beforeEach(() => {
  h.isFlipt.mockReset();
});

describe('blockImageUpload.generationSourceUsesScannedRows', () => {
  it.each([true, false])('answers the flag as the gate reads it (%s)', async (on) => {
    h.isFlipt.mockResolvedValue(on);
    await expect(caller({ id: 42 }).generationSourceUsesScannedRows()).resolves.toEqual({
      scannedRows: on,
    });
    // The gate's own evaluation: this flag, no entity.
    expect(h.isFlipt.mock.calls).toEqual([['app-block-source-scanned-rows']]);
  });

  it('refuses a signed-out caller without reading the flag', async () => {
    await expect(caller(null).generationSourceUsesScannedRows()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(h.isFlipt).not.toHaveBeenCalled();
  });
});
