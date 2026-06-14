import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 4 — dedicated RUNTIME token-verification flag.
 *
 * `isAppBlocksRuntimeEnabled()` is the global (no-user) gate the RUNTIME
 * token-verification sites — the JWKS public-key endpoint and the
 * `withBlockScope` middleware — use to decide whether to verify already-minted
 * block JWTs for deployed blocks. It MUST:
 *   - evaluate the `app-blocks-runtime-enabled` flag key (NOT the user-facing
 *     `app-blocks-enabled` flag, and NOT the build `app-blocks-pipeline-enabled`
 *     flag) — proving runtime verification is decoupled from BOTH the
 *     mod-segmented user feature and the build pipeline;
 *   - eval GLOBALLY (no user context), mirroring how the runtime sites have
 *     always called Flipt;
 *   - be FAIL-SAFE: when the runtime flag is absent / off (the as-merged state,
 *     since the flag is created in Flipt only AFTER this lands) it resolves
 *     `false` → the runtime sites stay dark.
 *
 * `isFlipt` is mocked PER-KEY so the assertions can prove the helper reads the
 * runtime key and ignores the user / pipeline flags' state.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
}));

import {
  isAppBlocksRuntimeEnabled,
  isAppBlocksEnabled,
  APP_BLOCKS_RUNTIME_FLAG,
  APP_BLOCKS_PIPELINE_FLAG,
} from '../app-blocks-flag';

// Per-key Flipt stand-in. Only `app-blocks-runtime-enabled` can turn runtime
// verification on; neither the user flag nor the pipeline flag being on may
// leak in.
function perKeyFlipt(state: { runtime: boolean; pipeline: boolean; user: boolean }) {
  return async (flag: string): Promise<boolean> => {
    if (flag === 'app-blocks-runtime-enabled') return state.runtime;
    if (flag === 'app-blocks-pipeline-enabled') return state.pipeline;
    if (flag === 'app-blocks-enabled') return state.user;
    return false; // unknown / absent flag → false (matches real isFlipt)
  };
}

beforeEach(() => {
  mockIsFlipt.mockReset();
});

describe('isAppBlocksRuntimeEnabled — Decision 4 runtime gate', () => {
  it('exports the dedicated runtime flag key', () => {
    expect(APP_BLOCKS_RUNTIME_FLAG).toBe('app-blocks-runtime-enabled');
  });

  it('reads the runtime flag key with a GLOBAL eval (no user context)', async () => {
    mockIsFlipt.mockImplementation(perKeyFlipt({ runtime: true, pipeline: false, user: false }));
    await expect(isAppBlocksRuntimeEnabled()).resolves.toBe(true);
    // Only the flag key — entityId + context fall back to client.ts globals.
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    // It must NEVER read the user-facing flag…
    expect(mockIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
    // …nor the build pipeline flag.
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-pipeline-enabled');
  });

  it('stays OFF when ONLY the user-facing flag is on (decoupled — no leak)', async () => {
    mockIsFlipt.mockImplementation(perKeyFlipt({ runtime: false, pipeline: false, user: true }));
    await expect(isAppBlocksRuntimeEnabled()).resolves.toBe(false);
  });

  it('stays OFF when ONLY the build pipeline flag is on (decoupled — pausing builds keeps runtime independent)', async () => {
    // The key invariant: flipping the pipeline flag must not move runtime
    // verification. Runtime off + pipeline on → runtime gate still refuses.
    mockIsFlipt.mockImplementation(perKeyFlipt({ runtime: false, pipeline: true, user: false }));
    await expect(isAppBlocksRuntimeEnabled()).resolves.toBe(false);
  });

  it('FAIL-SAFE: resolves false when the runtime flag is absent (isFlipt → false)', async () => {
    // Simulate a missing flag / unreachable Flipt: isFlipt returns false.
    mockIsFlipt.mockResolvedValue(false);
    await expect(isAppBlocksRuntimeEnabled()).resolves.toBe(false);
  });
});

describe('no accidental widening of the USER-facing gate (Decision 4 regression)', () => {
  // The user-facing gate (`isAppBlocksEnabled`) MUST keep reading
  // 'app-blocks-enabled'. Decision 4 only repoints the RUNTIME sites onto
  // 'app-blocks-runtime-enabled'; it must NOT move the user visibility gate
  // (which would widen the feature to whatever the global runtime flag is set
  // to). Drive the no-arg user-gate path (which needs only isFlipt — no
  // buildFliptContext) and assert the literal key it reads.
  it("isAppBlocksEnabled still reads 'app-blocks-enabled', never the runtime/pipeline keys", async () => {
    mockIsFlipt.mockImplementation(perKeyFlipt({ runtime: true, pipeline: true, user: false }));
    // The user gate must NOT pick up the runtime/pipeline flags being on.
    await expect(isAppBlocksEnabled()).resolves.toBe(false);
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-pipeline-enabled');
  });

  it('the three flag keys are distinct constants (no aliasing)', () => {
    const keys = new Set([
      'app-blocks-enabled', // APP_BLOCKS_FLAG (module-local; the user key)
      APP_BLOCKS_PIPELINE_FLAG,
      APP_BLOCKS_RUNTIME_FLAG,
    ]);
    expect(keys.size).toBe(3);
    expect(APP_BLOCKS_RUNTIME_FLAG).toBe('app-blocks-runtime-enabled');
    expect(APP_BLOCKS_PIPELINE_FLAG).toBe('app-blocks-pipeline-enabled');
  });
});
