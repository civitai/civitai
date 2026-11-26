import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blockImageUpload.generationSourceUsesScannedRows` — which path the host's generation-source
 * upload takes. It answers the SAME flag the generation gate reads
 * (`app-block-source-scanned-rows`), evaluated the same way (per app: entityId = the block
 * token's `appBlockId`, no context), so the picker writes a scanned row exactly when the gate
 * would refuse the blob for that app.
 */

const APP_ON = 'apb_on';
const APP_OFF = 'apb_off';

const h = vi.hoisted(() => ({ isFlipt: vi.fn(), authorize: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows' },
  isFlipt: async (...a: unknown[]) => h.isFlipt(...a),
  isFliptSync: (...a: unknown[]) => h.isFlipt(...a),
  readFliptBoolean: async (...a: unknown[]) => h.isFlipt(...a),
  ensureFliptInitialized: async () => undefined,
}));
vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
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
  h.authorize.mockReset();
  // A per-app rollout: ON for one app only, as an ENTITY_ID segment would answer.
  h.isFlipt.mockImplementation(
    (flag: string, entityId?: string) =>
      flag === 'app-block-source-scanned-rows' && entityId === APP_ON
  );
  h.authorize.mockImplementation(async (token: string) => ({
    appBlockId: token === 'tok_on' ? APP_ON : APP_OFF,
  }));
});

describe('blockImageUpload.generationSourceUsesScannedRows', () => {
  it.each([
    ['tok_on', APP_ON, true],
    ['tok_off', APP_OFF, false],
  ])(
    '🔴 answers the flag for the token’s app (%s → %s → %s)',
    async (blockToken, appBlockId, on) => {
      await expect(
        caller({ id: 42 }).generationSourceUsesScannedRows({ blockToken })
      ).resolves.toEqual({ scannedRows: on });
      expect(h.authorize.mock.calls).toEqual([[blockToken]]);
      // The gate's own evaluation: this flag, entity = the app block id, no context.
      expect(h.isFlipt.mock.calls).toEqual([['app-block-source-scanned-rows', appBlockId]]);
    }
  );

  it('a token the bridge guard refuses answers as that refusal, without reading the flag', async () => {
    h.authorize.mockRejectedValue(
      Object.assign(new Error('block instance revoked'), { code: 'FORBIDDEN' })
    );
    await expect(
      caller({ id: 42 }).generationSourceUsesScannedRows({ blockToken: 'tok_on' })
    ).rejects.toMatchObject({ message: 'block instance revoked' });
    expect(h.isFlipt).not.toHaveBeenCalled();
  });

  it('rejects a missing block token at the schema', async () => {
    await expect(
      caller({ id: 42 }).generationSourceUsesScannedRows({ blockToken: '' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.isFlipt).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller without reading the flag', async () => {
    await expect(
      caller(null).generationSourceUsesScannedRows({ blockToken: 'tok_on' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.isFlipt).not.toHaveBeenCalled();
  });
});
